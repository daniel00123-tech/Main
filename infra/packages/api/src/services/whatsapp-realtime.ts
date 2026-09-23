import type { Env } from "../env";
import { isCorpusInventoryAsk } from "./intelligence/scope.js";
import { classifyWhatsAppIntent, focusSearchTerms, softenSearchQuery } from "./whatsapp-intent";
import { sleepMs } from "./whatsapp-latency";
import { isWhatsAppTerminalState } from "./whatsapp-lifecycle";

export const GREETING_REPLY = "Hi 👋 What can I help you with?";
export const THANKS_REPLY = "You’re welcome. What else can I help with?";
export const CASUAL_REPLY = "I’m good, thanks. What can I help you with today?";
export const DOCUMENT_CLARIFY_REPLY =
  "Of course 👍 What’s the document called, or what is it about?";
export const COMBINED_GREETING_DOCUMENT_REPLY =
  "Hi 👋 Of course. What’s the document called, or what is it about?";
export const STUCK_RECOVERY_REPLY =
  "Sorry — that took longer than expected. I couldn’t complete the request this time. Please try again.";

const LOCAL_GREETING =
  /^(hi+|h+ello+|hey+|hiya|yo|howdy|morning|good morning|afternoon|good afternoon|evening|good evening|thanks|thank you|cheers|ta|thx|ty|hi there|hello there)[\s!.?]*$/i;
const CASUAL_ONLY = /^(how are you|how's it going|hows it going|you ok|you okay)[\s!.?]*$/i;
const THANKS_ONLY = /^(thanks|thank you|cheers|ta|thx|ty)[\s!.?]*$/i;
const GENERIC_DOC_FILLER =
  /\b(shared folder|sharepoint|onedrive|one drive|folder|drive|help me|in the|the|a|an|please|for me|or two|a couple|on the system|in the system)\b/gi;

const GENERIC_SEARCH_STOPWORDS = new Set([
  "can",
  "you",
  "find",
  "me",
  "a",
  "an",
  "the",
  "or",
  "two",
  "couple",
  "some",
  "any",
  "few",
  "doc",
  "docs",
  "document",
  "documents",
  "file",
  "files",
  "folder",
  "folders",
  "sharepoint",
  "onedrive",
  "drive",
  "shared",
  "on",
  "in",
  "system",
  "systems",
  "and",
  "tell",
  "about",
  "it",
  "this",
  "that",
  "please",
  "for",
  "of",
  "help",
  "look",
  "into",
  "something",
  "anything",
  "stuff",
  "one",
  "get",
  "show",
  "give",
  "want",
  "need",
  "like",
  "whats",
  "what",
  "called",
  "name",
  "there",
  "here",
  "available",
  "tellme",
]);

export function isLocalGreetingText(text: string): boolean {
  return LOCAL_GREETING.test(text.trim());
}

export function isLocalCasualText(text: string): boolean {
  return CASUAL_ONLY.test(text.trim());
}

export function isLocalThanksText(text: string): boolean {
  return THANKS_ONLY.test(text.trim());
}

export function isInstantLocalTurn(text: string): boolean {
  const intent = classifyWhatsAppIntent(text);
  return (
    isLocalGreetingText(text) ||
    isLocalCasualText(text) ||
    isLocalThanksText(text) ||
    intent === "greeting" ||
    intent === "thanks" ||
    intent === "casual"
  );
}

export function instantLocalReply(text: string): string {
  if (isLocalThanksText(text) || classifyWhatsAppIntent(text) === "thanks") return THANKS_REPLY;
  if (isLocalCasualText(text) || classifyWhatsAppIntent(text) === "casual") return CASUAL_REPLY;
  return GREETING_REPLY;
}

/** Distinctive nouns left after stripping verbs and generic document filler. */
export function usableSearchTerms(text: string): string[] {
  return softenSearchQuery(text)
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 3 && !GENERIC_SEARCH_STOPWORDS.has(token));
}

/** Generic document/file ask with no distinctive search term — clarify, do not search. */
export function isGenericDocumentAsk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isInstantLocalTurn(trimmed)) return false;
  if (isCorpusInventoryAsk(trimmed)) return false;
  const mentionsDoc = /\b(document|documents|docs?|file|files|folder|sharepoint|onedrive|shared folder)\b/i.test(
    trimmed,
  );
  if (!mentionsDoc) return false;
  if (usableSearchTerms(trimmed).length === 0) return true;
  const focused = focusSearchTerms(trimmed)
    .replace(GENERIC_DOC_FILLER, " ")
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return focused.length < 4 && usableSearchTerms(trimmed).length === 0;
}

export function looksLikeBurstCompanion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isInstantLocalTurn(trimmed)) return false;
  return isGenericDocumentAsk(trimmed);
}

export type SiblingInbound = {
  wamid: string;
  text: string;
  eventId: string | null;
};

export async function peekRecentSiblingInbound(
  env: Env,
  input: { senderE164: string; wamid: string; sinceIso: string },
): Promise<SiblingInbound | null> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, wamid, payload_json, inbound_text, terminal_state
       FROM whatsapp_inbound_events
       WHERE sender_e164 = ? AND received_at >= ? AND (wamid IS NULL OR wamid != ?)
       ORDER BY received_at DESC
       LIMIT 6`,
    )
      .bind(input.senderE164, input.sinceIso, input.wamid)
      .all<{
        id: string;
        wamid: string | null;
        payload_json: string | null;
        inbound_text?: string | null;
        terminal_state?: string | null;
      }>();
    for (const row of rows.results ?? []) {
      if (isWhatsAppTerminalState(row.terminal_state)) continue;
      const text = (row.inbound_text || extractTextFromPayload(row.payload_json) || "").trim();
      const wamid = String(row.wamid ?? "").trim();
      if (!wamid || !text) continue;
      if (looksLikeBurstCompanion(text)) {
        return { wamid, text, eventId: row.id };
      }
    }
  } catch {
    try {
      const rows = await env.DB.prepare(
        `SELECT id, wamid, payload_json
         FROM whatsapp_inbound_events
         WHERE sender_e164 = ? AND received_at >= ?
         ORDER BY received_at DESC
         LIMIT 6`,
      )
        .bind(input.senderE164, input.sinceIso)
        .all<{ id: string; wamid: string | null; payload_json: string | null }>();
      for (const row of rows.results ?? []) {
        const wamid = String(row.wamid ?? "").trim();
        if (!wamid || wamid === input.wamid) continue;
        const text = extractTextFromPayload(row.payload_json);
        if (text && looksLikeBurstCompanion(text)) {
          return { wamid, text, eventId: row.id };
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function maybeCoalesceBurst(
  env: Env,
  input: { senderE164: string; wamid: string; coalesceMs: number },
): Promise<SiblingInbound | null> {
  const windowMs = Math.max(0, Math.min(500, input.coalesceMs));
  if (windowMs <= 0) return null;
  await sleepMs(windowMs);
  const since = new Date(Date.now() - 2_000).toISOString();
  return peekRecentSiblingInbound(env, {
    senderE164: input.senderE164,
    wamid: input.wamid,
    sinceIso: since,
  });
}

export function combinedBurstReply(companionText: string): string {
  if (isGenericDocumentAsk(companionText)) return COMBINED_GREETING_DOCUMENT_REPLY;
  return "Hi 👋 Of course — I’ll look into that.";
}

function extractTextFromPayload(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      entry?: Array<{
        changes?: Array<{
          value?: { messages?: Array<{ text?: { body?: string } }> };
        }>;
      }>;
    };
    for (const entry of parsed.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (typeof message.text?.body === "string" && message.text.body.trim()) {
            return message.text.body.trim();
          }
        }
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function senderE164FromDigits(from: string | null | undefined): string | null {
  const digits = String(from ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}
