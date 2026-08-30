import type { UsageBreakdownRow } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { redactSecretFields } from "./secrets";
import type { ChargeResult, CostBasis } from "./pricing";
import {
  accumulateBreakdown,
  connectorFamilyFromAction,
} from "./usage-attribution";

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
  requestId?: string | null;
  interactionId?: string | null;
  parentRequestId?: string | null;
  mcpSessionId?: string | null;
  underlyingCostCents?: number | null;
  customerChargeCents?: number | null;
  charge?: ChargeResult | null;
  ledgerEntryId?: string | null;
  settlementStatus?: string | null;
  metadata?: Record<string, unknown>;
}

export async function getUsageByRequestId(db: D1Database, requestId: string) {
  const row = await db
    .prepare(`SELECT * FROM usage_records WHERE request_id = ? LIMIT 1`)
    .bind(requestId)
    .first();
  return row ? mapUsageRow(row) : null;
}

export async function getUsageByCorrelationId(
  db: D1Database,
  correlationId: string,
) {
  const row = await db
    .prepare(`SELECT * FROM usage_records WHERE correlation_id = ? LIMIT 1`)
    .bind(correlationId)
    .first();
  return row ? mapUsageRow(row) : null;
}

export async function recordUsageEvent(db: D1Database, input: UsageEventInput) {
  if (input.requestId) {
    const existing = await getUsageByRequestId(db, input.requestId);
    if (existing) return { ...existing, alreadyExists: true as const };
  }
  if (input.correlationId) {
    const existing = await getUsageByCorrelationId(db, input.correlationId);
    if (existing) return { ...existing, alreadyExists: true as const };
  }

  const id = newId("usage");
  const recordedAt = nowIso();
  const charge = input.charge;
  const costBasis: CostBasis = charge?.costBasis ?? "unknown";
  const settlement =
    input.settlementStatus ??
    (input.customerChargeCents || charge?.customerChargeCents
      ? "unsettled"
      : "zero_charge");

  try {
    await db
      .prepare(
        `INSERT INTO usage_records (
          id, company_id, resource_type, resource_id, quantity, unit, recorded_at, metadata_json,
          user_id, actor_email, mcp_environment_id, connector_instance_id, tool_name, action,
          risk_class, success, duration_ms, source_client, correlation_id,
          underlying_cost_cents, customer_charge_cents,
          request_id, cost_basis, estimated_cost_micros, underlying_cost_micros,
          pricing_rule_id, rate_card_id, rate_card_version, target_margin_bps,
          calculated_selling_cents, minimum_charge_applied, gross_profit_cents,
          actual_margin_bps, ledger_entry_id, settlement_status,
          interaction_id, parent_request_id, mcp_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.companyId,
        input.resourceType,
        input.resourceId ?? null,
        input.quantity ?? 1,
        input.unit ?? "request",
        recordedAt,
        JSON.stringify(redactSecretFields(input.metadata ?? {})),
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
        charge?.underlyingCostCents ?? input.underlyingCostCents ?? null,
        charge?.customerChargeCents ?? input.customerChargeCents ?? null,
        input.requestId ?? null,
        costBasis,
        charge?.estimatedCostMicros ?? null,
        charge?.underlyingCostMicros ?? null,
        charge?.pricingRuleId ?? null,
        charge?.rateCardId ?? null,
        charge?.rateCardVersion ?? null,
        charge?.targetMarginBps ?? null,
        charge?.calculatedSellingCents ?? null,
        charge?.minimumChargeApplied ? 1 : 0,
        charge?.grossProfitCents ?? null,
        charge?.actualMarginBps ?? null,
        input.ledgerEntryId ?? null,
        settlement,
        input.interactionId ?? null,
        input.parentRequestId ?? null,
        input.mcpSessionId ?? null,
      )
      .run();
  } catch (err) {
    // Race on unique request/correlation — return existing
    if (input.requestId) {
      const existing = await getUsageByRequestId(db, input.requestId);
      if (existing) return { ...existing, alreadyExists: true as const };
    }
    if (input.correlationId) {
      const existing = await getUsageByCorrelationId(db, input.correlationId);
      if (existing) return { ...existing, alreadyExists: true as const };
    }
    throw err;
  }

  return {
    id,
    recordedAt,
    alreadyExists: false as const,
    settlementStatus: settlement,
  };
}

export async function markUsageSettled(
  db: D1Database,
  usageId: string,
  ledgerEntryId: string,
) {
  await db
    .prepare(
      `UPDATE usage_records
       SET settlement_status = 'settled', ledger_entry_id = ?
       WHERE id = ?`,
    )
    .bind(ledgerEntryId, usageId)
    .run();
}

function mapUsageRow(row: Record<string, unknown>) {
  return {
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
    requestId: row.request_id ? String(row.request_id) : null,
    underlyingCostCents:
      row.underlying_cost_cents == null
        ? null
        : Number(row.underlying_cost_cents),
    customerChargeCents:
      row.customer_charge_cents == null
        ? null
        : Number(row.customer_charge_cents),
    costBasis: (row.cost_basis ? String(row.cost_basis) : "unknown") as CostBasis,
    underlyingCostMicros:
      row.underlying_cost_micros == null
        ? null
        : Number(row.underlying_cost_micros),
    estimatedCostMicros:
      row.estimated_cost_micros == null
        ? null
        : Number(row.estimated_cost_micros),
    pricingRuleId: row.pricing_rule_id ? String(row.pricing_rule_id) : null,
    rateCardId: row.rate_card_id ? String(row.rate_card_id) : null,
    rateCardVersion: row.rate_card_version
      ? String(row.rate_card_version)
      : null,
    targetMarginBps:
      row.target_margin_bps == null ? null : Number(row.target_margin_bps),
    calculatedSellingCents:
      row.calculated_selling_cents == null
        ? null
        : Number(row.calculated_selling_cents),
    minimumChargeApplied: Boolean(row.minimum_charge_applied),
    grossProfitCents:
      row.gross_profit_cents == null ? null : Number(row.gross_profit_cents),
    actualMarginBps:
      row.actual_margin_bps == null ? null : Number(row.actual_margin_bps),
    ledgerEntryId: row.ledger_entry_id ? String(row.ledger_entry_id) : null,
    settlementStatus: String(row.settlement_status ?? "unsettled"),
    interactionId: row.interaction_id ? String(row.interaction_id) : null,
    parentRequestId: row.parent_request_id
      ? String(row.parent_request_id)
      : null,
    mcpSessionId: row.mcp_session_id ? String(row.mcp_session_id) : null,
  };
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

  return (result.results ?? []).map((row) => mapUsageRow(row));
}

export async function listPlatformUsage(
  db: D1Database,
  limit = 100,
  filters?: {
    companyId?: string;
    sourceClient?: string;
    success?: boolean;
  },
) {
  const clauses = ["1=1"];
  const binds: unknown[] = [];
  if (filters?.companyId) {
    clauses.push("company_id = ?");
    binds.push(filters.companyId);
  }
  if (filters?.sourceClient) {
    clauses.push("source_client = ?");
    binds.push(filters.sourceClient);
  }
  if (filters?.success === true) {
    clauses.push("success = 1");
  } else if (filters?.success === false) {
    clauses.push("success = 0");
  }
  binds.push(limit);

  const result = await db
    .prepare(
      `SELECT * FROM usage_records
       WHERE ${clauses.join(" AND ")}
       ORDER BY recorded_at DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all();

  return (result.results ?? []).map((row) => mapUsageRow(row));
}

export async function getUsageCommercialSummary(
  db: D1Database,
  companyId?: string,
) {
  const clause = companyId ? "WHERE company_id = ?" : "";
  const binds = companyId ? [companyId] : [];
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS requests,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(customer_charge_cents), 0) AS customer_charges,
         SUM(CASE WHEN cost_basis = 'actual' THEN underlying_cost_cents ELSE NULL END) AS underlying_costs,
         SUM(CASE WHEN cost_basis = 'actual' THEN 1 ELSE 0 END) AS costs_known,
         SUM(CASE
           WHEN cost_basis = 'actual' AND underlying_cost_cents IS NOT NULL
             THEN COALESCE(customer_charge_cents, 0) - underlying_cost_cents
           ELSE NULL
         END) AS gross_profit
       FROM usage_records ${clause}`,
    )
    .bind(...binds)
    .first();

  const charges = Number(row?.customer_charges ?? 0);
  const costsKnown = Number(row?.costs_known ?? 0) > 0;
  const costs = costsKnown && row?.underlying_costs != null ? Number(row.underlying_costs) : null;
  const profit =
    costsKnown && row?.gross_profit != null ? Number(row.gross_profit) : null;
  return {
    requests: Number(row?.requests ?? 0),
    successful: Number(row?.successful ?? 0),
    failed: Number(row?.failed ?? 0),
    customerChargesCents: charges,
    underlyingCostsCents: costs,
    providerCostKnown: costsKnown,
    grossProfitCents: profit,
    grossMarginBps:
      charges > 0 && profit != null ? Math.round((profit * 10_000) / charges) : null,
  };
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

  let breakdowns = {
    deniedThisMonth: 0,
    billableThisMonth: 0,
    nonBillableThisMonth: 0,
    chargeCentsThisMonth: 0,
    byUser: [] as import("@infra/shared").UsageBreakdownRow[],
    byChannel: [] as import("@infra/shared").UsageBreakdownRow[],
    byConnector: [] as import("@infra/shared").UsageBreakdownRow[],
    byTool: [] as import("@infra/shared").UsageBreakdownRow[],
  };
  try {
    breakdowns = await getUsageBreakdowns(db, companyId, startOfMonth);
  } catch {
    // Older test doubles and pre-rollup queries still return the core counts.
  }

  return {
    requestsToday: Number(today?.count ?? 0),
    requestsThisMonth: Number(month?.count ?? 0),
    successfulThisMonth: Number(success?.count ?? 0),
    failedThisMonth: Number(failed?.count ?? 0),
    ...breakdowns,
  };
}

export async function getUsageBreakdowns(
  db: D1Database,
  companyId: string,
  sinceIso: string,
) {
  const result = await db
    .prepare(
      `SELECT user_id, actor_email, source_client, tool_name, action, success,
              settlement_status, customer_charge_cents, metadata_json
       FROM usage_records
       WHERE company_id = ? AND recorded_at >= ?`,
    )
    .bind(companyId, sinceIso)
    .all();

  const byUser = new Map<string, UsageBreakdownRow>();
  const byChannel = new Map<string, UsageBreakdownRow>();
  const byConnector = new Map<string, UsageBreakdownRow>();
  const byTool = new Map<string, UsageBreakdownRow>();
  let deniedThisMonth = 0;
  let billableThisMonth = 0;
  let nonBillableThisMonth = 0;
  let chargeCentsThisMonth = 0;

  for (const row of result.results ?? []) {
    const metadata = (() => {
      try {
        return JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const denied =
      String(row.settlement_status ?? "") === "denied" || metadata.denied === true;
    const charge = Number(row.customer_charge_cents ?? 0);
    const billable = charge > 0 && !denied;
    if (denied) deniedThisMonth += 1;
    if (billable) billableThisMonth += 1;
    else nonBillableThisMonth += 1;
    chargeCentsThisMonth += charge;

    const stats = {
      success: Number(row.success) === 1,
      denied,
      billable,
      chargeCents: charge,
    };
    const userKey = row.user_id ? String(row.user_id) : "unattributed";
    const userLabel = row.actor_email
      ? String(row.actor_email)
      : row.user_id
        ? String(row.user_id)
        : "Unattributed / service";
    accumulateBreakdown(byUser, userKey, userLabel, stats);
    const channel = String(row.source_client ?? "unknown");
    accumulateBreakdown(byChannel, channel, channel, stats);
    const connector = connectorFamilyFromAction(
      row.action ? String(row.action) : null,
      row.tool_name ? String(row.tool_name) : null,
    );
    accumulateBreakdown(byConnector, connector, connector, stats);
    const tool = String(row.tool_name ?? row.action ?? "unknown");
    accumulateBreakdown(byTool, tool, tool, stats);
  }

  const sortRows = (rows: UsageBreakdownRow[]) =>
    rows.sort((a, b) => b.requests - a.requests);

  return {
    deniedThisMonth,
    billableThisMonth,
    nonBillableThisMonth,
    chargeCentsThisMonth,
    byUser: sortRows([...byUser.values()]),
    byChannel: sortRows([...byChannel.values()]),
    byConnector: sortRows([...byConnector.values()]),
    byTool: sortRows([...byTool.values()]),
  };
}
