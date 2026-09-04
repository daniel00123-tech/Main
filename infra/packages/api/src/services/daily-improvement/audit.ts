import { newId, nowIso } from "../../db/mappers";
import type { Env } from "../../env";
import { CUSTOMER_TRAFFIC_CLASS, NON_CUSTOMER_TRAFFIC } from "./constants";
import { evidenceRefsOnly, stripSecrets } from "./redact";
import { upsertInteraction } from "./store";
import type { DailyImprovementInteraction } from "./types";

export function isGenuineCustomerTraffic(trafficClass?: string | null): boolean {
  if (!trafficClass) return true;
  return !NON_CUSTOMER_TRAFFIC.has(trafficClass.toUpperCase());
}

export function channelFromSourceClient(sourceClient?: string | null): string {
  const value = String(sourceClient ?? "").toLowerCase();
  if (value.includes("whatsapp")) return "whatsapp";
  if (value.includes("portal")) return "portal_chat";
  if (value.includes("chatgpt")) return "chatgpt";
  if (value.includes("claude")) return "claude";
  return value || "unknown";
}

export async function recordDailyImprovementInteraction(
  db: D1Database,
  input: Partial<DailyImprovementInteraction> & {
    interactionId: string;
    companyId: string;
    channel: string;
  },
): Promise<void> {
  if (!isGenuineCustomerTraffic(input.trafficClass)) return;
  const row: DailyImprovementInteraction = {
    id: input.id ?? newId("dii"),
    interactionId: input.interactionId,
    customerRequestId: input.customerRequestId ?? input.interactionId,
    companyId: input.companyId,
    userId: input.userId ?? null,
    role: input.role ?? null,
    channel: input.channel,
    conversationId: input.conversationId ?? null,
    createdAt: input.createdAt ?? nowIso(),
    userMessage: stripSecrets(input.userMessage ?? null),
    provider: input.provider ?? null,
    model: input.model ?? null,
    providerMode: input.providerMode ?? null,
    availableCapabilities: input.availableCapabilities ?? [],
    toolsRequested: input.toolsRequested ?? [],
    toolsExecuted: input.toolsExecuted ?? [],
    evidenceRefs: evidenceRefsOnly(input.evidenceRefs),
    assistantAnswer: stripSecrets(input.assistantAnswer ?? null),
    terminalState: input.terminalState ?? null,
    latencyMs: input.latencyMs ?? null,
    customerChargeCents: input.customerChargeCents ?? 0,
    providerCostCents: input.providerCostCents ?? null,
    qualityResult: input.qualityResult ?? null,
    correlationId: input.correlationId ?? null,
    trafficClass: input.trafficClass ?? CUSTOMER_TRAFFIC_CLASS,
    sourceClient: input.sourceClient ?? input.channel,
  };
  await upsertInteraction(db, row);
}

export function scheduleDailyImprovementCapture(
  env: Pick<Env, "DB">,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  input: Parameters<typeof recordDailyImprovementInteraction>[1],
): void {
  try {
    const work = recordDailyImprovementInteraction(env.DB, input).catch(() => undefined);
    if (waitUntil) waitUntil(work);
  } catch {
    /* Audit must never fail a customer turn. */
  }
}

export async function backfillRecentCustomerInteractions(
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<number> {
  let stored = 0;
  stored += await backfillPortal(db, fromIso, toIso);
  stored += await backfillUsageParents(db, fromIso, toIso);
  return stored;
}

async function backfillPortal(db: D1Database, fromIso: string, toIso: string): Promise<number> {
  let stored = 0;
  try {
    const users = await db
      .prepare(
        `SELECT id, conversation_id, company_id, user_id, content, created_at
         FROM portal_conversation_messages
         WHERE role = 'user' AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC LIMIT 400`,
      )
      .bind(fromIso, toIso)
      .all<Record<string, unknown>>();
    for (const user of users.results ?? []) {
      const assistant = await db
        .prepare(
          `SELECT content, created_at FROM portal_conversation_messages
           WHERE conversation_id = ? AND company_id = ? AND role = 'assistant' AND created_at >= ?
           ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(String(user.conversation_id), String(user.company_id), String(user.created_at))
        .first<{ content: string; created_at: string }>();
      await recordDailyImprovementInteraction(db, {
        interactionId: String(user.id),
        companyId: String(user.company_id),
        userId: user.user_id ? String(user.user_id) : null,
        channel: "portal_chat",
        conversationId: String(user.conversation_id),
        createdAt: String(user.created_at),
        userMessage: String(user.content ?? ""),
        assistantAnswer: assistant?.content ?? null,
        terminalState: assistant ? "ANSWER" : "NO_FINAL_RESPONSE",
        trafficClass: CUSTOMER_TRAFFIC_CLASS,
        sourceClient: "portal_chat",
      });
      stored += 1;
    }
  } catch {
    return stored;
  }
  return stored;
}

async function backfillUsageParents(db: D1Database, fromIso: string, toIso: string): Promise<number> {
  let stored = 0;
  try {
    const rows = await db
      .prepare(
        `SELECT interaction_id, company_id, user_id, source_client, tool_name, action,
                duration_ms, customer_charge_cents, underlying_cost_cents, correlation_id,
                recorded_at, metadata
         FROM usage_records
         WHERE recorded_at >= ? AND recorded_at < ?
           AND interaction_id IS NOT NULL
           AND source_client IN ('whatsapp','portal_chat','chatgpt','claude')
         ORDER BY recorded_at ASC LIMIT 800`,
      )
      .bind(fromIso, toIso)
      .all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const meta = safeMeta(row.metadata);
      const trafficClass = String(meta.trafficClass ?? CUSTOMER_TRAFFIC_CLASS);
      if (!isGenuineCustomerTraffic(trafficClass)) continue;
      await recordDailyImprovementInteraction(db, {
        interactionId: String(row.interaction_id),
        companyId: String(row.company_id),
        userId: row.user_id ? String(row.user_id) : null,
        channel: channelFromSourceClient(String(row.source_client ?? meta.channel ?? "")),
        conversationId: typeof meta.conversationId === "string" ? meta.conversationId : null,
        createdAt: String(row.recorded_at),
        toolsExecuted: row.tool_name ? [String(row.tool_name)] : [],
        toolsRequested: row.tool_name ? [String(row.tool_name)] : [],
        latencyMs: row.duration_ms != null ? Number(row.duration_ms) : null,
        customerChargeCents: Number(row.customer_charge_cents ?? 0),
        providerCostCents: row.underlying_cost_cents != null ? Number(row.underlying_cost_cents) : null,
        correlationId: row.correlation_id ? String(row.correlation_id) : null,
        terminalState: typeof meta.outcome === "string" ? meta.outcome : null,
        userMessage: typeof meta.summary === "string" ? meta.summary : null,
        trafficClass,
        sourceClient: String(row.source_client ?? ""),
      });
      stored += 1;
    }
  } catch {
    return stored;
  }
  return stored;
}

function safeMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
