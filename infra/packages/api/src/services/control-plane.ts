import type { Env } from "../env";
import {
  newId,
  nowIso,
  rowToAuditEvent,
  rowToCompany,
  rowToConnectorInstance,
  rowToCreditBalance,
  rowToMcpEnvironment,
  rowToSyncHistory,
} from "../db/mappers";
import {
  callMcpTool,
  extractKnowledgeCounts,
  listMcpTools,
  resolveMcpAuthHeader,
} from "./mcp-client";
import { getUsageSummary, listPlatformUsage, recordUsageEvent } from "./usage";
import { getWalletBalance } from "./ledger";

export async function listCompanies(db: D1Database, companyIds?: string[]) {
  if (companyIds && companyIds.length === 0) {
    return [];
  }

  const query =
    companyIds && companyIds.length > 0
      ? db
          .prepare(
            `SELECT * FROM companies WHERE id IN (${companyIds.map(() => "?").join(", ")}) ORDER BY name ASC`,
          )
          .bind(...companyIds)
      : db.prepare("SELECT * FROM companies ORDER BY name ASC");

  const result = await query.all();
  return (result.results ?? []).map((row) => rowToCompany(row));
}

export async function getCompanyBySlug(db: D1Database, slug: string) {
  const row = await db
    .prepare("SELECT * FROM companies WHERE slug = ?")
    .bind(slug)
    .first();
  return row ? rowToCompany(row) : null;
}

export async function getCompanyById(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(id)
    .first();
  return row ? rowToCompany(row) : null;
}

export async function listMcpEnvironments(db: D1Database, companyId?: string) {
  const query = companyId
    ? db
        .prepare(
          "SELECT * FROM mcp_environments WHERE company_id = ? ORDER BY name ASC",
        )
        .bind(companyId)
    : db.prepare("SELECT * FROM mcp_environments ORDER BY name ASC");
  const result = await query.all();
  return (result.results ?? []).map((row) => rowToMcpEnvironment(row));
}

export async function getMcpEnvironment(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM mcp_environments WHERE id = ?")
    .bind(id)
    .first();
  return row ? rowToMcpEnvironment(row) : null;
}

export async function listConnectorInstances(
  db: D1Database,
  companyId?: string,
) {
  const query = companyId
    ? db
        .prepare(
          "SELECT * FROM connector_instances WHERE company_id = ? ORDER BY name ASC",
        )
        .bind(companyId)
    : db.prepare("SELECT * FROM connector_instances ORDER BY name ASC");
  const result = await query.all();
  return (result.results ?? []).map((row) => rowToConnectorInstance(row));
}

export async function getConnectorInstance(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM connector_instances WHERE id = ?")
    .bind(id)
    .first();
  return row ? rowToConnectorInstance(row) : null;
}

export async function getCreditBalance(db: D1Database, companyId: string) {
  const row = await db
    .prepare("SELECT * FROM credit_balances WHERE company_id = ?")
    .bind(companyId)
    .first();
  return row ? rowToCreditBalance(row) : null;
}

export async function listAuditEvents(
  db: D1Database,
  companyId?: string,
  limit = 20,
) {
  const query = companyId
    ? db
        .prepare(
          "SELECT * FROM audit_events WHERE company_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .bind(companyId, limit)
    : db
        .prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
        .bind(limit);
  const result = await query.all();
  return (result.results ?? []).map((row) => rowToAuditEvent(row));
}

export async function listSyncHistory(
  db: D1Database,
  connectorInstanceId: string,
  limit = 20,
) {
  const result = await db
    .prepare(
      "SELECT * FROM sync_history WHERE connector_instance_id = ? ORDER BY started_at DESC LIMIT ?",
    )
    .bind(connectorInstanceId, limit)
    .all();
  return (result.results ?? []).map((row) => rowToSyncHistory(row));
}

export async function getCompanyOverview(db: D1Database, companyId: string) {
  const company = await getCompanyById(db, companyId);
  if (!company) return null;

  const [
    mcpEnvironments,
    connectorInstances,
    creditBalance,
    recentAuditEvents,
    usageSummary,
    wallet,
  ] = await Promise.all([
    listMcpEnvironments(db, companyId),
    listConnectorInstances(db, companyId),
    getCreditBalance(db, companyId),
    listAuditEvents(db, companyId, 10),
    getUsageSummary(db, companyId),
    getWalletBalance(db, companyId),
  ]);

  const mcp = mcpEnvironments[0];
  const knowledgeConfigured =
    (mcp?.knowledgeDocumentCount ?? 0) > 0 ||
    (mcp?.capabilities ?? []).includes("search_company_knowledge");
  const warehouseConfigured = (mcp?.capabilities ?? []).some((name) =>
    /warehouse|database_summary|query_business|entity/i.test(name),
  );

  const [lastUsage, identityRow] = await Promise.all([
    db
      .prepare(
        `SELECT MAX(recorded_at) AS last FROM usage_records WHERE company_id = ?`,
      )
      .bind(companyId)
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS count,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
                MAX(last_used_at) AS last_used
         FROM service_identities WHERE company_id = ?`,
      )
      .bind(companyId)
      .first(),
  ]);

  const lastUsageAt = lastUsage?.last ? String(lastUsage.last) : null;
  const lastIdentityUsed = identityRow?.last_used
    ? String(identityRow.last_used)
    : null;
  const lastActivityAt =
    [lastUsageAt, lastIdentityUsed, recentAuditEvents[0]?.createdAt]
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  return {
    company,
    mcpEnvironments,
    connectorInstances,
    creditBalance,
    recentAuditEvents,
    usageSummary,
    wallet,
    knowledgeStatus: knowledgeConfigured ? "configured" : "not_configured",
    warehouseStatus: warehouseConfigured ? "configured" : "not_configured",
    lastUsageAt,
    lastActivityAt,
    aiIdentityCount: Number(identityRow?.count ?? 0),
    activeAiIdentityCount: Number(identityRow?.active_count ?? 0),
  };
}

export async function recordAuditEvent(
  db: D1Database,
  input: {
    companyId?: string | null;
    eventType: string;
    actor: string;
    resourceType?: string | null;
    resourceId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  const id = newId("audit");
  const createdAt = nowIso();
  await db
    .prepare(
      `INSERT INTO audit_events
        (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId ?? null,
      input.eventType,
      input.actor,
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify(input.detail ?? {}),
      createdAt,
    )
    .run();
  return id;
}

export interface McpHealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  message: string;
  latencyMs: number;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
]);

export function validateRegisteredMcpEndpoint(
  endpointUrl: string,
  environment: string,
): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return { valid: false, reason: "Invalid endpoint URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, reason: "Unsupported URL protocol" };
  }

  if (environment === "production" && parsed.protocol !== "https:") {
    return { valid: false, reason: "Production MCP endpoints must use HTTPS" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: "Blocked endpoint host" };
  }

  if (
    /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      hostname,
    )
  ) {
    return { valid: false, reason: "Private network endpoints are not allowed" };
  }

  return { valid: true };
}

export async function checkMcpHealth(
  endpointUrl: string,
  environment = "development",
): Promise<McpHealthResult> {
  const validation = validateRegisteredMcpEndpoint(endpointUrl, environment);
  if (!validation.valid) {
    return {
      status: "unhealthy",
      message: validation.reason ?? "Endpoint validation failed",
      latencyMs: 0,
    };
  }

  const started = Date.now();
  try {
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - started;

    if (response.ok || response.status === 404 || response.status === 405) {
      return {
        status: "healthy",
        message: `Endpoint reachable (HTTP ${response.status})`,
        latencyMs,
      };
    }

    return {
      status: "degraded",
      message: `Endpoint returned HTTP ${response.status}`,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      message:
        error instanceof Error ? error.message : "Health check request failed",
      latencyMs: Date.now() - started,
    };
  }
}

export async function isToolAllowed(
  db: D1Database,
  mcpEnvironmentId: string,
  toolName: string,
): Promise<{ allowed: boolean; riskClass: string }> {
  const row = await db
    .prepare(
      `SELECT enabled, risk_class FROM mcp_tool_allowlist
       WHERE mcp_environment_id = ? AND tool_name = ?`,
    )
    .bind(mcpEnvironmentId, toolName)
    .first();

  if (!row) {
    return { allowed: false, riskClass: "high_risk" };
  }

  return {
    allowed: Boolean(row.enabled),
    riskClass: String(row.risk_class ?? "low_risk"),
  };
}

export async function runMcpHealthCheck(
  env: Env,
  mcpId: string,
  actor: string,
) {
  const mcp = await getMcpEnvironment(env.DB, mcpId);
  if (!mcp) return null;

  const validation = validateRegisteredMcpEndpoint(
    mcp.endpointUrl,
    env.ENVIRONMENT,
  );
  if (!validation.valid) {
    return {
      mcpId,
      status: "unreachable" as const,
      message: validation.reason ?? "Endpoint validation failed",
      latencyMs: 0,
      checkedAt: nowIso(),
      authConfigured: false,
    };
  }

  const checkedAt = nowIso();
  const { authConfigured } = resolveMcpAuthHeader(env, mcp.authSecretRef);

  try {
    const tools = await listMcpTools(
      env,
      mcp.endpointUrl,
      mcp.authSecretRef,
      mcp.serviceBindingRef,
    );
    const health = await callMcpTool(env, {
      endpointUrl: mcp.endpointUrl,
      authSecretRef: mcp.authSecretRef,
      serviceBindingRef: mcp.serviceBindingRef,
      toolName: "system_health",
      arguments: {},
    });

    let documentCount: number | null = null;
    let chunkCount: number | null = null;
    try {
      const summary = await callMcpTool(env, {
        endpointUrl: mcp.endpointUrl,
        authSecretRef: mcp.authSecretRef,
        serviceBindingRef: mcp.serviceBindingRef,
        toolName: "database_summary",
        arguments: {},
      });
      const counts = extractKnowledgeCounts(summary.textContent);
      documentCount = counts.documentCount;
      chunkCount = counts.chunkCount;
    } catch {
      // Optional enrichment — transport health can still succeed without summary
    }

    await ensureDefaultToolAllowlist(env.DB, mcp.companyId, mcp.id);
    await syncAllowlistFromRemoteTools(
      env.DB,
      mcp.companyId,
      mcp.id,
      tools.tools.map((tool) => tool.name),
    );

    // Functional probe only when the company MCP actually exposes knowledge search.
    // HT/EL currently have knowledge not_configured — missing search is not unhealthy.
    const hasKnowledgeSearch = tools.tools.some(
      (tool) => tool.name === "search_company_knowledge",
    );
    let searchStatus: "ok" | "failed" | "not_configured" = "not_configured";
    let searchError: string | null = null;
    if (hasKnowledgeSearch) {
      try {
        const probe = await callMcpTool(env, {
          endpointUrl: mcp.endpointUrl,
          authSecretRef: mcp.authSecretRef,
          serviceBindingRef: mcp.serviceBindingRef,
          toolName: "search_company_knowledge",
          arguments: { query: "Project Falcon", topK: 1 },
        });
        if (probe.textContent && probe.textContent.length > 0) {
          searchStatus = "ok";
        } else {
          searchStatus = "failed";
          searchError = "Search returned empty content";
        }
      } catch (err) {
        searchStatus = "failed";
        searchError = err instanceof Error ? err.message : "Search probe failed";
      }
    }

    let mcpVersion = mcp.mcpVersion;
    let transportMessage = "Transport reachable";
    try {
      if (health.textContent) {
        const parsed = JSON.parse(health.textContent) as {
          status?: string;
          mcp?: { version?: string; name?: string };
        };
        if (parsed.mcp?.version) mcpVersion = parsed.mcp.version;
        transportMessage = `Transport ${parsed.status ?? "healthy"} · ${tools.tools.length} tools`;
      }
    } catch {
      transportMessage = `Transport reachable · ${tools.tools.length} tools`;
    }

    const latencyMs = health.latencyMs;
    const transportStatus = "healthy" as const;
    const overallStatus =
      searchStatus === "failed" ? ("degraded" as const) : ("healthy" as const);
    const healthMessage =
      searchStatus === "ok"
        ? `${transportMessage} · Search ok`
        : searchStatus === "not_configured"
          ? `${transportMessage} · Knowledge not configured`
          : `${transportMessage} · Search failed${searchError ? `: ${searchError}` : ""}`;

    await env.DB.prepare(
      `UPDATE mcp_environments
       SET status = ?, last_health_check_at = ?, last_healthy_at = ?, health_message = ?,
           mcp_version = ?, capabilities_json = ?, last_successful_request_at = ?,
           last_error = NULL, last_latency_ms = ?, knowledge_document_count = ?,
           knowledge_chunk_count = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        overallStatus,
        checkedAt,
        overallStatus === "healthy" ? checkedAt : mcp.lastHealthyAt,
        healthMessage,
        mcpVersion,
        JSON.stringify({
          tools: tools.tools.map((tool) => tool.name),
          transport: transportStatus,
          search: searchStatus,
          searchError,
        }),
        checkedAt,
        latencyMs,
        documentCount,
        chunkCount,
        checkedAt,
        mcpId,
      )
      .run();

    await recordAuditEvent(env.DB, {
      companyId: mcp.companyId,
      eventType: "mcp.health_checked",
      actor,
      resourceType: "mcp",
      resourceId: mcpId,
      detail: {
        status: overallStatus,
        transport: transportStatus,
        search: searchStatus,
        searchError,
        latencyMs,
        message: healthMessage,
        authConfigured,
        toolCount: tools.tools.length,
        knowledgeDocumentCount: documentCount,
        billed: false,
      },
    });

    return {
      mcpId,
      status: overallStatus,
      transport: transportStatus,
      search: searchStatus,
      searchError,
      message: healthMessage,
      latencyMs,
      checkedAt,
      authConfigured,
      mcpVersion,
      tools: tools.tools.map((tool) => tool.name),
      knowledgeDocumentCount: documentCount,
      knowledgeChunkCount: chunkCount,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "MCP health check failed";

    const publicHealth = await probePublicCompanyHealth(mcp.endpointUrl);
    if (publicHealth.ok) {
      await env.DB.prepare(
        `UPDATE mcp_environments
         SET status = ?, last_health_check_at = ?, last_healthy_at = ?, health_message = ?,
             mcp_version = COALESCE(?, mcp_version),
             business_mcp_core_version = COALESCE(?, business_mcp_core_version),
             last_error = ?, last_latency_ms = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          "healthy",
          checkedAt,
          checkedAt,
          `Public /health ok · authenticated tools/list pending (${message})`,
          publicHealth.mcpVersion,
          publicHealth.coreVersion,
          message,
          publicHealth.latencyMs,
          checkedAt,
          mcpId,
        )
        .run();
      await recordAuditEvent(env.DB, {
        companyId: mcp.companyId,
        eventType: "mcp.health_checked",
        actor,
        resourceType: "mcp",
        resourceId: mcpId,
        detail: {
          status: "healthy",
          source: "public_health",
          message,
          authConfigured,
          billed: false,
        },
      });
      return {
        mcpId,
        status: "healthy" as const,
        message: `Public /health ok · authenticated discovery pending`,
        latencyMs: publicHealth.latencyMs,
        checkedAt,
        authConfigured,
        mcpVersion: publicHealth.mcpVersion,
      };
    }

    await env.DB.prepare(
      `UPDATE mcp_environments
       SET status = ?, last_health_check_at = ?, health_message = ?,
           last_error = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind("unreachable", checkedAt, message, message, checkedAt, mcpId)
      .run();

    await recordAuditEvent(env.DB, {
      companyId: mcp.companyId,
      eventType: "mcp.health_checked",
      actor,
      resourceType: "mcp",
      resourceId: mcpId,
      detail: { status: "unreachable", message, authConfigured },
    });

    return {
      mcpId,
      status: "unreachable" as const,
      message,
      latencyMs: 0,
      checkedAt,
      authConfigured,
    };
  }
}

const READ_ONLY_DEFAULT_TOOLS = [
  "search_company_knowledge",
  "system_health",
  "database_summary",
  "get_knowledge_document",
] as const;

export async function executeRegisteredMcpTool(
  env: Env,
  input: {
    mcpId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    actorUserId: string;
    actorEmail: string;
    sourceClient?: string;
    skipUsageRecording?: boolean;
    correlationId?: string;
  },
) {
  const mcp = await getMcpEnvironment(env.DB, input.mcpId);
  if (!mcp) return { error: "MCP environment not found", status: 404 as const };

  const validation = validateRegisteredMcpEndpoint(
    mcp.endpointUrl,
    env.ENVIRONMENT,
  );
  if (!validation.valid) {
    return {
      error: validation.reason ?? "Invalid MCP endpoint",
      status: 400 as const,
    };
  }

  await ensureDefaultToolAllowlist(env.DB, mcp.companyId, mcp.id);

  const allow = await isToolAllowed(env.DB, mcp.id, input.toolName);
  if (!allow.allowed) {
    await recordAuditEvent(env.DB, {
      companyId: mcp.companyId,
      eventType: "permission.denied",
      actor: input.actorEmail,
      resourceType: "mcp_tool",
      resourceId: input.toolName,
      detail: { mcpId: mcp.id, reason: "tool_not_allowlisted" },
    });
    return {
      error: "Tool is not allowlisted for this MCP environment",
      status: 403 as const,
    };
  }

  const correlationId = input.correlationId ?? newId("corr");
  await recordAuditEvent(env.DB, {
    companyId: mcp.companyId,
    eventType: "mcp.execution_requested",
    actor: input.actorEmail,
    resourceType: "mcp_tool",
    resourceId: input.toolName,
    detail: {
      mcpId: mcp.id,
      correlationId,
      argumentKeys: Object.keys(input.arguments ?? {}),
    },
  });

  try {
    const execution = await callMcpTool(env, {
      endpointUrl: mcp.endpointUrl,
      authSecretRef: mcp.authSecretRef,
      serviceBindingRef: mcp.serviceBindingRef,
      toolName: input.toolName,
      arguments: input.arguments,
    });

    const checkedAt = nowIso();
    await env.DB.prepare(
      `UPDATE mcp_environments
       SET last_successful_request_at = ?, last_latency_ms = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
    )
      .bind(checkedAt, execution.latencyMs, checkedAt, mcp.id)
      .run();

    if (!input.skipUsageRecording) {
      await recordUsageEvent(env.DB, {
        companyId: mcp.companyId,
        userId: input.actorUserId,
        actorEmail: input.actorEmail,
        resourceType: "mcp_tool",
        resourceId: input.toolName,
        mcpEnvironmentId: mcp.id,
        toolName: input.toolName,
        action: input.toolName,
        riskClass: allow.riskClass,
        success: true,
        durationMs: execution.latencyMs,
        sourceClient: input.sourceClient ?? "infra-admin",
        correlationId,
        underlyingCostCents: null,
        customerChargeCents: null,
        metadata: {
          authConfigured: execution.authConfigured,
        },
      });
    }

    await recordAuditEvent(env.DB, {
      companyId: mcp.companyId,
      eventType: "mcp.execution_succeeded",
      actor: input.actorEmail,
      resourceType: "mcp_tool",
      resourceId: input.toolName,
      detail: {
        mcpId: mcp.id,
        correlationId,
        latencyMs: execution.latencyMs,
        authConfigured: execution.authConfigured,
      },
    });

    let parsedText: unknown = execution.textContent;
    if (execution.textContent) {
      try {
        parsedText = JSON.parse(execution.textContent);
      } catch {
        parsedText = execution.textContent;
      }
    }

    return {
      status: 200 as const,
      data: {
        correlationId,
        mcpId: mcp.id,
        companyId: mcp.companyId,
        toolName: input.toolName,
        latencyMs: execution.latencyMs,
        authConfigured: execution.authConfigured,
        riskClass: allow.riskClass,
        result: parsedText,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "MCP execution failed";
    const checkedAt = nowIso();

    await env.DB.prepare(
      `UPDATE mcp_environments
       SET last_error = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(message, checkedAt, mcp.id)
      .run();

    if (!input.skipUsageRecording) {
      await recordUsageEvent(env.DB, {
        companyId: mcp.companyId,
        userId: input.actorUserId,
        actorEmail: input.actorEmail,
        resourceType: "mcp_tool",
        resourceId: input.toolName,
        mcpEnvironmentId: mcp.id,
        toolName: input.toolName,
        action: input.toolName,
        riskClass: allow.riskClass,
        success: false,
        durationMs: null,
        sourceClient: input.sourceClient ?? "infra-admin",
        correlationId,
        metadata: { error: message },
      });
    }

    await recordAuditEvent(env.DB, {
      companyId: mcp.companyId,
      eventType: "mcp.execution_failed",
      actor: input.actorEmail,
      resourceType: "mcp_tool",
      resourceId: input.toolName,
      detail: { mcpId: mcp.id, correlationId, error: message },
    });

    return { status: 502 as const, error: message, correlationId };
  }
}

async function probePublicCompanyHealth(endpointUrl: string): Promise<{
  ok: boolean;
  mcpVersion: string | null;
  coreVersion: string | null;
  latencyMs: number;
}> {
  try {
    const healthUrl = new URL(endpointUrl);
    healthUrl.pathname = "/health";
    healthUrl.search = "";
    const started = Date.now();
    const response = await fetch(healthUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, mcpVersion: null, coreVersion: null, latencyMs };
    }
    const body = (await response.json()) as {
      ok?: boolean;
      mcpVersion?: string;
      coreVersion?: string;
    };
    return {
      ok: body.ok !== false,
      mcpVersion: body.mcpVersion ?? null,
      coreVersion: body.coreVersion ?? null,
      latencyMs,
    };
  } catch {
    return { ok: false, mcpVersion: null, coreVersion: null, latencyMs: 0 };
  }
}

const SAFE_READ_TOOL_NAMES = new Set([
  "system_health",
  "database_summary",
  "search_company_knowledge",
  "get_knowledge_document",
]);

export async function syncAllowlistFromRemoteTools(
  db: D1Database,
  companyId: string,
  mcpEnvironmentId: string,
  toolNames: string[],
) {
  const now = nowIso();
  for (const toolName of toolNames) {
    const riskClass = SAFE_READ_TOOL_NAMES.has(toolName)
      ? "low_risk"
      : "high_risk";
    const enabled = SAFE_READ_TOOL_NAMES.has(toolName) ? 1 : 0;
    await db
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_allowlist
          (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("allow"),
        companyId,
        mcpEnvironmentId,
        toolName,
        riskClass,
        enabled,
        now,
        now,
      )
      .run();
  }
}

export async function ensureDefaultToolAllowlist(
  db: D1Database,
  companyId: string,
  mcpEnvironmentId: string,
) {
  const now = nowIso();
  for (const toolName of READ_ONLY_DEFAULT_TOOLS) {
    const id = newId("allow");
    await db
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_allowlist
          (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
      )
      .bind(id, companyId, mcpEnvironmentId, toolName, now, now)
      .run();
  }
}

export async function getPlatformSummary(
  db: D1Database,
  companyIds?: string[],
) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [companies, mcpEnvironments, connectorInstances, auditEvents, recentUsage, denialRow] =
    await Promise.all([
      listCompanies(db, companyIds),
      listMcpEnvironments(
        db,
        companyIds?.length === 1 ? companyIds[0] : undefined,
      ),
      listConnectorInstances(
        db,
        companyIds?.length === 1 ? companyIds[0] : undefined,
      ),
      listAuditEvents(
        db,
        companyIds?.length === 1 ? companyIds[0] : undefined,
        8,
      ),
      listPlatformUsage(db, 8, {
        companyId: companyIds?.length === 1 ? companyIds[0] : undefined,
      }),
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE event_type = 'permission.denied' AND created_at >= ?`,
        )
        .bind(since)
        .first(),
    ]);

  const scopedMcp =
    companyIds && companyIds.length > 1
      ? mcpEnvironments.filter((item) => companyIds.includes(item.companyId))
      : mcpEnvironments;
  const scopedConnectors =
    companyIds && companyIds.length > 1
      ? connectorInstances.filter((item) =>
          companyIds.includes(item.companyId),
        )
      : connectorInstances;

  const healthyMcp = scopedMcp.filter((m) => m.status === "healthy").length;
  const activeConnectors = scopedConnectors.filter(
    (c) => c.status !== "disabled" && c.status !== "draft",
  ).length;

  return {
    companies: companies.length,
    mcpEnvironments: scopedMcp.length,
    healthyMcp,
    connectorInstances: scopedConnectors.length,
    activeConnectors,
    recentAuditEvents: auditEvents,
    recentUsage:
      companyIds && companyIds.length > 1
        ? recentUsage.filter((row) => companyIds.includes(row.companyId))
        : recentUsage,
    permissionDenialsLast24h: Number(denialRow?.count ?? 0),
    unhealthyMcp: scopedMcp.filter(
      (m) => m.status === "unreachable" || m.status === "degraded",
    ).length,
  };
}
