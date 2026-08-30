import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { inspectWhatsAppAssets, outboundAiEnabled } from "./whatsapp-assets";
import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";
import { COALESCE_WINDOW_MS } from "./whatsapp-latency";
import { senderE164FromDigits } from "./whatsapp-realtime";
import { sweepStuckWhatsAppTurns } from "./whatsapp-reaper";

export const WHATSAPP_WEBHOOK_PATH = "/api/webhooks/whatsapp";
export const WHATSAPP_INBOUND_QUEUE = "whatsapp-inbound";
export const WHATSAPP_INBOUND_DLQ = "whatsapp-inbound-dlq";
export const WHATSAPP_WATCHDOG_QUEUE = "whatsapp-watchdog";
export const WHATSAPP_WATCHDOG_DLQ = "whatsapp-watchdog-dlq";

export type WhatsAppInboundMessage = {
  kind: "whatsapp_inbound" | "whatsapp_watchdog";
  eventId: string;
  receivedAt: string;
  signatureValid: boolean;
  rawPayload?: string;
  wamid?: string;
  stage?: "t5" | "t10" | "t30";
};

export function whatsappPhoneNumberId(env: Env): string {
  return String(env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
}

export function whatsappBusinessAccountId(env: Env): string {
  return String(env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "").trim();
}

export function whatsappVerifyToken(env: Env): string {
  return String(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "").trim();
}

export function metaAppSecret(env: Env): string {
  return String(env.META_APP_SECRET ?? "").trim();
}

export function whatsappAccessToken(env: Env): string {
  return String(env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
}

export function whatsappVerifyConfigured(env: Env): boolean {
  return whatsappVerifyToken(env).length >= 16;
}

/** Outbound AI stays off unless Meta send credentials and production IDs are present. */
export function whatsappOutboundAiEnabled(env: Env): boolean {
  return outboundAiEnabled(env);
}

export function hasWhatsAppInboundQueue(env: Env): boolean {
  return typeof env.WHATSAPP_INBOUND_QUEUE !== "undefined" && env.WHATSAPP_INBOUND_QUEUE !== null;
}

export function hasWhatsAppWatchdogQueue(env: Env): boolean {
  return typeof env.WHATSAPP_WATCHDOG_QUEUE !== "undefined" && env.WHATSAPP_WATCHDOG_QUEUE !== null;
}

export function verifyWhatsAppHubChallenge(
  env: Env,
  query: {
    mode?: string | null;
    token?: string | null;
    challenge?: string | null;
  },
): { ok: true; challenge: string } | { ok: false; status: 403 | 503; error: string } {
  const expected = whatsappVerifyToken(env);
  if (!expected) {
    return { ok: false, status: 503, error: "Webhook verify token is not configured" };
  }
  if (query.mode !== "subscribe" || !query.token || query.challenge == null || query.challenge === "") {
    return { ok: false, status: 403, error: "Invalid verification request" };
  }
  if (!safeEqualString(query.token, expected)) {
    return { ok: false, status: 403, error: "Verification token mismatch" };
  }
  return { ok: true, challenge: query.challenge };
}

export async function verifyWhatsAppSignature(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ configured: boolean; valid: boolean }> {
  const secret = metaAppSecret(env);
  if (!secret) return { configured: false, valid: false };
  if (!signatureHeader) return { configured: true, valid: false };
  const provided = signatureHeader.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { configured: true, valid: false };
  const expected = await hmacSha256Hex(secret, rawBody);
  return { configured: true, valid: safeEqualHex(provided, expected) };
}

export type WhatsAppParsedInbound = {
  wamid: string;
  from: string;
  type: string;
  text: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  timestamp: string | null;
  inputKind?: "text" | "voice" | "button";
  mediaId?: string | null;
  mimeType?: string | null;
  buttonId?: string | null;
  buttonTitle?: string | null;
};

export function parseWhatsAppInboundMessages(payload: unknown): WhatsAppParsedInbound[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      changes?: Array<{
        field?: string;
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: Array<{
            id?: string;
            from?: string;
            type?: string;
            timestamp?: string;
            text?: { body?: string };
            audio?: { id?: string; mime_type?: string; voice?: boolean };
            voice?: { id?: string; mime_type?: string };
            interactive?: {
              type?: string;
              button_reply?: { id?: string; title?: string };
              list_reply?: { id?: string; title?: string };
            };
          }>;
        };
      }>;
    }>;
  };
  if (root.object && root.object !== "whatsapp_business_account") return [];

  const messages: WhatsAppParsedInbound[] = [];

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        const button = message.interactive?.button_reply ?? message.interactive?.list_reply;
        const audio = message.audio ?? message.voice;
        const isVoice = message.type === "audio" || message.type === "voice" || Boolean(audio?.id);
        const isButton = message.type === "interactive" && Boolean(button?.id);
        messages.push({
          wamid: message.id,
          from: message.from,
          type: message.type ?? "unknown",
          text: typeof message.text?.body === "string" ? message.text.body.slice(0, 4000) : null,
          phoneNumberId: change.value?.metadata?.phone_number_id ?? null,
          businessAccountId: entry.id ?? null,
          timestamp: message.timestamp ?? null,
          inputKind: isButton ? "button" : isVoice ? "voice" : "text",
          mediaId: audio?.id ?? null,
          mimeType: audio?.mime_type ?? null,
          buttonId: button?.id ?? null,
          buttonTitle: button?.title ?? null,
        });
      }
    }
  }
  return messages;
}

export async function persistWhatsAppInboundEvent(
  env: Env,
  input: {
    rawBody: string;
    signatureValid: boolean;
    signatureConfigured: boolean;
    webhookStatus?: number;
    persistError?: string | null;
    signatureError?: string | null;
  },
): Promise<{ eventId: string; duplicate: boolean; persisted: boolean; error: string | null }> {
  const eventId = newId("wa_evt");
  const receivedAt = nowIso();
  try {
    await ensureWhatsAppInboundTable(env);
  } catch (err) {
    return {
      eventId,
      duplicate: false,
      persisted: false,
      error: err instanceof Error ? err.message : "ensure_table_failed",
    };
  }
  let inbound: ReturnType<typeof parseWhatsAppInboundMessages> = [];
  try {
    inbound = parseWhatsAppInboundMessages(JSON.parse(input.rawBody || "{}"));
  } catch {
    inbound = [];
  }
  const first = inbound[0] ?? null;
  if (first?.wamid) {
    try {
      const existing = await env.DB.prepare(
        `SELECT id FROM whatsapp_inbound_events WHERE wamid = ? LIMIT 1`,
      )
        .bind(first.wamid)
        .first<{ id: string }>();
      if (existing) {
        return { eventId: existing.id, duplicate: true, persisted: true, error: null };
      }
    } catch {
      // Dedup is best-effort — never block the user path.
    }
  }
  const sender = senderE164FromDigits(first?.from);
  const insert = async () =>
    env.DB.prepare(
      `INSERT INTO whatsapp_inbound_events (
         id, wamid, phone_number_id, business_account_id, sender_e164, message_type,
         identity_found, user_id, company_id, signature_valid, processed,
         payload_json, error, received_at, processed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, 0, ?, NULL, ?, NULL)`,
    )
      .bind(
        eventId,
        first?.wamid ?? null,
        first?.phoneNumberId ?? null,
        first?.businessAccountId ?? null,
        sender,
        first?.type ?? "webhook",
        input.signatureValid ? 1 : 0,
        input.rawBody.slice(0, 16_384),
        receivedAt,
      )
      .run();
  try {
    await insert();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/UNIQUE|already exists/i.test(message)) {
      return { eventId, duplicate: true, persisted: true, error: null };
    }
    try {
      await insert();
    } catch (inner) {
      const innerMessage = inner instanceof Error ? inner.message : "";
      if (/UNIQUE|already exists/i.test(innerMessage)) {
        return { eventId, duplicate: true, persisted: true, error: null };
      }
      return {
        eventId,
        duplicate: false,
        persisted: false,
        error: message || innerMessage || "persist_insert_failed",
      };
    }
  }
  await env.DB.prepare(
    `UPDATE whatsapp_inbound_events
     SET lifecycle_state = COALESCE(lifecycle_state, 'received'),
         inbound_text = COALESCE(inbound_text, ?),
         persist_ok = 1,
         webhook_status = COALESCE(webhook_status, ?),
         persist_error = ?,
         signature_error = ?
     WHERE id = ?`,
  )
    .bind(
      (first?.text ?? "").slice(0, 500) || null,
      input.webhookStatus ?? 200,
      input.persistError ?? null,
      input.signatureError ?? null,
      eventId,
    )
    .run()
    .catch(() => undefined);
  return { eventId, duplicate: false, persisted: true, error: null };
}

export async function enqueueWhatsAppInbound(
  env: Env,
  message: WhatsAppInboundMessage,
  options?: { delaySeconds?: number },
): Promise<boolean> {
  const queue =
    message.kind === "whatsapp_watchdog" && hasWhatsAppWatchdogQueue(env)
      ? env.WHATSAPP_WATCHDOG_QUEUE
      : env.WHATSAPP_INBOUND_QUEUE;
  if (!queue) return false;
  if (options?.delaySeconds && options.delaySeconds > 0) {
    await queue.send(message, { delaySeconds: options.delaySeconds });
  } else {
    await queue.send(message);
  }
  return true;
}

export async function processWhatsAppInboundJob(
  env: Env,
  message: WhatsAppInboundMessage,
  options?: { deadLetter?: boolean; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<void> {
  if (message.kind === "whatsapp_watchdog") {
    const { recoverStuckWhatsAppTurn, applyWhatsAppWatchdogStage } = await import("./whatsapp-reaper");
    if (message.stage === "t5" || message.stage === "t10" || message.stage === "t30") {
      await applyWhatsAppWatchdogStage(env, {
        eventId: message.eventId,
        wamid: message.wamid ?? null,
        stage: message.stage,
        receivedAt: message.receivedAt,
      });
      return;
    }
    if (message.wamid) await recoverStuckWhatsAppTurn(env, message.wamid);
    return;
  }

  await ensureWhatsAppInboundTable(env);
  let row = await env.DB.prepare(`SELECT * FROM whatsapp_inbound_events WHERE id = ?`)
    .bind(message.eventId)
    .first<{
      id: string;
      payload_json: string;
      signature_valid: number;
      processed: number;
      received_at?: string;
      error?: string | null;
      first_visible_at?: string | null;
      terminal_state?: string | null;
    }>();
  if (!row && message.rawPayload) {
    row = {
      id: message.eventId,
      payload_json: message.rawPayload,
      signature_valid: message.signatureValid ? 1 : 0,
      processed: 0,
      received_at: message.receivedAt,
      error: "ROW_MISSING_USED_QUEUE_PAYLOAD",
    };
  }
  if (!row) return;
  if (Number(row.processed) === 1) return;
  const claimed = await claimWhatsAppInboundEvent(env, message.eventId, row.received_at);
  if (!claimed) {
    // Another isolate owns this turn. Do not throw — queue retry/DLQ must not
    // bury a greeting that the other isolate is still sending.
    return;
  }

  if (options?.deadLetter) {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events
       SET processed = 1, error = 'DEAD_LETTER', processed_at = ?, dlq_at = COALESCE(dlq_at, ?)
       WHERE id = ?`,
    )
      .bind(nowIso(), nowIso(), message.eventId)
      .run()
      .catch(() => undefined);
    if (message.wamid || row.payload_json) {
      const { recoverStuckWhatsAppTurn } = await import("./whatsapp-reaper");
      const inbound = parseWhatsAppInboundMessages(safeJson(row.payload_json));
      const wamid = message.wamid || inbound[0]?.wamid;
      if (wamid) await recoverStuckWhatsAppTurn(env, wamid).catch(() => undefined);
    }
    return;
  }

  const payload = safeJson(row.payload_json);

  const inbound = parseWhatsAppInboundMessages(payload);
  const assets = inspectWhatsAppAssets(env);
  const trusted = message.signatureValid && Number(row.signature_valid) === 1;
  const waitUntil = (promise: Promise<unknown>) => {
    // Hand long watches to the isolate waitUntil hook only.
    // Awaiting them here held the queue consumer for 30s+ and blocked the next chat.
    options?.waitUntil?.(promise);
  };

  if (!assets.ok) {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events SET processed = 1, error = ?, processed_at = ? WHERE id = ?`,
    )
      .bind(assets.reason ?? "invalid_whatsapp_assets", nowIso(), message.eventId)
      .run();
    return;
  }

  let lastCompanyId: string | null = null;
  let lastUserId: string | null = null;
  let lastFound = 0;

  await sweepStuckWhatsAppTurns(env).catch(() => undefined);

  for (const item of inbound) {
    try {
      const result = await handleWhatsAppInboundMessage(env, item, {
        signatureValid: trusted,
        waitUntil,
        coalesceMs: COALESCE_WINDOW_MS,
        inboundReceivedAt: Date.parse(row.received_at ?? "") || Date.now(),
      });
      lastCompanyId = result.companyId ?? lastCompanyId;
      lastUserId = result.userId ?? lastUserId;
      lastFound = result.identityFound ? 1 : lastFound;
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          service: "infra-api",
          event: "whatsapp.inbound_item_failed",
          wamid: item.wamid,
          message: err instanceof Error ? err.message : "inbound item failed",
        }),
      );
    }
  }

  await env.DB.prepare(
    `UPDATE whatsapp_inbound_events
     SET processed = 1, processed_at = ?, identity_found = ?, user_id = ?, company_id = ?,
         error = NULL
     WHERE id = ?`,
  )
    .bind(nowIso(), lastFound, lastUserId, lastCompanyId, message.eventId)
    .run();
}

async function claimWhatsAppInboundEvent(
  env: Env,
  eventId: string,
  receivedAt?: string,
): Promise<boolean> {
  try {
    const fresh = await env.DB.prepare(
      `UPDATE whatsapp_inbound_events
       SET error = 'PROCESSING'
       WHERE id = ? AND processed = 0 AND (error IS NULL OR error != 'PROCESSING')`,
    )
      .bind(eventId)
      .run();
    if ((fresh.meta?.changes ?? 1) > 0) return true;
    const staleCutoff = new Date(Date.now() - 15_000).toISOString();
    if (receivedAt && receivedAt > staleCutoff) return false;
    const stale = await env.DB.prepare(
      `UPDATE whatsapp_inbound_events
       SET error = 'PROCESSING'
       WHERE id = ? AND processed = 0 AND error = 'PROCESSING'`,
    )
      .bind(eventId)
      .run();
    return (stale.meta?.changes ?? 0) > 0;
  } catch {
    return true;
  }
}

let inboundTableReady = false;

export async function ensureWhatsAppInboundTable(env: Env): Promise<void> {
  if (inboundTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_inbound_events (
       id TEXT PRIMARY KEY,
       wamid TEXT UNIQUE,
       phone_number_id TEXT,
       business_account_id TEXT,
       sender_e164 TEXT,
       message_type TEXT,
       identity_found INTEGER NOT NULL DEFAULT 0,
       user_id TEXT,
       company_id TEXT,
       signature_valid INTEGER,
       processed INTEGER NOT NULL DEFAULT 0,
       payload_json TEXT NOT NULL,
       error TEXT,
       received_at TEXT NOT NULL,
       processed_at TEXT,
       lifecycle_state TEXT,
       terminal_state TEXT,
       validated_at TEXT,
       acknowledged_at TEXT,
       planning_at TEXT,
       tool_running_at TEXT,
       synthesising_at TEXT,
       reply_sent_at TEXT,
       first_visible_at TEXT,
       last_error TEXT
     )`,
  ).run();
  const alters = [
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN lifecycle_state TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN terminal_state TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN validated_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN acknowledged_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN planning_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN tool_running_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN synthesising_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN reply_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN first_visible_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN last_error TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN identity_resolved_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN read_status_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN typing_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN acknowledgement_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN final_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN queue_accepted_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN recover_sent_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN time_to_first_visible_ms INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN read_status_ok INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN typing_ok INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN ack_send_ok INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN final_send_ok INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_error TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN inbound_text TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN persist_ok INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN persist_error TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN webhook_status INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN fast_lane INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_http_status INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_meta_message_id TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN outbound_attempts INTEGER",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_5s_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_10s_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN watchdog_30s_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN dlq_at TEXT",
    "ALTER TABLE whatsapp_inbound_events ADD COLUMN signature_error TEXT",
  ];
  for (const sql of alters) {
    await env.DB.prepare(sql).run().catch(() => undefined);
  }
  inboundTableReady = true;
}

function safeJson(raw: string | null | undefined): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function safeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function safeEqualHex(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
