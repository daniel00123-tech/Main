import {
  ELVEX_INFO_MAILBOXES,
  actionForProtectedCapability,
  isElvexCompany,
  resolveElvexConfiguredMailbox,
  type StructuredCapabilityDenial,
  type ToolAction,
} from "@infra/shared";
import {
  evaluateKnowledgeBusinessSystemPreflight,
  mapExecutionOutcome,
  resolveProtectedCapability,
  structuredPermissionDenial,
  xeroResultLooksEmpty,
} from "./capability-access";
import type { Env } from "../env";
import type { SessionUser } from "../auth/session";
import { liveActorToSessionUser, loadLiveCompanyActor } from "../auth/live-identity";
import {
  isAccessJtiRevoked,
  isInfraServiceToken,
  looksLikeJwt,
  touchAiUserConnection,
  verifyMcpAccessToken,
} from "../auth/mcp-oauth";
import {
  normalizeSourceClient,
  resolveConnectorInstanceId,
} from "./usage-attribution";
import { newId, nowIso } from "../db/mappers";
import {
  executeRegisteredMcpTool,
  ensureDefaultToolAllowlist,
  getMcpEnvironment,
  listMcpEnvironments,
  recordAuditEvent,
} from "./control-plane";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
import { maybeTriggerAutoTopUp } from "./auto-topup";
import { maybeNotifyWalletHealth } from "./wallet-health";
import {
  allocateDebitCreditClasses,
  consumePromotionalGrants,
} from "./promotional-grants";
import {
  calculateChargeCents,
  resolvePricingPolicy,
  resolvePricingRule,
} from "./pricing";
import {
  markUsageSettled,
  recordUsageEvent,
} from "./usage";
import {
  authenticateServiceToken,
  evaluateServiceActionPermission,
  type ServiceIdentityRecord,
} from "./service-identities";
import {
  evaluateActionPermission,
  userHasCompanyAccess,
} from "../permissions/service";
import { decideTestBilling } from "./billing-policy";
import {
  labelForOperation,
  persistInteraction,
  refreshInteractionTotals,
  resolveInteractionIds,
} from "./interactions";
import { sanitizeCustomerError } from "./secrets";
import { scheduleQualityAudit } from "./quality-auditor";
import {
  isXeroToolName,
  isXeroWriteToolName,
  prepareXeroMcpExecution,
  xeroActionForTool,
} from "./xero-tools";
import { executeXeroReadToolOnInfra } from "./xero-read-execution";
import { isOutlookReadTool, outlookActionForTool } from "./microsoft-outlook-tools";
import { executeOutlookReadTool } from "./microsoft-outlook-read";

export type GatewayActor =
  | {
      type: "user";
      user: SessionUser;
      boundCompanyId?: string;
      membershipId?: string;
      channel?: string;
    }
  | { type: "service"; identity: ServiceIdentityRecord };

async function resolveToolAction(
  db: D1Database,
  mcpEnvironmentId: string,
  toolName: string,
): Promise<{ action: string; riskClass: string }> {
  const mapped = await db
    .prepare(
      `SELECT action, risk_class FROM mcp_tool_action_map
       WHERE mcp_environment_id = ? AND tool_name = ?`,
    )
    .bind(mcpEnvironmentId, toolName)
    .first();

  if (mapped) {
    return {
      action: String(mapped.action),
      riskClass: String(mapped.risk_class ?? "low_risk"),
    };
  }

  if (toolName === "search_company_knowledge" || toolName === "search") {
    return { action: "knowledge.search", riskClass: "low_risk" };
  }
  if (
    toolName === "get_knowledge_document" ||
    toolName === "fetch" ||
    toolName === "database_summary"
  ) {
    return { action: "knowledge.read", riskClass: "low_risk" };
  }
  if (toolName === "system_health") {
    return { action: "system.health", riskClass: "low_risk" };
  }
  if (
    toolName === "automation_list" ||
    toolName === "automation_get" ||
    toolName === "automation_get_run"
  ) {
    return { action: "automation.read", riskClass: "low_risk" };
  }
  if (toolName.startsWith("automation_")) {
    return { action: "automation.manage", riskClass: "high_risk" };
  }

  const xero = xeroActionForTool(toolName);
  if (xero) return xero;

  const outlook = outlookActionForTool(toolName);
  if (outlook) return { action: outlook, riskClass: "low_risk" };

  return { action: `mcp.${toolName}`, riskClass: "high_risk" };
}

async function pickCompanyMcp(
  db: D1Database,
  companyId: string,
  mcpEnvironmentId?: string | null,
) {
  if (mcpEnvironmentId) {
    const mcp = await getMcpEnvironment(db, mcpEnvironmentId);
    if (!mcp || mcp.companyId !== companyId) return null;
    return mcp;
  }
  const list = await listMcpEnvironments(db, companyId);
  return list.find((item) => item.enabled) ?? list[0] ?? null;
}

const HUMAN_AI_IDENTITY_TYPES = new Set(["chatgpt", "claude"]);

/** ChatGPT / OpenAI MCP clients must never be treated as machine service callers. */
export function looksLikeChatgptHumanClient(request: Request): boolean {
  const ua = (request.headers.get("User-Agent") ?? "").toLowerCase();
  const origin = (request.headers.get("Origin") ?? "").toLowerCase();
  return (
    /chatgpt|openai|gptbot|oai-mcp|chatgpt-mcp/.test(ua) ||
    origin.includes("chatgpt.com") ||
    origin.includes("chat.openai.com")
  );
}

export async function resolveGatewayActor(
  env: Env,
  request: Request,
  sessionUser: SessionUser | null,
  options?: { mcpFacade?: boolean },
): Promise<GatewayActor | { error: string; status: 401 | 403 }> {
  const token = extractServiceCredential(request);
  if (token) {
    if (looksLikeJwt(token) && !isInfraServiceToken(token)) {
      const claims = await verifyMcpAccessToken(token, env.SESSION_SECRET);
      if (!claims) {
        return { error: "Invalid or expired INFRA user credential", status: 401 };
      }
      if (await isAccessJtiRevoked(env.DB, claims.jti)) {
        return { error: "INFRA user credential has been revoked", status: 401 };
      }
      const live = await loadLiveCompanyActor(env.DB, claims.sub, claims.company_id);
      if (!live) {
        return { error: "Unknown or deleted company user", status: 403 };
      }
      if (!live.active) {
        return { error: live.denyReason ?? "User is disabled", status: 403 };
      }
      if (live.membershipId !== claims.membership_id && claims.membership_id) {
        // Membership id is a bind hint only; live row is authoritative.
      }
      return {
        type: "user",
        user: liveActorToSessionUser(live),
        boundCompanyId: live.companyId,
        membershipId: live.membershipId,
        channel: claims.channel || "chatgpt",
      };
    }

    const identity = await authenticateServiceToken(env.DB, token);
    if (!identity) {
      return { error: "Invalid or revoked service token", status: 401 };
    }
    if (identity.status !== "active") {
      return { error: "Service identity is disabled", status: 403 };
    }
    const humanAiIdentity = HUMAN_AI_IDENTITY_TYPES.has(identity.identityType);
    if (options?.mcpFacade && (humanAiIdentity || looksLikeChatgptHumanClient(request))) {
      return {
        error:
          "Human ChatGPT connections must use INFRA OAuth. A company service token is not a user login.",
        status: 401,
      };
    }
    return { type: "service", identity };
  }

  if (options?.mcpFacade) {
    return { error: "Authentication required", status: 401 };
  }

  if (sessionUser) {
    return { type: "user", user: sessionUser, channel: "portal" };
  }

  return { error: "Authentication required", status: 401 };
}

/**
 * ChatGPT "Access token / API key" connectors may send the INFRA token as
 * Authorization: Bearer <token> OR as an API-key style header. Same credential,
 * same validation — not an auth bypass.
 */
export function extractServiceCredential(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  for (const name of ["X-Api-Key", "Api-Key", "X-Infra-Service-Token"]) {
    const raw = request.headers.get(name)?.trim();
    if (!raw) continue;
    if (raw.toLowerCase().startsWith("bearer ")) {
      const stripped = raw.slice(7).trim();
      if (stripped) return stripped;
      continue;
    }
    return raw;
  }

  return null;
}

async function findIdempotentGateway(
  db: D1Database,
  companyId: string,
  clientRequestId: string,
) {
  return db
    .prepare(
      `SELECT * FROM gateway_requests
       WHERE company_id = ? AND client_request_id = ?
       LIMIT 1`,
    )
    .bind(companyId, clientRequestId)
    .first();
}

export async function executeGatewayRequest(
  env: Env,
  input: {
    actor: GatewayActor;
    companyId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    mcpEnvironmentId?: string | null;
    sourceClient?: string | null;
    requireCredit?: boolean;
    clientRequestId?: string | null;
    interactionId?: string | null;
    parentRequestId?: string | null;
    mcpSessionId?: string | null;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
) {
  const correlationId = newId("corr");
  const requestId = input.clientRequestId?.trim()
    ? `req_${input.clientRequestId.trim()}`
    : newId("req");
  const clientRequestId = input.clientRequestId?.trim() || null;
  const interaction = resolveInteractionIds({
    headerInteractionId: input.interactionId,
    parentRequestId: input.parentRequestId,
    mcpSessionId: input.mcpSessionId,
  });
  const started = Date.now();
  const gatewayRequestId = newId("gw");

  const actorLabel =
    input.actor.type === "user"
      ? input.actor.user.email
      : input.actor.identity.name;
  const actorId =
    input.actor.type === "user"
      ? input.actor.user.userId
      : input.actor.identity.id;
  const sourceClient = normalizeSourceClient(
    input.sourceClient ??
      (input.actor.type === "service"
        ? input.actor.identity.identityType
        : input.actor.channel ?? "infra-gateway"),
    input.actor.type === "user" ? "portal" : "service",
  );

  const humanServiceMasquerade =
    input.actor.type === "service" &&
    HUMAN_AI_IDENTITY_TYPES.has(input.actor.identity.identityType);
  if (
    humanServiceMasquerade ||
    ((sourceClient === "chatgpt" || sourceClient === "claude") &&
      (input.actor.type !== "user" || !input.actor.user.userId))
  ) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "permission.denied",
      actor: actorLabel,
      resourceType: "gateway",
      resourceId: input.toolName,
      detail: {
        stage: "mcp_facade.auth_failed",
        billingStatus: "AUTH_DENIED",
        correlationId,
        requestId,
        sourceClient,
        actorType: input.actor.type,
        reason: "human_oauth_required",
      },
    });
    return {
      status: 401 as const,
      error:
        "Human ChatGPT connections must use INFRA OAuth. A company service token is not a user login.",
      correlationId,
      requestId,
    };
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "company.accessed",
    actor: actorLabel,
    resourceType: "gateway",
    resourceId: input.toolName,
    detail: {
      stage: "gateway.request_received",
      correlationId,
      requestId,
      clientRequestId,
      sourceClient,
    },
  });

  // Idempotency: identical client request returns prior settled outcome
  if (clientRequestId) {
    const prior = await findIdempotentGateway(
      env.DB,
      input.companyId,
      clientRequestId,
    );
    if (prior) {
      return {
        status: Number(prior.http_status ?? 200) as 200 | 402 | 403 | 404 | 500,
        correlationId: String(prior.correlation_id),
        gatewayRequestId: String(prior.id),
        requestId: prior.request_id ? String(prior.request_id) : requestId,
        idempotentReplay: true,
        companyId: input.companyId,
        mcpId: prior.mcp_environment_id
          ? String(prior.mcp_environment_id)
          : null,
        toolName: String(prior.tool_name),
        action: prior.action ? String(prior.action) : undefined,
        riskClass: prior.risk_class ? String(prior.risk_class) : undefined,
        latencyMs: prior.latency_ms == null ? undefined : Number(prior.latency_ms),
        charge: {
          billable: Boolean(prior.ledger_entry_id),
          customerChargeCents: null,
          isTestConfig: true,
          pricingLabel: "idempotent_replay",
        },
        result: undefined,
        error:
          prior.status === "succeeded"
            ? undefined
            : String(prior.error_message ?? prior.status),
      };
    }
  }

  // Tenant isolation
  if (input.actor.type === "user") {
    if (!userHasCompanyAccess(input.actor.user, input.companyId)) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "gateway",
        resourceId: input.toolName,
        detail: { correlationId, requestId, reason: "cross_company" },
      });
      return {
        status: 403 as const,
        error: "Access to this company is denied",
        correlationId,
        requestId,
      };
    }
  } else if (input.actor.identity.companyId !== input.companyId) {
    await recordAuditEvent(env.DB, {
      companyId: input.actor.identity.companyId,
      eventType: "permission.denied",
      actor: actorLabel,
      resourceType: "gateway",
      resourceId: input.toolName,
      detail: {
        correlationId,
        requestId,
        reason: "service_tenant_spoof",
        attemptedCompanyId: input.companyId,
      },
    });
    return {
      status: 403 as const,
      error: "Service identity does not belong to this company",
      correlationId,
      requestId,
    };
  }

  const { assertCompanyAcceptsGateway } = await import("./tenant-provisioning");
  const lifecycle = await assertCompanyAcceptsGateway(env.DB, input.companyId);
  if (!lifecycle.ok) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "permission.denied",
      actor: actorLabel,
      resourceType: "gateway",
      resourceId: input.toolName,
      detail: {
        correlationId,
        requestId,
        reason: "company_lifecycle_blocked",
        error: lifecycle.error,
      },
    });
    return {
      status: 403 as const,
      error: lifecycle.error,
      correlationId,
      requestId,
    };
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "company.accessed",
    actor: actorLabel,
    resourceType: "gateway",
    resourceId: input.toolName,
    detail: { stage: "gateway.authenticated", correlationId, requestId },
  });

  if (isXeroToolName(input.toolName)) {
    if (isXeroWriteToolName(input.toolName)) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "gateway",
        resourceId: input.toolName,
        detail: {
          correlationId,
          requestId,
          reason: "action_engine_required",
          toolName: input.toolName,
        },
      });
      return {
        status: 403 as const,
        error: "Financial writes must use the INFRA Action Engine (plan → confirm → execute).",
        correlationId,
        requestId,
        code: "ACTION_ENGINE_REQUIRED",
      };
    }
    const prepared = await prepareXeroMcpExecution({
      env,
      companyId: input.companyId,
      toolName: input.toolName,
    });
    if (!prepared.ok) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "mcp.execution_failed",
        actor: actorLabel,
        resourceType: "gateway",
        resourceId: input.toolName,
        detail: {
          correlationId,
          requestId,
          provider: "xero",
          billed: false,
          inventsData: false,
          code: prepared.body.code,
        },
      });
      return {
        status: prepared.status,
        error: prepared.body.error,
        correlationId,
        requestId,
      };
    }
  }

  const mcp = await pickCompanyMcp(
    env.DB,
    input.companyId,
    input.mcpEnvironmentId ??
      (input.actor.type === "service"
        ? input.actor.identity.mcpEnvironmentId
        : null),
  );

  if (!mcp || !mcp.enabled) {
    return {
      status: 404 as const,
      error: "No enabled MCP environment for this company",
      correlationId,
      requestId,
    };
  }

  await ensureDefaultToolAllowlist(env.DB, mcp.companyId, mcp.id);

  let knowledgePreflight: Awaited<ReturnType<typeof evaluateKnowledgeBusinessSystemPreflight>> = {
    kind: "knowledge",
  };
  if (input.actor.type === "user") {
    knowledgePreflight = await evaluateKnowledgeBusinessSystemPreflight(
      env.DB,
      input.actor.user,
      input.companyId,
      input.toolName,
      input.arguments,
    );
    if (knowledgePreflight.kind === "not_connected" || knowledgePreflight.kind === "no_business_tool") {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "mcp.execution_failed",
        actor: actorLabel,
        resourceType: "gateway",
        resourceId: input.toolName,
        detail: {
          correlationId,
          requestId,
          reason: knowledgePreflight.kind,
          capability: knowledgePreflight.capability,
          billed: false,
        },
      });
      return {
        status: 409 as const,
        error: knowledgePreflight.message,
        correlationId,
        requestId,
        accessOutcome: knowledgePreflight.kind === "not_connected" ? "not_connected" : "technical_failure",
      };
    }
    if (knowledgePreflight.kind === "reroute") {
      input.toolName = knowledgePreflight.toolName;
      input.arguments = { ...(input.arguments ?? {}), ...knowledgePreflight.arguments };
      if (isXeroToolName(input.toolName) && !isXeroWriteToolName(input.toolName)) {
        const prepared = await prepareXeroMcpExecution({
          env,
          companyId: input.companyId,
          toolName: input.toolName,
        });
        if (!prepared.ok) {
          const mapped = mapExecutionOutcome({
            capability: knowledgePreflight.capability,
            connected: prepared.code !== "CONNECTOR_NOT_CONNECTED",
            httpStatus: prepared.status,
            error: prepared.body.error,
            code: prepared.code,
          });
          await recordAuditEvent(env.DB, {
            companyId: input.companyId,
            eventType: "mcp.execution_failed",
            actor: actorLabel,
            resourceType: "gateway",
            resourceId: input.toolName,
            detail: {
              correlationId,
              requestId,
              provider: "xero",
              billed: false,
              inventsData: false,
              code: prepared.body.code,
              reroutedFromKnowledge: true,
            },
          });
          return {
            status: prepared.status,
            error: mapped?.message ?? prepared.body.error,
            correlationId,
            requestId,
            accessOutcome: mapped?.outcome,
          };
        }
      }
    }
  }

  let { action, riskClass } = await resolveToolAction(
    env.DB,
    mcp.id,
    input.toolName,
  );
  if (knowledgePreflight.kind === "permission_denied") {
    action = actionForProtectedCapability(knowledgePreflight.capability);
  }

  await persistInteraction(env.DB, {
    id: interaction.interactionId,
    companyId: input.companyId,
    actorType: input.actor.type,
    actorId,
    clientKind: String(sourceClient),
    mcpId: mcp.id,
    mcpSessionId: interaction.mcpSessionId,
    label: labelForOperation(action),
    sourcedFrom: interaction.sourcedFrom,
  });

  let permissionAllowed = false;
  let permissionReason: string | undefined;
  let permissionRole: string | null = null;

  if (isOutlookReadTool(input.toolName) && isElvexCompany({ id: input.companyId })) {
    const rawMailbox =
      typeof input.arguments?.mailboxAddress === "string"
        ? input.arguments.mailboxAddress
        : typeof input.arguments?.mailbox === "string"
          ? input.arguments.mailbox
          : null;
    const resolvedMailbox = resolveElvexConfiguredMailbox(rawMailbox) ?? ELVEX_INFO_MAILBOXES[0];
    input.arguments = { ...(input.arguments ?? {}), mailboxAddress: resolvedMailbox };
  }

  if (input.actor.type === "user") {
    const mailbox =
      typeof input.arguments?.mailboxAddress === "string"
        ? input.arguments.mailboxAddress
        : typeof input.arguments?.mailbox === "string"
          ? input.arguments.mailbox
          : null;
    const decision = await evaluateActionPermission(
      env.DB,
      input.actor.user,
      input.companyId,
      action as ToolAction,
      { toolName: input.toolName, mailboxAddress: mailbox },
    );
    permissionAllowed = decision.allowed;
    permissionReason = decision.reason;
    permissionRole = decision.role;
  } else {
    const decision = await evaluateServiceActionPermission(
      env.DB,
      input.actor.identity,
      action,
    );
    permissionAllowed = decision.allowed;
    permissionReason = decision.reason;
  }

  const mailboxForCapability =
    typeof input.arguments?.mailboxAddress === "string"
      ? input.arguments.mailboxAddress
      : typeof input.arguments?.mailbox === "string"
        ? input.arguments.mailbox
        : null;
  const queryForCapability =
    typeof input.arguments?.query === "string" ? input.arguments.query : null;
  let protectedCapability = resolveProtectedCapability({
    action,
    toolName: input.toolName,
    mailboxAddress: mailboxForCapability,
    query: queryForCapability,
  });

  if (knowledgePreflight.kind === "permission_denied") {
    permissionAllowed = false;
    permissionReason = knowledgePreflight.denial.message;
    permissionRole = knowledgePreflight.denial.userRole;
    protectedCapability = knowledgePreflight.capability;
  }

  let permissionDenial: StructuredCapabilityDenial | undefined;
  if (!permissionAllowed && protectedCapability) {
    permissionDenial = await structuredPermissionDenial(env.DB, {
      companyId: input.companyId,
      capability: protectedCapability,
      role: permissionRole,
    });
    permissionReason = permissionDenial.message;
  } else if (!permissionAllowed) {
    permissionDenial = undefined;
    permissionReason =
      permissionReason && !/elvex role|rbac|403|mcp denied/i.test(permissionReason)
        ? permissionReason
        : "Your current permissions don’t allow this action.";
  }

  if (!permissionAllowed) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "permission.denied",
      actor: actorLabel,
      resourceType: "action",
      resourceId: action,
      detail: {
        correlationId,
        requestId,
        toolName: input.toolName,
        reason: permissionReason,
        riskClass,
        capability: protectedCapability,
        connected: permissionDenial?.connected ?? null,
        userAllowed: false,
        userRole: permissionRole,
        result: "permission_denied",
      },
    });

    await env.DB.prepare(
      `INSERT INTO gateway_requests (
        id, correlation_id, company_id, actor_type, actor_id, actor_label,
        source_client, mcp_environment_id, tool_name, action, risk_class,
        status, permission_allowed, credit_check_passed, http_status, latency_ms,
        error_code, error_message, metadata_json, created_at,
        client_request_id, request_id, settlement_status,
        interaction_id, parent_request_id, mcp_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'denied', 0, NULL, 403, ?, 'permission_denied', ?, '{}', ?, ?, ?, 'zero_charge', ?, ?, ?)`,
    )
      .bind(
        gatewayRequestId,
        correlationId,
        input.companyId,
        input.actor.type,
        actorId,
        actorLabel,
        sourceClient,
        mcp.id,
        input.toolName,
        action,
        riskClass,
        Date.now() - started,
        permissionReason ?? "denied",
        nowIso(),
        clientRequestId,
        requestId,
        interaction.interactionId,
        interaction.parentRequestId,
        interaction.mcpSessionId,
      )
      .run();

    const connectorInstanceId = await resolveConnectorInstanceId(
      env.DB,
      input.companyId,
      action,
      input.toolName,
    );
    await recordUsageEvent(env.DB, {
      companyId: input.companyId,
      userId: input.actor.type === "user" ? actorId : null,
      actorEmail: actorLabel,
      resourceType: "gateway",
      resourceId: input.toolName,
      mcpEnvironmentId: mcp.id,
      connectorInstanceId,
      toolName: input.toolName,
      action,
      riskClass,
      success: false,
      durationMs: Date.now() - started,
      sourceClient,
      correlationId,
      requestId,
      interactionId: interaction.interactionId,
      parentRequestId: interaction.parentRequestId,
      mcpSessionId: interaction.mcpSessionId,
      metadata: {
        denied: true,
        billingStatus: "denied",
        actorType: input.actor.type,
        membershipId:
          input.actor.type === "user" ? input.actor.membershipId ?? null : null,
        reason: permissionReason,
        capability: protectedCapability,
        connected: permissionDenial?.connected ?? null,
        result: "permission_denied",
      },
      settlementStatus: "denied",
    });

    scheduleQualityAudit(env, input.waitUntil, interaction.interactionId);
    return {
      status: 403 as const,
      error: permissionReason ?? "Your current permissions don’t allow this action.",
      correlationId,
      requestId,
      action,
      riskClass,
      accessOutcome: "permission_denied" as const,
      permissionDenial,
    };
  }

  const companyRow = await env.DB.prepare(
    `SELECT status FROM companies WHERE id = ?`,
  )
    .bind(input.companyId)
    .first();
  const { evaluateApprovalRequirement } = await import("./approvals");
  const approval = evaluateApprovalRequirement({
    riskClass,
    action,
    companyStatus: String(companyRow?.status ?? "active"),
  });
  if (!approval.allowed) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "permission.denied",
      actor: actorLabel,
      resourceType: "action",
      resourceId: action,
      detail: {
        correlationId,
        requestId,
        toolName: input.toolName,
        reason: approval.error?.code ?? "approval_blocked",
        riskClass,
      },
    });
    return {
      status: 403 as const,
      error: approval.error?.error ?? "Action is not permitted",
      correlationId,
      requestId,
      action,
      riskClass,
    };
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "company.accessed",
    actor: actorLabel,
    resourceType: "gateway",
    resourceId: action,
    detail: { stage: "gateway.authorised", correlationId, requestId },
  });

  const policy = await resolvePricingPolicy(env.DB, input.companyId);
  const pricing = await resolvePricingRule(env.DB, input.companyId, action);
  const estimated = calculateChargeCents(pricing, {
    success: true,
    underlyingCostCents: null,
    costBasis: "unknown",
    policy,
  });
  let creditCheckPassed: boolean | null = null;

  if (
    input.requireCredit !== false &&
    estimated.billable &&
    (estimated.customerChargeCents ?? 0) > 0
  ) {
    const wallet = await getWalletBalance(env.DB, input.companyId);
    creditCheckPassed =
      wallet.balanceCents >= (estimated.customerChargeCents ?? 0);
    if (!creditCheckPassed) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "billing",
        resourceId: input.companyId,
        detail: {
          stage: "billing.insufficient_credit",
          correlationId,
          requestId,
          reason: "insufficient_credit",
          balanceCents: wallet.balanceCents,
          requiredCents: estimated.customerChargeCents,
        },
      });

      await env.DB.prepare(
        `INSERT INTO gateway_requests (
          id, correlation_id, company_id, actor_type, actor_id, actor_label,
          source_client, mcp_environment_id, tool_name, action, risk_class,
          status, permission_allowed, credit_check_passed, http_status, latency_ms,
          error_code, error_message, metadata_json, created_at,
          client_request_id, request_id, settlement_status,
          interaction_id, parent_request_id, mcp_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'insufficient_credit', 1, 0, 402, ?, 'insufficient_credit', ?, '{}', ?, ?, ?, 'zero_charge', ?, ?, ?)`,
      )
        .bind(
          gatewayRequestId,
          correlationId,
          input.companyId,
          input.actor.type,
          actorId,
          actorLabel,
          sourceClient,
          mcp.id,
          input.toolName,
          action,
          riskClass,
          Date.now() - started,
          "Insufficient company credit",
          nowIso(),
          clientRequestId,
          requestId,
          interaction.interactionId,
          interaction.parentRequestId,
          interaction.mcpSessionId,
        )
        .run();

      return {
        status: 402 as const,
        error:
          "Your INFRA credit balance is empty. Add credit to continue.",
        correlationId,
        requestId,
        balanceCents: wallet.balanceCents,
        requiredCents: estimated.customerChargeCents,
      };
    }
  } else {
    creditCheckPassed = true;
  }

  const balanceBefore = await getWalletBalance(env.DB, input.companyId);

  const execution = isOutlookReadTool(input.toolName)
    ? await (async () => {
        const outlook = await executeOutlookReadTool(env, {
          companyId: input.companyId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          actor: actorLabel,
          actorUserId: actorId,
        });
        if (!outlook.ok) {
          return { status: outlook.status, error: outlook.message, code: outlook.code } as const;
        }
        return {
          status: 200 as const,
          data: {
            correlationId,
            mcpId: mcp.id,
            companyId: input.companyId,
            toolName: input.toolName,
            latencyMs: Date.now() - started,
            authConfigured: true,
            riskClass,
            result: outlook.result,
          },
        };
      })()
    : isXeroToolName(input.toolName) && !isXeroWriteToolName(input.toolName)
      ? await (async () => {
          const xero = await executeXeroReadToolOnInfra(env, {
            companyId: input.companyId,
            toolName: input.toolName,
            arguments: input.arguments,
            actor: actorLabel,
          });
          if (!xero.ok) {
            const mapped = mapExecutionOutcome({
              capability: "xero",
              connected: (xero.code ?? "") !== "CONNECTOR_NOT_CONNECTED",
              httpStatus: xero.status,
              error: xero.error,
              code: xero.code,
            });
            return {
              status: xero.status,
              error: mapped?.message ?? xero.error,
              code: xero.code,
              accessOutcome: mapped?.outcome,
            } as const;
          }
          const empty = xeroResultLooksEmpty(xero.result);
          return {
            status: 200 as const,
            data: {
              correlationId,
              mcpId: mcp.id,
              companyId: input.companyId,
              toolName: input.toolName,
              latencyMs: xero.latencyMs,
              authConfigured: true,
              riskClass,
              accessOutcome: empty ? "empty_result" : "allowed",
              message: empty
                ? "No matching Xero records were found for that period."
                : undefined,
              result: xero.result,
            },
          };
        })()
      : await executeRegisteredMcpTool(env, {
          mcpId: mcp.id,
          toolName: input.toolName,
          arguments: input.arguments,
          actorUserId: actorId,
          actorEmail: actorLabel,
          sourceClient,
          skipUsageRecording: true,
          correlationId,
        });

  const latencyMs = Date.now() - started;
  const success = execution.status === 200;

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: success ? "mcp.execution_succeeded" : "mcp.execution_failed",
    actor: actorLabel,
    resourceType: "gateway",
    resourceId: input.toolName,
    detail: {
      stage: "gateway.tool_executed",
      correlationId,
      requestId,
      success,
      latencyMs,
      errorCode: !success && "code" in execution ? execution.code : undefined,
      error: !success && "error" in execution ? execution.error : undefined,
    },
  });

  // Underlying provider cost unknown until rate items + metering quantities exist
  const charge = calculateChargeCents(pricing, {
    success,
    underlyingCostCents: null,
    costBasis: "unknown",
    policy,
  });

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "company.accessed",
    actor: actorLabel,
    resourceType: "pricing",
    resourceId: action,
    detail: {
      stage: "pricing.calculated",
      correlationId,
      requestId,
      billable: charge.billable,
      customerChargeCents: charge.customerChargeCents,
      costBasis: charge.costBasis,
      pricingRuleId: charge.pricingRuleId,
      isTestConfig: charge.isTestConfig,
    },
  });

  let usageRecordId: string | null = null;
  let ledgerEntryId: string | null = null;
  let settlementStatus = "zero_charge";

  let connectorInstanceId: string | null = null;
  try {
    connectorInstanceId = await resolveConnectorInstanceId(
      env.DB,
      input.companyId,
      action,
      input.toolName,
    );
  } catch {
    connectorInstanceId = null;
  }
  if (
    input.actor.type === "user" &&
    (sourceClient === "chatgpt" || sourceClient === "claude")
  ) {
    await touchAiUserConnection(
      env.DB,
      input.companyId,
      actorId,
      sourceClient,
    ).catch(() => undefined);
  }

  try {
    const usage = await recordUsageEvent(env.DB, {
      companyId: input.companyId,
      userId: input.actor.type === "user" ? actorId : null,
      actorEmail: actorLabel,
      resourceType: "gateway",
      resourceId: input.toolName,
      mcpEnvironmentId: mcp.id,
      connectorInstanceId,
      toolName: input.toolName,
      action,
      riskClass,
      success,
      durationMs: latencyMs,
      sourceClient,
      correlationId,
      requestId,
      interactionId: interaction.interactionId,
      parentRequestId: interaction.parentRequestId,
      mcpSessionId: interaction.mcpSessionId,
      charge,
      metadata: {
        pricingLabel: charge.pricingLabel,
        isTestConfig: charge.isTestConfig,
        actorType: input.actor.type,
        membershipId:
          input.actor.type === "user" ? input.actor.membershipId ?? null : null,
        balanceBeforeCents: balanceBefore.balanceCents,
        interactionId: interaction.interactionId,
        interactionSourcedFrom: interaction.sourcedFrom,
      },
      settlementStatus:
        decideTestBilling({
          toolName: input.toolName,
          action,
          success,
          httpStatus: execution.status,
          ruleBillable: charge.billable,
          chargeOnFailure: pricing?.chargeOnFailure ?? false,
        }).customerBillable && charge.customerChargeCents
          ? "unsettled"
          : "zero_charge",
    });
    usageRecordId = usage.id;
    await refreshInteractionTotals(env.DB, interaction.interactionId);
    scheduleQualityAudit(env, input.waitUntil, interaction.interactionId);

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "company.accessed",
      actor: actorLabel,
      resourceType: "usage",
      resourceId: usage.id,
      detail: {
        stage: "usage.recorded",
        correlationId,
        requestId,
        alreadyExists: usage.alreadyExists,
      },
    });
  } catch {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "company.accessed",
      actor: actorLabel,
      resourceType: "usage",
      resourceId: input.toolName,
      detail: {
        stage: "usage.record_failed",
        correlationId,
        requestId,
        toolName: input.toolName,
      },
    }).catch(() => undefined);
  }

  const billing = decideTestBilling({
    toolName: input.toolName,
    action,
    success,
    httpStatus: execution.status,
    ruleBillable: charge.billable,
    chargeOnFailure: pricing?.chargeOnFailure ?? false,
  });

  if (
    billing.customerBillable &&
    charge.customerChargeCents &&
    charge.customerChargeCents > 0 &&
    usageRecordId
  ) {
    const latestWallet = await getWalletBalance(env.DB, input.companyId);
    if (latestWallet.balanceCents < charge.customerChargeCents) {
      settlementStatus = "failed";
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "billing",
        resourceId: usageRecordId,
        detail: {
          stage: "billing.debit_skipped_insufficient_credit",
          correlationId,
          requestId,
          interactionId: interaction.interactionId,
          balanceCents: latestWallet.balanceCents,
          requiredCents: charge.customerChargeCents,
        },
      });
    } else {
      try {
        const chargeCents = Math.abs(charge.customerChargeCents);
        const allocation = await allocateDebitCreditClasses(
          env.DB,
          input.companyId,
          chargeCents,
        );
        const ledger = await appendLedgerEntry(env.DB, {
          companyId: input.companyId,
          entryType: "usage_debit",
          amountCents: -chargeCents,
          referenceType: "usage",
          referenceId: usageRecordId,
          description: `${humanSource(sourceClient)} · ${humanAction(action)}`,
          metadata: {
            correlationId,
            requestId,
            interactionId: interaction.interactionId,
            isTestConfig: charge.isTestConfig,
            pricingLabel: charge.pricingLabel,
            balanceBeforeCents: latestWallet.balanceCents,
            promotionalCentsUsed: allocation.promotionalCents,
            paidCentsUsed: allocation.paidCents,
            creditConsumptionOrder: "promotional_first",
          },
          createdBy: actorLabel,
        });
        if (allocation.promotionalCents > 0) {
          await consumePromotionalGrants(env.DB, input.companyId, allocation.promotionalCents);
        }
        ledgerEntryId = ledger.entry.id;
        settlementStatus = "settled";
        await markUsageSettled(env.DB, usageRecordId, ledger.entry.id);

        await recordAuditEvent(env.DB, {
          companyId: input.companyId,
          eventType: "billing.credit_adjusted",
          actor: actorLabel,
          resourceType: "ledger",
          resourceId: ledger.entry.id,
          detail: {
            stage: "billing.debit_created",
            correlationId,
            requestId,
            interactionId: interaction.interactionId,
            amountCents: -Math.abs(charge.customerChargeCents),
            balanceAfterCents: ledger.entry.balanceAfterCents,
            alreadyExists: ledger.alreadyExists,
          },
        });
      } catch (err) {
        settlementStatus = "failed";
        const message = err instanceof Error ? err.message : "ledger_failed";
        await recordAuditEvent(env.DB, {
          companyId: input.companyId,
          eventType: "permission.denied",
          actor: actorLabel,
          resourceType: "billing",
          resourceId: usageRecordId,
          detail: {
            stage:
              message === "INSUFFICIENT_CREDIT"
                ? "billing.debit_rejected_insufficient_credit"
                : "billing.debit_failed",
            correlationId,
            requestId,
            interactionId: interaction.interactionId,
            error: message,
          },
        });
        // MCP already executed — do not fail the customer response for a race.
      }
    }
  }

  const statusLabel = success ? "succeeded" : "failed";
  try {
    await env.DB.prepare(
      `INSERT INTO gateway_requests (
        id, correlation_id, company_id, actor_type, actor_id, actor_label,
        source_client, mcp_environment_id, tool_name, action, risk_class,
        status, permission_allowed, credit_check_passed, http_status, latency_ms,
        usage_record_id, ledger_entry_id, error_code, error_message, metadata_json, created_at,
        client_request_id, request_id, settlement_status,
        interaction_id, parent_request_id, mcp_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        gatewayRequestId,
        correlationId,
        input.companyId,
        input.actor.type,
        actorId,
        actorLabel,
        sourceClient,
        mcp.id,
        input.toolName,
        action,
        riskClass,
        statusLabel,
        creditCheckPassed ? 1 : 0,
        execution.status,
        latencyMs,
        usageRecordId,
        ledgerEntryId,
        success ? null : "mcp_execution_failed",
        success
          ? null
          : sanitizeCustomerError(
              "error" in execution ? String(execution.error) : "failed",
            ),
        JSON.stringify({
          action,
          riskClass,
          isTestConfig: charge.isTestConfig,
          requestId,
          interactionId: interaction.interactionId,
        }),
        nowIso(),
        clientRequestId,
        requestId,
        settlementStatus,
        interaction.interactionId,
        interaction.parentRequestId,
        interaction.mcpSessionId,
      )
      .run();
  } catch {
    // Unique client_request_id race — treat as idempotent
    if (clientRequestId) {
      const prior = await findIdempotentGateway(
        env.DB,
        input.companyId,
        clientRequestId,
      );
      if (prior) {
        return {
          status: Number(prior.http_status ?? 200) as 200,
          correlationId: String(prior.correlation_id),
          gatewayRequestId: String(prior.id),
          requestId: String(prior.request_id ?? requestId),
          idempotentReplay: true,
          companyId: input.companyId,
          mcpId: mcp.id,
          toolName: input.toolName,
          action,
          riskClass,
          latencyMs,
          charge: {
            billable: charge.billable,
            customerChargeCents: charge.customerChargeCents,
            isTestConfig: charge.isTestConfig,
            pricingLabel: charge.pricingLabel,
          },
          result: "data" in execution ? execution.data?.result : undefined,
        };
      }
    }
  }

  if (!success) {
    const mapped = mapExecutionOutcome({
      capability: protectedCapability,
      connected: protectedCapability ? true : null,
      httpStatus: execution.status,
      error: "error" in execution ? String(execution.error) : null,
      code: "code" in execution ? String(execution.code ?? "") : null,
    });
    return {
      status: execution.status,
      error:
        mapped?.message ??
        ("error" in execution ? execution.error : "Gateway execution failed"),
      correlationId,
      requestId,
      action,
      riskClass,
      accessOutcome: mapped?.outcome,
    };
  }

  const balanceAfter = await getWalletBalance(env.DB, input.companyId);

  if (
    settlementStatus === "settled" &&
    charge.customerChargeCents &&
    charge.customerChargeCents > 0
  ) {
    void maybeNotifyWalletHealth(env.DB, input.companyId).catch(() => undefined);
    const companyRow = await env.DB.prepare(`SELECT name FROM companies WHERE id = ?`)
      .bind(input.companyId)
      .first();
    void maybeTriggerAutoTopUp(env, {
      companyId: input.companyId,
      companyName: String(companyRow?.name ?? input.companyId),
      actorEmail: "gateway",
    }).catch(() => undefined);
  }

  return {
    status: 200 as const,
    correlationId,
    gatewayRequestId,
    requestId,
    interactionId: interaction.interactionId,
    companyId: input.companyId,
    mcpId: mcp.id,
    toolName: input.toolName,
    action,
    riskClass,
    latencyMs,
    charge: {
      billable: charge.billable,
      customerChargeCents: charge.customerChargeCents,
      underlyingCostCents: charge.underlyingCostCents,
      costBasis: charge.costBasis,
      targetMarginBps: charge.targetMarginBps,
      actualMarginBps: charge.actualMarginBps,
      grossProfitCents: charge.grossProfitCents,
      isTestConfig: charge.isTestConfig,
      pricingLabel: charge.pricingLabel,
      pricingRuleId: charge.pricingRuleId,
      settlementStatus,
      balanceBeforeCents: balanceBefore.balanceCents,
      balanceAfterCents: balanceAfter.balanceCents,
      ledgerEntryId,
      usageRecordId,
    },
    result: "data" in execution ? execution.data?.result : undefined,
  };
}

function humanSource(source: string): string {
  const map: Record<string, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    whatsapp: "WhatsApp",
  };
  return map[source] ?? source;
}

function humanAction(action: string): string {
  const map: Record<string, string> = {
    "knowledge.search": "Knowledge Search",
    "knowledge.read": "Knowledge Read",
    "system.health": "System Health",
  };
  return map[action] ?? action.replace(/[._]/g, " ");
}
