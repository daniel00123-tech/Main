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
import { calculateChargeCents, resolvePricingRule } from "./pricing";
import { recordUsageEvent } from "./usage";
import {
  authenticateServiceToken,
  evaluateServiceActionPermission,
  type ServiceIdentityRecord,
} from "./service-identities";
import {
  evaluateActionPermission,
  userHasCompanyAccess,
} from "../permissions/service";

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

  // Safe defaults for known read-only tools
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
  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
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
  },
) {
  const correlationId = newId("corr");
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

  // Tenant isolation
  if (input.actor.type === "user") {
    if (!userHasCompanyAccess(input.actor.user, input.companyId)) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "gateway",
        resourceId: input.toolName,
        detail: { correlationId, reason: "cross_company" },
      });
      return {
        status: 403 as const,
        error: "Access to this company is denied",
        correlationId,
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
        reason: "service_tenant_spoof",
        attemptedCompanyId: input.companyId,
      },
    });
    return {
      status: 403 as const,
      error: "Service identity does not belong to this company",
      correlationId,
    };
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
    };
  }

  await ensureDefaultToolAllowlist(env.DB, mcp.companyId, mcp.id);
  const { action, riskClass } = await resolveToolAction(
    env.DB,
    mcp.id,
    input.toolName,
  );

  // Permission check
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
        error_code, error_message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'denied', 0, NULL, 403, ?, 'permission_denied', ?, '{}', ?)`,
    )
      .bind(
        gatewayRequestId,
        correlationId,
        input.companyId,
        input.actor.type,
        actorId,
        actorLabel,
        input.sourceClient ?? null,
        mcp.id,
        input.toolName,
        action,
        riskClass,
        Date.now() - started,
        permissionReason ?? "denied",
        nowIso(),
      )
      .run();

    return {
      status: 403 as const,
      error: permissionReason ?? "Permission denied",
      correlationId,
      action,
      riskClass,
    };
  }

  // Credit pre-flight (configurable; skip for non-billable)
  const pricing = await resolvePricingRule(env.DB, input.companyId, action);
  const estimated = calculateChargeCents(pricing, {
    success: true,
    underlyingCostCents: null,
  });
  let creditCheckPassed: boolean | null = null;

  if (input.requireCredit !== false && estimated.billable && (estimated.customerChargeCents ?? 0) > 0) {
    const wallet = await getWalletBalance(env.DB, input.companyId);
    creditCheckPassed = wallet.balanceCents >= (estimated.customerChargeCents ?? 0);
    if (!creditCheckPassed) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: actorLabel,
        resourceType: "billing",
        resourceId: input.companyId,
        detail: {
          correlationId,
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
          error_code, error_message, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'insufficient_credit', 1, 0, 402, ?, 'insufficient_credit', ?, '{}', ?)`,
      )
        .bind(
          gatewayRequestId,
          correlationId,
          input.companyId,
          input.actor.type,
          actorId,
          actorLabel,
          input.sourceClient ?? null,
          mcp.id,
          input.toolName,
          action,
          riskClass,
          Date.now() - started,
          "Insufficient company credit",
          nowIso(),
        )
        .run();

      return {
        status: 402 as const,
        error: "Insufficient company credit",
        correlationId,
        balanceCents: wallet.balanceCents,
        requiredCents: estimated.customerChargeCents,
      };
    }
  } else {
    creditCheckPassed = true;
  }

  // Execute via registered MCP only
  const execution = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: input.toolName,
    arguments: input.arguments,
    actorUserId: actorId,
    actorEmail: actorLabel,
    sourceClient: input.sourceClient ?? "infra-gateway",
    skipUsageRecording: true,
    correlationId,
  });

  const latencyMs = Date.now() - started;
  const success = execution.status === 200;

  // Pricing on actual outcome
  const charge = calculateChargeCents(pricing, {
    success,
    underlyingCostCents: null,
  });

  let usageRecordId: string | null = null;
  let ledgerEntryId: string | null = null;

  // executeRegisteredMcpTool already writes usage — for gateway we still debit wallet
  // when billable. Find latest usage by correlation is hard since execute creates its own.
  // So we record an additional gateway-scoped usage only for billing linkage when needed,
  // OR we debit using gateway correlation as reference.

  if (charge.billable && charge.customerChargeCents && charge.customerChargeCents > 0) {
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
      sourceClient: input.sourceClient ?? "infra-gateway",
      correlationId,
      underlyingCostCents: charge.underlyingCostCents,
      customerChargeCents: charge.customerChargeCents,
      metadata: {
        pricingLabel: charge.pricingLabel,
        isTestConfig: charge.isTestConfig,
        actorType: input.actor.type,
      },
    });
    usageRecordId = usage.id;

    if (success) {
      const ledger = await appendLedgerEntry(env.DB, {
        companyId: input.companyId,
        entryType: "usage_debit",
        amountCents: -Math.abs(charge.customerChargeCents),
        referenceType: "usage",
        referenceId: usage.id,
        description: `Gateway ${action} (${input.toolName})`,
        metadata: {
          correlationId,
          isTestConfig: charge.isTestConfig,
          pricingLabel: charge.pricingLabel,
        },
        createdBy: actorLabel,
      });
      ledgerEntryId = ledger.entry.id;
    }
  }

  const statusLabel = success ? "succeeded" : "failed";
  await env.DB.prepare(
    `INSERT INTO gateway_requests (
      id, correlation_id, company_id, actor_type, actor_id, actor_label,
      source_client, mcp_environment_id, tool_name, action, risk_class,
      status, permission_allowed, credit_check_passed, http_status, latency_ms,
      usage_record_id, ledger_entry_id, error_code, error_message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      gatewayRequestId,
      correlationId,
      input.companyId,
      input.actor.type,
      actorId,
      actorLabel,
      input.sourceClient ?? null,
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
      success ? null : ("error" in execution ? execution.error : "failed"),
      JSON.stringify({
        action,
        riskClass,
        isTestConfig: charge.isTestConfig,
      }),
      nowIso(),
    )
    .run();

  if (!success) {
    return {
      status: execution.status,
      error: "error" in execution ? execution.error : "Gateway execution failed",
      correlationId,
      action,
      riskClass,
    };
  }

  return {
    status: 200 as const,
    correlationId,
    gatewayRequestId,
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
