import type { ToolAction } from "@infra/shared";
import type { Env } from "../env";
import type { SessionUser } from "../auth/session";
import { newId, nowIso } from "../db/mappers";
import {
  executeRegisteredMcpTool,
  ensureDefaultToolAllowlist,
  getMcpEnvironment,
  listMcpEnvironments,
  recordAuditEvent,
} from "./control-plane";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
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

export type GatewayActor =
  | { type: "user"; user: SessionUser }
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

  if (toolName === "search_company_knowledge") {
    return { action: "knowledge.search", riskClass: "low_risk" };
  }
  if (toolName === "get_knowledge_document" || toolName === "database_summary") {
    return { action: "knowledge.read", riskClass: "low_risk" };
  }
  if (toolName === "system_health") {
    return { action: "system.health", riskClass: "low_risk" };
  }

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

export async function resolveGatewayActor(
  env: Env,
  request: Request,
  sessionUser: SessionUser | null,
): Promise<GatewayActor | { error: string; status: 401 | 403 }> {
  const token = extractServiceCredential(request);
  if (token) {
    const identity = await authenticateServiceToken(env.DB, token);
    if (!identity) {
      return { error: "Invalid or revoked service token", status: 401 };
    }
    if (identity.status !== "active") {
      return { error: "Service identity is disabled", status: 403 };
    }
    return { type: "service", identity };
  }

  if (sessionUser) {
    return { type: "user", user: sessionUser };
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
  const sourceClient =
    input.sourceClient ??
    (input.actor.type === "service"
      ? input.actor.identity.identityType
      : "infra-gateway");

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
  const { action, riskClass } = await resolveToolAction(
    env.DB,
    mcp.id,
    input.toolName,
  );

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

  if (input.actor.type === "user") {
    const decision = await evaluateActionPermission(
      env.DB,
      input.actor.user,
      input.companyId,
      action as ToolAction,
    );
    permissionAllowed = decision.allowed;
    permissionReason = decision.reason;
  } else {
    const decision = await evaluateServiceActionPermission(
      env.DB,
      input.actor.identity,
      action,
    );
    permissionAllowed = decision.allowed;
    permissionReason = decision.reason;
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

    return {
      status: 403 as const,
      error: permissionReason ?? "Permission denied",
      correlationId,
      requestId,
      action,
      riskClass,
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
        error: "Insufficient company credit",
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

  const execution = await executeRegisteredMcpTool(env, {
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

  const usage = await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    userId: input.actor.type === "user" ? actorId : null,
    actorEmail: actorLabel,
    resourceType: "gateway",
    resourceId: input.toolName,
    mcpEnvironmentId: mcp.id,
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
    charge.customerChargeCents > 0
  ) {
    const latestWallet = await getWalletBalance(env.DB, input.companyId);
    if (latestWallet.balanceCents < charge.customerChargeCents) {
      settlementStatus = "failed";
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "billing",
        resourceId: usage.id,
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
        const ledger = await appendLedgerEntry(env.DB, {
          companyId: input.companyId,
          entryType: "usage_debit",
          amountCents: -Math.abs(charge.customerChargeCents),
          referenceType: "usage",
          referenceId: usage.id,
          description: `${humanSource(sourceClient)} · ${humanAction(action)}`,
          metadata: {
            correlationId,
            requestId,
            interactionId: interaction.interactionId,
            isTestConfig: charge.isTestConfig,
            pricingLabel: charge.pricingLabel,
            balanceBeforeCents: latestWallet.balanceCents,
          },
          createdBy: actorLabel,
        });
        ledgerEntryId = ledger.entry.id;
        settlementStatus = "settled";
        await markUsageSettled(env.DB, usage.id, ledger.entry.id);

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
          resourceId: usage.id,
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
        success ? null : "error" in execution ? execution.error : "failed",
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
    return {
      status: execution.status,
      error: "error" in execution ? execution.error : "Gateway execution failed",
      correlationId,
      requestId,
      action,
      riskClass,
    };
  }

  const balanceAfter = await getWalletBalance(env.DB, input.companyId);

  return {
    status: 200 as const,
    correlationId,
    gatewayRequestId,
    requestId,
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
