import type { UsageRecord } from "@infra/shared";
import { newId } from "../db/mappers";

const CHATGPT_REUSED_RPC_ID = "0";
const TRUSTED_INTERACTION_ID = /^(int|pint|creq)_[a-zA-Z0-9_-]{6,128}$/;

export interface InteractionResolution {
  interactionId: string;
  parentRequestId: string | null;
  mcpSessionId: string | null;
  sourcedFrom: "client" | "generated";
  clientInteractionRef: string | null;
}

/**
 * Authoritative interaction IDs are generated server-side.
 *
 * JSON-RPC `id` is never used: ChatGPT reuses `id = 0`.
 * Time-proximity grouping is never used: concurrent prompts must not merge.
 *
 * A client-supplied `int_*` value (header or `_meta`) is preserved and used
 * to group operations. Any other string is kept as metadata only.
 * If nothing trustworthy is supplied, each operation is its own interaction.
 */
export function resolveInteractionIds(input: {
  headerInteractionId?: string | null;
  metaInteractionId?: string | null;
  bodyInteractionId?: string | null;
  interactionId?: string | null;
  parentRequestId?: string | null;
  mcpSessionId?: string | null;
}): InteractionResolution {
  const supplied =
    cleanId(input.headerInteractionId) ??
    cleanId(input.metaInteractionId) ??
    cleanId(input.bodyInteractionId) ??
    cleanId(input.interactionId);

  const trusted = supplied && TRUSTED_INTERACTION_ID.test(supplied) ? supplied : null;

  return {
    interactionId: trusted ?? newId("int"),
    parentRequestId: cleanId(input.parentRequestId),
    mcpSessionId: cleanId(input.mcpSessionId),
    sourcedFrom: trusted ? "client" : "generated",
    clientInteractionRef: supplied,
  };
}

export function sanitizeInteractionId(value: unknown): string | null {
  const cleaned = cleanId(typeof value === "string" ? value : null);
  if (!cleaned || !TRUSTED_INTERACTION_ID.test(cleaned)) return null;
  return cleaned;
}

function cleanId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (trimmed === CHATGPT_REUSED_RPC_ID) return null;
  return trimmed;
}

/**
 * Billing idempotency is per operation, never per JSON-RPC id.
 * Same client request id → same operation. Different tools in one
 * interaction must use different operation keys.
 */
export function operationIdempotencyKey(input: {
  companyId: string;
  clientRequestId?: string | null;
  requestId: string;
}): string {
  const explicit = cleanId(input.clientRequestId);
  return `op:${input.companyId}:${explicit ?? input.requestId}`;
}

export function labelForOperation(operation: string): string {
  switch (operation) {
    case "knowledge.search":
    case "search_company_knowledge":
    case "search":
      return "Knowledge Search";
    case "knowledge.read":
    case "get_knowledge_document":
    case "fetch":
      return "Knowledge Document Read";
    case "system.health":
    case "system_health":
      return "Connection check";
    case "database_summary":
      return "Business data summary";
    case "customer.request":
      return "Customer request";
    default:
      return operation.replace(/[._]/g, " ");
  }
}

export function clientKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "chatgpt":
      return "ChatGPT";
    case "claude":
      return "Claude";
    case "whatsapp":
      return "WhatsApp";
    case "service":
      return "Service identity";
    case "internal":
    case "infra-gateway":
    case "infra-mcp":
      return "Internal";
    default:
      return kind?.trim() ? kind : "Unknown";
  }
}

export function labelInteraction(records: UsageRecord[]): string {
  if (records.length === 0) return "AI request";
  const operations = records
    .filter((r) => (r.action ?? r.toolName) !== "customer.request")
    .map((r) => r.action ?? r.toolName ?? "");
  if (operations.length === 0) return "Customer request";
  const onlyKnowledge =
    operations.length > 0 &&
    operations.every(
      (op) =>
        op.startsWith("knowledge.") ||
        op === "search_company_knowledge" ||
        op === "get_knowledge_document" ||
        op === "search" ||
        op === "fetch",
    );
  if (onlyKnowledge) {
    return records.length === 1
      ? labelForOperation(operations[0]!)
      : "AI Knowledge Request";
  }
  if (records.length === 1) {
    return labelForOperation(operations[0]!);
  }
  return "AI request";
}

export interface UsageInteractionView {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  clientKind: string;
  mcpId: string | null;
  mcpSessionId: string | null;
  label: string;
  status: "completed" | "error" | "denied";
  currency: string;
  operationCount: number;
  customerChargeCents: number;
  providerCostCents: number | null;
  providerCostKnown: boolean;
  createdAt: string;
  updatedAt: string;
  operations: UsageRecord[];
}

/**
 * Group usage records only when they share a persisted interaction_id.
 * Distinct or missing IDs stay separate. Never groups by time or prompt.
 */
export function groupOperationsIntoInteractions(
  records: UsageRecord[],
): UsageInteractionView[] {
  const groups = new Map<string, UsageRecord[]>();
  const order: string[] = [];

  for (const record of records) {
    const key = record.parentRequestId
      ? `parent:${record.parentRequestId}`
      : record.interactionId ?? `ungrouped:${record.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(record);
  }

  return order.map((key) => {
    const operations = groups.get(key)!;
    const first = operations[0]!;
    const charge = operations.reduce(
      (sum, r) => sum + (r.customerChargeCents ?? 0),
      0,
    );
    const known = operations.filter(
      (r) =>
        r.costBasis === "actual" &&
        (r.underlyingCostCents != null || r.underlyingCostMicros != null),
    );
    const providerKnown = known.length === operations.length && operations.length > 0;
    const providerCost = providerKnown
      ? known.reduce((sum, r) => sum + (r.underlyingCostCents ?? 0), 0)
      : null;
    const denied = operations.some(
      (r) =>
        r.settlementStatus === "denied" ||
        (r.metadata && (r.metadata as { denied?: boolean }).denied === true),
    );
    const failed = operations.some((r) => r.success === false);
    const last = operations[operations.length - 1]!;

    return {
      id: first.parentRequestId ?? first.interactionId ?? first.id,
      companyId: first.companyId,
      actorType: first.userId ? "user" : "service",
      actorId: first.userId ?? null,
      actorLabel: first.actorEmail ?? null,
      clientKind: first.sourceClient ?? "unknown",
      mcpId: first.mcpEnvironmentId ?? null,
      mcpSessionId: first.mcpSessionId ?? null,
      label: labelInteraction(operations),
      status: denied ? "denied" : failed ? "error" : "completed",
      currency: "GBP",
      operationCount: operations.length,
      customerChargeCents: charge,
      providerCostCents: providerCost,
      providerCostKnown: providerKnown,
      createdAt: first.recordedAt,
      updatedAt: last.recordedAt,
      operations,
    };
  });
}

export interface LedgerChargeGroup {
  id: string;
  kind: "interaction" | "entry";
  label: string;
  amountCents: number;
  createdAt: string;
  entries: Array<{
    id: string;
    description: string | null;
    amountCents: number;
    createdAt: string;
  }>;
}

export function groupLedgerCharges<
  T extends {
    id: string;
    entryType: string;
    amountCents: number;
    description: string | null;
    createdAt: string;
    metadata?: Record<string, unknown>;
  },
>(entries: T[]): LedgerChargeGroup[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];

  for (const entry of entries) {
    const interactionId =
      entry.entryType === "usage_debit" &&
      typeof entry.metadata?.interactionId === "string"
        ? sanitizeInteractionId(entry.metadata.interactionId)
        : null;
    const key = interactionId ?? `entry:${entry.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(entry);
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const first = group[0]!;
    const amount = group.reduce((sum, e) => sum + e.amountCents, 0);
    const isGroup = !key.startsWith("entry:") && group.length > 1;
    return {
      id: key,
      kind: isGroup ? "interaction" : "entry",
      label: isGroup
        ? "AI Knowledge Request"
        : (first.description ?? "Usage charge"),
      amountCents: amount,
      createdAt: first.createdAt,
      entries: group.map((e) => ({
        id: e.id,
        description: e.description,
        amountCents: e.amountCents,
        createdAt: e.createdAt,
      })),
    };
  });
}

export async function persistInteraction(
  db: D1Database,
  input: {
    id: string;
    companyId: string;
    actorType: string;
    actorId: string;
    clientKind: string;
    mcpId?: string | null;
    mcpSessionId?: string | null;
    label: string;
    sourcedFrom?: "client" | "generated";
    currency?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO interactions (
         id, company_id, actor_type, actor_id, client_kind, mcp_id, mcp_session_id,
         label, status, currency, operation_count, customer_charge_cents,
         provider_cost_cents, provider_cost_known, sourced_from, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0, 0, NULL, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         mcp_session_id = COALESCE(excluded.mcp_session_id, interactions.mcp_session_id)`,
    )
    .bind(
      input.id,
      input.companyId,
      input.actorType,
      input.actorId,
      input.clientKind,
      input.mcpId ?? null,
      input.mcpSessionId ?? null,
      input.label,
      input.currency ?? "GBP",
      input.sourcedFrom ?? "generated",
      now,
      now,
    )
    .run();
}

export async function refreshInteractionTotals(
  db: D1Database,
  interactionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT action, tool_name, customer_charge_cents, underlying_cost_cents,
              cost_basis, success, recorded_at
       FROM usage_records WHERE interaction_id = ? ORDER BY recorded_at ASC`,
    )
    .bind(interactionId)
    .all<{
      action: string | null;
      tool_name: string | null;
      customer_charge_cents: number | null;
      underlying_cost_cents: number | null;
      cost_basis: string | null;
      success: number;
      recorded_at: string;
    }>();

  const records = (rows.results ?? []).map((r) => ({
    id: "",
    companyId: "",
    resourceType: "gateway",
    resourceId: null,
    quantity: 1,
    unit: "request",
    recordedAt: r.recorded_at,
    metadata: {},
    action: r.action,
    toolName: r.tool_name,
    customerChargeCents: Number(r.customer_charge_cents ?? 0),
    underlyingCostCents: r.underlying_cost_cents,
    costBasis: r.cost_basis,
    success: Number(r.success) === 1,
  })) as UsageRecord[];

  const charge = records.reduce((sum, r) => sum + (r.customerChargeCents ?? 0), 0);
  const known = records.filter(
    (r) => r.costBasis === "actual" && r.underlyingCostCents != null,
  );
  const providerKnown = known.length === records.length && records.length > 0 ? 1 : 0;
  const providerCost = providerKnown
    ? known.reduce((sum, r) => sum + (r.underlyingCostCents ?? 0), 0)
    : null;
  const failed = records.some((r) => r.success === false);

  await db
    .prepare(
      `UPDATE interactions SET
         label = ?,
         status = ?,
         operation_count = ?,
         customer_charge_cents = ?,
         provider_cost_cents = ?,
         provider_cost_known = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      labelInteraction(records),
      failed ? "error" : records.length > 0 ? "completed" : "open",
      records.length,
      charge,
      providerCost,
      providerKnown,
      now,
      interactionId,
    )
    .run();
}
