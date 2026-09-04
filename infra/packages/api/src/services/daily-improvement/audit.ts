import { newId, nowIso } from "../../db/mappers";
import { CUSTOMER_TRAFFIC_CLASS } from "./constants";
import { evidenceRefsOnly, stripSecrets } from "./redact";
import { upsertInteraction } from "./store";
import { classifyDailyTraffic, isGenuineCustomerTraffic } from "./traffic";
import type { DailyImprovementInteraction } from "./types";

export { isGenuineCustomerTraffic } from "./traffic";

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
    userAgent?: string | null;
    actorEmail?: string | null;
    wamid?: string | null;
  },
): Promise<void> {
  const trafficClass = classifyDailyTraffic({
    trafficClass: input.trafficClass,
    sourceClient: input.sourceClient ?? input.channel,
    userAgent: input.userAgent,
    actorEmail: input.actorEmail,
    userId: input.userId,
    userMessage: input.userMessage,
    customerChargeCents: input.customerChargeCents,
    providerMode: input.providerMode,
    correlationId: input.correlationId,
    wamid: input.wamid,
  });
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
    trafficClass,
    sourceClient: input.sourceClient ?? input.channel,
  };
  await upsertInteraction(db, row);
}

export function scheduleDailyImprovementCapture(
  env: Pick<{ DB: D1Database }, "DB">,
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

export async function reclassifyStoredInteractions(
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT interaction_id, user_message, source_client, traffic_class, customer_charge_cents, correlation_id, provider_mode, user_id
       FROM daily_improvement_interactions
       WHERE created_at >= ? AND created_at < ?`,
    )
    .bind(fromIso, toIso)
    .all<Record<string, unknown>>();
  let updated = 0;
  for (const row of rows.results ?? []) {
    const next = classifyDailyTraffic({
      trafficClass: row.traffic_class ? String(row.traffic_class) : null,
      sourceClient: row.source_client ? String(row.source_client) : null,
      userMessage: row.user_message ? String(row.user_message) : null,
      customerChargeCents: row.customer_charge_cents != null ? Number(row.customer_charge_cents) : null,
      correlationId: row.correlation_id ? String(row.correlation_id) : null,
      providerMode: row.provider_mode ? String(row.provider_mode) : null,
      userId: row.user_id ? String(row.user_id) : null,
    });
    if (next === String(row.traffic_class ?? CUSTOMER_TRAFFIC_CLASS)) continue;
    await db
      .prepare(`UPDATE daily_improvement_interactions SET traffic_class = ? WHERE interaction_id = ?`)
      .bind(next, String(row.interaction_id))
      .run();
    updated += 1;
  }
  return updated;
}

async function backfillPortal(db: D1Database, fromIso: string, toIso: string): Promise<number> {
  let stored = 0;
  try {
    const users = await db
      .prepare(
        `SELECT m.id, m.conversation_id, m.company_id, m.user_id, m.content, m.created_at, u.email AS actor_email
         FROM portal_conversation_messages m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.role = 'user' AND m.created_at >= ? AND m.created_at < ?
         ORDER BY m.created_at ASC LIMIT 400`,
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
        actorEmail: user.actor_email ? String(user.actor_email) : null,
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
        trafficClass: typeof meta.trafficClass === "string" ? meta.trafficClass : undefined,
        sourceClient: String(row.source_client ?? ""),
        actorEmail: typeof meta.actorEmail === "string" ? meta.actorEmail : null,
        wamid: typeof meta.wamid === "string" ? meta.wamid : null,
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
