import { newId, nowIso } from "../../db/mappers";
import { CUSTOMER_TRAFFIC_CLASS, TEST_TRAFFIC_CLASS, type DailyTrafficClass } from "./constants";
import { evidenceRefsOnly, stripSecrets } from "./redact";
import { upsertInteraction } from "./store";
import { classifyDailyTraffic, isGenuineCustomerTraffic, looksLikeAutomatedTestPrompt, normalisePrompt } from "./traffic";
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
  const promptCounts = new Map<string, number>();
  for (const row of rows.results ?? []) {
    const key = normalisePrompt(row.user_message ? String(row.user_message) : "");
    if (key.length >= 16) promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1);
  }
  let updated = 0;
  for (const row of rows.results ?? []) {
    const message = row.user_message ? String(row.user_message) : null;
    let next = classifyDailyTraffic({
      trafficClass: row.traffic_class ? String(row.traffic_class) : null,
      sourceClient: row.source_client ? String(row.source_client) : null,
      userMessage: message,
      customerChargeCents: row.customer_charge_cents != null ? Number(row.customer_charge_cents) : null,
      correlationId: row.correlation_id ? String(row.correlation_id) : null,
      providerMode: row.provider_mode ? String(row.provider_mode) : null,
      userId: row.user_id ? String(row.user_id) : null,
    });
    const key = normalisePrompt(message);
    if (next === CUSTOMER_TRAFFIC_CLASS && key.length >= 16 && (promptCounts.get(key) ?? 0) >= 3) {
      next = "TEST";
    }
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
  for (const source of ["whatsapp", "chatgpt", "claude", "portal_chat"]) {
    stored += await backfillUsageParentsForSource(db, fromIso, toIso, source);
  }
  return stored;
}

async function backfillUsageParentsForSource(
  db: D1Database,
  fromIso: string,
  toIso: string,
  sourceClient: string,
): Promise<number> {
  let stored = 0;
  try {
    const rows = await db
      .prepare(
        `SELECT interaction_id, company_id, user_id, source_client, tool_name, action,
                duration_ms, customer_charge_cents, underlying_cost_cents, correlation_id,
                recorded_at, metadata_json, actor_email, parent_request_id
         FROM usage_records
         WHERE recorded_at >= ? AND recorded_at < ?
           AND interaction_id IS NOT NULL
           AND source_client = ?
           AND interaction_id NOT IN (
             SELECT interaction_id FROM daily_improvement_interactions WHERE source_client = ?
           )
         ORDER BY recorded_at ASC LIMIT 800`,
      )
      .bind(fromIso, toIso, sourceClient, sourceClient)
      .all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const meta = safeMeta(row.metadata_json);
      const classified = classifyHistoricalUsageRow(row, meta);
      if (classified === null) continue;
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
        trafficClass: classified,
        sourceClient: String(row.source_client ?? ""),
        actorEmail: row.actor_email ? String(row.actor_email) : typeof meta.actorEmail === "string" ? meta.actorEmail : null,
        wamid: typeof meta.wamid === "string" ? meta.wamid : null,
      });
      stored += 1;
    }
  } catch {
    return stored;
  }
  return stored;
}

function classifyHistoricalUsageRow(
  row: Record<string, unknown>,
  meta: Record<string, unknown>,
): DailyTrafficClass | null | undefined {
  const wamid = String(meta.wamid ?? "");
  const source = String(row.source_client ?? "").toLowerCase();
  if (
    meta.isTestConfig === true ||
    /InfraAcceptance|WhatsAppQA|QualityLoop|e2e-probe|acceptance/i.test(
      `${meta.userAgent ?? ""} ${meta.trafficClass ?? ""} ${row.actor_email ?? ""} ${row.tool_name ?? ""}`,
    ) ||
    looksLikeAutomatedTestPrompt(typeof meta.summary === "string" ? meta.summary : null)
  ) {
    return TEST_TRAFFIC_CLASS;
  }
  if (/^wamid\.HBg/i.test(wamid)) return CUSTOMER_TRAFFIC_CLASS;
  if (source === "whatsapp") return null;
  return undefined;
}

export async function reconcileWhatsAppHistorical(
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<{
  totalParents: number;
  classifiedCustomer: number;
  classifiedTest: number;
  ambiguous: number;
  backfilled: number;
  remainingLegacy: number;
}> {
  const parents = await db
    .prepare(
      `SELECT COUNT(DISTINCT interaction_id) AS n
       FROM usage_records
       WHERE recorded_at >= ? AND recorded_at < ? AND source_client = 'whatsapp' AND interaction_id IS NOT NULL`,
    )
    .bind(fromIso, toIso)
    .first<{ n: number }>();
  const inbound = await db
    .prepare(
      `SELECT wamid, inbound_text, sender_e164, received_at
       FROM whatsapp_inbound_events
       WHERE received_at >= ? AND received_at < ? AND wamid LIKE 'wamid.HBg%'`,
    )
    .bind(fromIso, toIso)
    .all<{ wamid: string; inbound_text: string | null; sender_e164: string | null; received_at: string }>();
  let classifiedCustomer = 0;
  let classifiedTest = 0;
  for (const row of inbound.results ?? []) {
    const test = looksLikeAutomatedTestPrompt(row.inbound_text);
    const trafficClass = test ? TEST_TRAFFIC_CLASS : CUSTOMER_TRAFFIC_CLASS;
    if (test) classifiedTest += 1;
    else classifiedCustomer += 1;
    await recordDailyImprovementInteraction(db, {
      interactionId: row.wamid,
      companyId: "co_el",
      channel: "whatsapp",
      createdAt: row.received_at,
      userMessage: row.inbound_text,
      trafficClass,
      sourceClient: "whatsapp",
      wamid: row.wamid,
      actorEmail: null,
    });
  }
  const usageBackfill = await backfillUsageParentsForSource(db, fromIso, toIso, "whatsapp");
  const daily = await db
    .prepare(
      `SELECT COALESCE(traffic_class,'NULL') AS traffic_class, COUNT(*) AS n
       FROM daily_improvement_interactions
       WHERE created_at >= ? AND created_at < ? AND channel = 'whatsapp'
       GROUP BY traffic_class`,
    )
    .bind(fromIso, toIso)
    .all<{ traffic_class: string; n: number }>();
  const customer = Number(daily.results?.find((row) => row.traffic_class === "CUSTOMER_REQUEST")?.n ?? 0);
  const test = Number(daily.results?.find((row) => row.traffic_class === "TEST")?.n ?? 0);
  const totalParents = Number(parents?.n ?? 0);
  const remainingLegacy = Math.max(0, totalParents - customer - test);
  return {
    totalParents,
    classifiedCustomer: customer,
    classifiedTest: test,
    ambiguous: remainingLegacy,
    backfilled: usageBackfill + classifiedCustomer + classifiedTest,
    remainingLegacy,
  };
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
