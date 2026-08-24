import { newId, nowIso } from "../db/mappers";

export interface UsageEventInput {
  companyId: string;
  userId?: string | null;
  actorEmail?: string | null;
  resourceType: string;
  resourceId?: string | null;
  mcpEnvironmentId?: string | null;
  connectorInstanceId?: string | null;
  toolName?: string | null;
  action?: string | null;
  riskClass?: string | null;
  quantity?: number;
  unit?: string;
  success?: boolean;
  durationMs?: number | null;
  sourceClient?: string | null;
  correlationId?: string | null;
  underlyingCostCents?: number | null;
  customerChargeCents?: number | null;
  metadata?: Record<string, unknown>;
}

export async function recordUsageEvent(db: D1Database, input: UsageEventInput) {
  const id = newId("usage");
  const recordedAt = nowIso();

  await db
    .prepare(
      `INSERT INTO usage_records (
        id, company_id, resource_type, resource_id, quantity, unit, recorded_at, metadata_json,
        user_id, actor_email, mcp_environment_id, connector_instance_id, tool_name, action,
        risk_class, success, duration_ms, source_client, correlation_id,
        underlying_cost_cents, customer_charge_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.resourceType,
      input.resourceId ?? null,
      input.quantity ?? 1,
      input.unit ?? "request",
      recordedAt,
      JSON.stringify(input.metadata ?? {}),
      input.userId ?? null,
      input.actorEmail ?? null,
      input.mcpEnvironmentId ?? null,
      input.connectorInstanceId ?? null,
      input.toolName ?? null,
      input.action ?? null,
      input.riskClass ?? null,
      input.success === false ? 0 : 1,
      input.durationMs ?? null,
      input.sourceClient ?? null,
      input.correlationId ?? null,
      input.underlyingCostCents ?? null,
      input.customerChargeCents ?? null,
    )
    .run();

  return { id, recordedAt };
}

export async function listUsageRecords(
  db: D1Database,
  companyId: string,
  limit = 50,
) {
  const result = await db
    .prepare(
      `SELECT * FROM usage_records
       WHERE company_id = ?
       ORDER BY recorded_at DESC
       LIMIT ?`,
    )
    .bind(companyId, limit)
    .all();

  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ? String(row.resource_id) : null,
    quantity: Number(row.quantity),
    unit: String(row.unit),
    recordedAt: String(row.recorded_at),
    metadata: (() => {
      try {
        return JSON.parse(String(row.metadata_json ?? "{}")) as Record<
          string,
          unknown
        >;
      } catch {
        return {};
      }
    })(),
    userId: row.user_id ? String(row.user_id) : null,
    actorEmail: row.actor_email ? String(row.actor_email) : null,
    mcpEnvironmentId: row.mcp_environment_id
      ? String(row.mcp_environment_id)
      : null,
    connectorInstanceId: row.connector_instance_id
      ? String(row.connector_instance_id)
      : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    action: row.action ? String(row.action) : null,
    riskClass: row.risk_class ? String(row.risk_class) : null,
    success: Boolean(row.success),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    sourceClient: row.source_client ? String(row.source_client) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    underlyingCostCents:
      row.underlying_cost_cents == null
        ? null
        : Number(row.underlying_cost_cents),
    customerChargeCents:
      row.customer_charge_cents == null
        ? null
        : Number(row.customer_charge_cents),
  }));
}

export async function getUsageSummary(db: D1Database, companyId: string) {
  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  const [today, month, success, failed] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_records
         WHERE company_id = ? AND recorded_at >= ?`,
      )
      .bind(companyId, startOfDay)
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_records
         WHERE company_id = ? AND recorded_at >= ?`,
      )
      .bind(companyId, startOfMonth)
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_records
         WHERE company_id = ? AND recorded_at >= ? AND success = 1`,
      )
      .bind(companyId, startOfMonth)
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_records
         WHERE company_id = ? AND recorded_at >= ? AND success = 0`,
      )
      .bind(companyId, startOfMonth)
      .first(),
  ]);

  return {
    requestsToday: Number(today?.count ?? 0),
    requestsThisMonth: Number(month?.count ?? 0),
    successfulThisMonth: Number(success?.count ?? 0),
    failedThisMonth: Number(failed?.count ?? 0),
  };
}
