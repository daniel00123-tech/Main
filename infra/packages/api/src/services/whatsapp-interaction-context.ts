import type { Env } from "../env";
import { newId } from "../db/mappers";
import type { WhatsAppDocumentEntity } from "./whatsapp-entities";
import type { WhatsAppReplyButton } from "./whatsapp-buttons";
import { ACTION_TO_TEXT, clipButtonTitle } from "./whatsapp-buttons";

export const INTERACTION_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
export const CONTEXT_TOKEN_RE = /^ctx_[a-z0-9]{8,16}$/i;

export const BOUND_BUTTON_ACTIONS = [
  "summarise",
  "more_detail",
  "open_source",
  "find_similar",
] as const;

export type BoundButtonAction = (typeof BOUND_BUTTON_ACTIONS)[number];

export type WhatsAppInteractionContext = {
  interactionContextId: string;
  token: string;
  companyId: string;
  userId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  entityType: string;
  entityId: string;
  title: string;
  sourceSystem: string | null;
  sourceUrl: string | null;
  excerpt: string;
  searchId: string | null;
  resultId: string | null;
  providerItemId: string | null;
  sourceKey: string | null;
  createdAt: string;
  expiresAt: string;
};

export type BoundButtonParse = {
  token: string | null;
  action: string;
  rawId: string;
  bound: boolean;
};

export type ResolveContextResult =
  | { status: "ok"; context: WhatsAppInteractionContext }
  | { status: "missing" }
  | { status: "expired"; context?: WhatsAppInteractionContext }
  | { status: "denied" };

export function newContextToken(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `ctx_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parseBoundButtonId(id: string): BoundButtonParse {
  const rawId = String(id ?? "").trim();
  const match = rawId.match(/^(ctx_[a-z0-9]{8,16}):([a-z0-9_]+)$/i);
  if (match) {
    return { token: match[1]!.toLowerCase(), action: match[2]!.toLowerCase(), rawId, bound: true };
  }
  return { token: null, action: rawId.toLowerCase(), rawId, bound: false };
}

export function encodeBoundButtonId(token: string, action: string): string {
  return `${token}:${action}`.slice(0, 256);
}

export function isBoundButtonAction(action: string): action is BoundButtonAction {
  return (BOUND_BUTTON_ACTIONS as readonly string[]).includes(action);
}

export function expiredButtonReply(action?: string | null): string {
  if (action === "more_detail") {
    return "That option has expired. Which document would you like more detail on?";
  }
  if (action === "find_similar") {
    return "That option has expired. Which document should I find similar files for?";
  }
  if (action === "open_source") {
    return "That option has expired. Which document would you like the link for?";
  }
  return "That option has expired. Which document would you like me to summarise?";
}

export function deniedButtonReply(): string {
  return "I can’t use that option from this chat.";
}

export function entityFromContext(context: WhatsAppInteractionContext): WhatsAppDocumentEntity {
  return {
    id: context.entityId,
    title: context.title,
    url: context.sourceUrl && /^https?:\/\//i.test(context.sourceUrl) ? context.sourceUrl : null,
    excerpt: context.excerpt,
    amount: null,
    reference: null,
    sourceLabel: context.title,
    sourceSystem: context.sourceSystem,
    providerItemId: context.providerItemId,
    sourceKey: context.sourceKey,
  };
}

export function documentButtonsForContext(input: {
  token: string;
  hasSourceUrl?: boolean;
  completedAction?: string | null;
}): WhatsAppReplyButton[] {
  const token = input.token;
  const completed = String(input.completedAction ?? "").toLowerCase();
  const hideSummarise = completed === "summarise" || completed === "summary";
  const hideDetail = completed === "more_detail" || completed === "detail";
  const buttons: WhatsAppReplyButton[] = [];
  if (!hideSummarise) {
    buttons.push({ id: encodeBoundButtonId(token, "summarise"), title: clipButtonTitle("Summarise") });
  }
  buttons.push(
    input.hasSourceUrl
      ? { id: encodeBoundButtonId(token, "open_source"), title: clipButtonTitle("Open source") }
      : { id: encodeBoundButtonId(token, "find_similar"), title: clipButtonTitle("Find similar") },
  );
  if (!hideDetail) {
    buttons.push({ id: encodeBoundButtonId(token, "more_detail"), title: clipButtonTitle("More detail") });
  }
  return buttons.slice(0, 3);
}

export async function ensureWhatsAppInteractionContextTables(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_interaction_contexts (
       interaction_context_id TEXT PRIMARY KEY,
       token TEXT NOT NULL UNIQUE,
       company_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       conversation_id TEXT,
       source_message_id TEXT,
       entity_type TEXT NOT NULL,
       entity_id TEXT NOT NULL,
       title TEXT,
       source_system TEXT,
       source_url TEXT,
       excerpt TEXT,
       search_id TEXT,
       result_id TEXT,
       provider_item_id TEXT,
       source_key TEXT,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS whatsapp_button_idempotency (
       wamid TEXT NOT NULL,
       context_token TEXT NOT NULL,
       action TEXT NOT NULL,
       reply TEXT,
       processed_at TEXT NOT NULL,
       PRIMARY KEY (wamid, context_token, action)
     )`,
  ).run();
}

export async function createWhatsAppInteractionContext(
  env: Env,
  input: {
    companyId: string;
    userId: string;
    conversationId?: string | null;
    sourceMessageId?: string | null;
    entity: WhatsAppDocumentEntity;
    searchId?: string | null;
    resultId?: string | null;
    now?: Date;
  },
): Promise<WhatsAppInteractionContext | null> {
  if (!input.companyId || !input.userId || (!input.entity.id && !input.entity.title)) return null;
  try {
    await ensureWhatsAppInteractionContextTables(env);
    const now = input.now ?? new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + INTERACTION_CONTEXT_TTL_MS).toISOString();
    const token = newContextToken();
    const interactionContextId = newId("wa_ctx");
    const context: WhatsAppInteractionContext = {
      interactionContextId,
      token,
      companyId: input.companyId,
      userId: input.userId,
      conversationId: input.conversationId ?? input.userId,
      sourceMessageId: input.sourceMessageId ?? null,
      entityType: "document",
      entityId: (input.entity.id || input.entity.title).slice(0, 180),
      title: input.entity.title.slice(0, 180),
      sourceSystem: input.entity.sourceSystem ?? input.entity.sourceLabel ?? null,
      sourceUrl: input.entity.url && /^https?:\/\//i.test(input.entity.url) ? input.entity.url : null,
      excerpt: (input.entity.excerpt ?? "").slice(0, 400),
      searchId: input.searchId ?? null,
      resultId: input.resultId ?? input.entity.id ?? null,
      providerItemId: input.entity.providerItemId ?? null,
      sourceKey: input.entity.sourceKey ?? null,
      createdAt,
      expiresAt,
    };
    await env.DB.prepare(
      `INSERT INTO whatsapp_interaction_contexts (
         interaction_context_id, token, company_id, user_id, conversation_id, source_message_id,
         entity_type, entity_id, title, source_system, source_url, excerpt, search_id, result_id,
         provider_item_id, source_key, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        context.interactionContextId,
        context.token,
        context.companyId,
        context.userId,
        context.conversationId,
        context.sourceMessageId,
        context.entityType,
        context.entityId,
        context.title,
        context.sourceSystem,
        context.sourceUrl,
        context.excerpt,
        context.searchId,
        context.resultId,
        context.providerItemId,
        context.sourceKey,
        context.createdAt,
        context.expiresAt,
      )
      .run();
    return context;
  } catch {
    return null;
  }
}

export async function resolveWhatsAppInteractionContext(
  env: Env,
  input: { token: string; userId: string; companyId: string; now?: Date },
): Promise<ResolveContextResult> {
  const token = String(input.token ?? "").trim().toLowerCase();
  if (!CONTEXT_TOKEN_RE.test(token) || !input.userId || !input.companyId) {
    return { status: "missing" };
  }
  try {
    await ensureWhatsAppInteractionContextTables(env);
    const row = await env.DB.prepare(
      `SELECT interaction_context_id, token, company_id, user_id, conversation_id, source_message_id,
              entity_type, entity_id, title, source_system, source_url, excerpt, search_id, result_id,
              provider_item_id, source_key, created_at, expires_at
       FROM whatsapp_interaction_contexts
       WHERE token = ?
       LIMIT 1`,
    )
      .bind(token)
      .first<{
        interaction_context_id: string;
        token: string;
        company_id: string;
        user_id: string;
        conversation_id: string | null;
        source_message_id: string | null;
        entity_type: string;
        entity_id: string;
        title: string | null;
        source_system: string | null;
        source_url: string | null;
        excerpt: string | null;
        search_id: string | null;
        result_id: string | null;
        provider_item_id: string | null;
        source_key: string | null;
        created_at: string;
        expires_at: string;
      }>();
    if (!row) return { status: "missing" };
    if (row.user_id !== input.userId || row.company_id !== input.companyId) {
      return { status: "denied" };
    }
    const context = rowToContext(row);
    const nowMs = (input.now ?? new Date()).getTime();
    if (Date.parse(row.expires_at) <= nowMs) {
      return { status: "expired", context };
    }
    return { status: "ok", context };
  } catch {
    return { status: "missing" };
  }
}

export async function claimButtonIdempotency(
  env: Env,
  input: { wamid: string; token: string; action: string; reply?: string | null },
): Promise<{ duplicate: boolean; priorReply: string | null }> {
  if (!input.wamid || !input.token || !input.action) {
    return { duplicate: false, priorReply: null };
  }
  try {
    await ensureWhatsAppInteractionContextTables(env);
    const existing = await env.DB.prepare(
      `SELECT reply FROM whatsapp_button_idempotency
       WHERE wamid = ? AND context_token = ? AND action = ?
       LIMIT 1`,
    )
      .bind(input.wamid, input.token, input.action)
      .first<{ reply?: string | null }>();
    if (existing) {
      return { duplicate: true, priorReply: existing.reply ?? null };
    }
    await env.DB.prepare(
      `INSERT INTO whatsapp_button_idempotency (wamid, context_token, action, reply, processed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(input.wamid, input.token, input.action, input.reply ?? null, new Date().toISOString())
      .run();
    return { duplicate: false, priorReply: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/UNIQUE|already exists/i.test(message)) {
      return { duplicate: true, priorReply: null };
    }
    return { duplicate: false, priorReply: null };
  }
}

export function buttonActionToUserText(action: string): string {
  return ACTION_TO_TEXT[action] ?? action;
}

function rowToContext(row: {
  interaction_context_id: string;
  token: string;
  company_id: string;
  user_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  entity_type: string;
  entity_id: string;
  title: string | null;
  source_system: string | null;
  source_url: string | null;
  excerpt: string | null;
  search_id: string | null;
  result_id: string | null;
  provider_item_id: string | null;
  source_key: string | null;
  created_at: string;
  expires_at: string;
}): WhatsAppInteractionContext {
  return {
    interactionContextId: row.interaction_context_id,
    token: row.token,
    companyId: row.company_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title ?? "",
    sourceSystem: row.source_system,
    sourceUrl: row.source_url,
    excerpt: row.excerpt ?? "",
    searchId: row.search_id,
    resultId: row.result_id,
    providerItemId: row.provider_item_id,
    sourceKey: row.source_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
