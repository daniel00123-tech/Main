import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { tryNormalizeE164 } from "./phone";
import { resolveWhatsAppIdentity } from "./whatsapp-identity";

export const WHATSAPP_WEBHOOK_PATH = "/api/webhooks/whatsapp";
export const WHATSAPP_INBOUND_QUEUE = "whatsapp-inbound";
export const WHATSAPP_INBOUND_DLQ = "whatsapp-inbound-dlq";

export type WhatsAppInboundMessage = {
  kind: "whatsapp_inbound";
  eventId: string;
  receivedAt: string;
  signatureValid: boolean;
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

/** Outbound AI stays off unless Meta send credentials are present. */
export function whatsappOutboundAiEnabled(env: Env): boolean {
  return Boolean(
    whatsappAccessToken(env) &&
      metaAppSecret(env) &&
      whatsappPhoneNumberId(env) &&
      env.WHATSAPP_OUTBOUND_AI_ENABLED === "true",
  );
}

export function hasWhatsAppInboundQueue(env: Env): boolean {
  return typeof env.WHATSAPP_INBOUND_QUEUE !== "undefined" && env.WHATSAPP_INBOUND_QUEUE !== null;
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

export function parseWhatsAppInboundMessages(payload: unknown): Array<{
  wamid: string;
  from: string;
  type: string;
  text: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  timestamp: string | null;
}> {
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
          }>;
        };
      }>;
    }>;
  };
  if (root.object && root.object !== "whatsapp_business_account") return [];

  const messages: Array<{
    wamid: string;
    from: string;
    type: string;
    text: string | null;
    phoneNumberId: string | null;
    businessAccountId: string | null;
    timestamp: string | null;
  }> = [];

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        messages.push({
          wamid: message.id,
          from: message.from,
          type: message.type ?? "unknown",
          text: typeof message.text?.body === "string" ? message.text.body.slice(0, 4000) : null,
          phoneNumberId: change.value?.metadata?.phone_number_id ?? null,
          businessAccountId: entry.id ?? null,
          timestamp: message.timestamp ?? null,
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
  },
): Promise<{ eventId: string; duplicate: boolean }> {
  const eventId = newId("wa_evt");
  const receivedAt = nowIso();
  await ensureWhatsAppInboundTable(env);
  try {
    await env.DB.prepare(
      `INSERT INTO whatsapp_inbound_events (
         id, wamid, phone_number_id, business_account_id, sender_e164, message_type,
         identity_found, user_id, company_id, signature_valid, processed,
         payload_json, error, received_at, processed_at
       ) VALUES (?, NULL, NULL, NULL, NULL, 'webhook', 0, NULL, NULL, ?, 0, ?, NULL, ?, NULL)`,
    )
      .bind(eventId, input.signatureValid ? 1 : 0, input.rawBody.slice(0, 16_384), receivedAt)
      .run();
    return { eventId, duplicate: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/UNIQUE|already exists/i.test(message)) {
      return { eventId, duplicate: true };
    }
    throw err;
  }
}

export async function enqueueWhatsAppInbound(
  env: Env,
  message: WhatsAppInboundMessage,
): Promise<boolean> {
  if (!hasWhatsAppInboundQueue(env)) return false;
  await env.WHATSAPP_INBOUND_QUEUE!.send(message);
  return true;
}

export async function processWhatsAppInboundJob(
  env: Env,
  message: WhatsAppInboundMessage,
  options?: { deadLetter?: boolean },
): Promise<void> {
  await ensureWhatsAppInboundTable(env);
  const row = await env.DB.prepare(`SELECT * FROM whatsapp_inbound_events WHERE id = ?`)
    .bind(message.eventId)
    .first<{
      id: string;
      payload_json: string;
      signature_valid: number;
      processed: number;
    }>();
  if (!row) return;
  if (Number(row.processed) === 1) return;

  if (options?.deadLetter) {
    await env.DB.prepare(
      `UPDATE whatsapp_inbound_events SET processed = 1, error = 'DEAD_LETTER', processed_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), message.eventId)
      .run();
    return;
  }

  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = {};
  }

  const inbound = parseWhatsAppInboundMessages(payload);
  const expectedPhone = whatsappPhoneNumberId(env);
  const trusted = message.signatureValid && Number(row.signature_valid) === 1;

  for (const item of inbound) {
    if (expectedPhone && item.phoneNumberId && item.phoneNumberId !== expectedPhone) {
      continue;
    }
    const parsed = tryNormalizeE164(item.from);
    const sender = parsed.ok ? parsed.e164 : null;
    const identity = sender ? await resolveWhatsAppIdentity(env.DB, sender) : null;
    const found = Boolean(identity?.found);
    const companyId = identity?.found ? identity.memberships[0]?.companyId ?? null : null;
    const userId = identity?.found ? identity.user.id : null;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO whatsapp_inbound_events (
         id, wamid, phone_number_id, business_account_id, sender_e164, message_type,
         identity_found, user_id, company_id, signature_valid, processed,
         payload_json, error, received_at, processed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
    )
      .bind(
        newId("wa_msg"),
        item.wamid,
        item.phoneNumberId,
        item.businessAccountId,
        sender,
        item.type,
        found ? 1 : 0,
        userId,
        companyId,
        trusted ? 1 : 0,
        JSON.stringify({
          wamid: item.wamid,
          type: item.type,
          preview: item.text ? item.text.slice(0, 240) : null,
        }),
        nowIso(),
        nowIso(),
      )
      .run();

    await recordAuditEvent(env.DB, {
      companyId: found ? companyId : null,
      eventType: found ? "whatsapp.inbound_identified" : "whatsapp.inbound_unknown",
      actor: "whatsapp-webhook",
      resourceType: "whatsapp_message",
      resourceId: item.wamid,
      detail: {
        channel: "whatsapp",
        identityFound: found,
        messageType: item.type,
        trusted,
        outboundAi: false,
      },
    });
  }

  await env.DB.prepare(
    `UPDATE whatsapp_inbound_events SET processed = 1, processed_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), message.eventId)
    .run();
}

async function ensureWhatsAppInboundTable(env: Env): Promise<void> {
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
       processed_at TEXT
     )`,
  ).run();
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
