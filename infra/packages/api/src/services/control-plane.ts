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

export async function listCompanies(db: D1Database) {
  const result = await db
    .prepare("SELECT * FROM companies ORDER BY name ASC")
    .all();
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

  const [mcpEnvironments, connectorInstances, creditBalance, recentAuditEvents] =
    await Promise.all([
      listMcpEnvironments(db, companyId),
      listConnectorInstances(db, companyId),
      getCreditBalance(db, companyId),
      listAuditEvents(db, companyId, 10),
    ]);

  return {
    company,
    mcpEnvironments,
    connectorInstances,
    creditBalance,
    recentAuditEvents,
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

export async function checkMcpHealth(
  endpointUrl: string,
): Promise<McpHealthResult> {
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

export async function runMcpHealthCheck(env: Env, mcpId: string) {
  const mcp = await getMcpEnvironment(env.DB, mcpId);
  if (!mcp) return null;

  const result = await checkMcpHealth(mcp.endpointUrl);
  const checkedAt = nowIso();
  const status =
    result.status === "healthy"
      ? "healthy"
      : result.status === "degraded"
        ? "degraded"
        : "unreachable";

  await env.DB.prepare(
    `UPDATE mcp_environments
     SET status = ?, last_health_check_at = ?, last_healthy_at = ?, health_message = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      status,
      checkedAt,
      result.status === "healthy" ? checkedAt : mcp.lastHealthyAt,
      result.message,
      checkedAt,
      mcpId,
    )
    .run();

  await recordAuditEvent(env.DB, {
    companyId: mcp.companyId,
    eventType: "mcp.health_checked",
    actor: "infra-system",
    resourceType: "mcp",
    resourceId: mcpId,
    detail: {
      status,
      latencyMs: result.latencyMs,
      message: result.message,
    },
  });

  return {
    mcpId,
    ...result,
    status,
    checkedAt,
  };
}

export async function getPlatformSummary(db: D1Database) {
  const [companies, mcpEnvironments, connectorInstances, auditEvents] =
    await Promise.all([
      listCompanies(db),
      listMcpEnvironments(db),
      listConnectorInstances(db),
      listAuditEvents(db, undefined, 5),
    ]);

  const healthyMcp = mcpEnvironments.filter((m) => m.status === "healthy").length;
  const activeConnectors = connectorInstances.filter(
    (c) => c.status !== "disabled" && c.status !== "draft",
  ).length;

  return {
    companies: companies.length,
    mcpEnvironments: mcpEnvironments.length,
    healthyMcp,
    connectorInstances: connectorInstances.length,
    activeConnectors,
    recentAuditEvents: auditEvents,
  };
}
