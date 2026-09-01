import { distinctiveTopicTokens } from "./titles.js";
import type { IntelligenceConversationState, IntelligenceScope } from "./types.js";

const STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "document",
  "documents",
  "doc",
  "file",
  "was",
  "were",
  "what",
  "did",
  "does",
  "who",
  "how",
  "why",
  "when",
  "in",
  "on",
  "of",
  "to",
  "do",
  "he",
  "she",
  "they",
  "it",
  "is",
  "are",
  "with",
  "about",
  "from",
  "into",
  "more",
  "tell",
  "give",
  "allowed",
  "please",
  "find",
  "search",
  "just",
  "also",
  "some",
  "any",
  "something",
]);

const KEEP_SHORT = new Set(["cv", "uk", "hr", "qa", "it"]);

export function queryTerms(query: string): string[] {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => (token.length >= 3 || KEEP_SHORT.has(token)) && !STOP.has(token));
}

export type EnrichmentContext = {
  scope?: IntelligenceScope | null;
  currentTitle?: string | null;
  previousUserText?: string | null;
  lastAnswerTopic?: string | null;
  lastContentQuestion?: string | null;
  userCorrection?: boolean;
  documentChanged?: boolean;
  scopeChanged?: boolean;
};

const SUBJECT_SHIFT =
  /\b(instead|forget|drop|never mind|i meant|wrong|not that|something else|search other|all documents|whole system)\b/i;

const BUSINESS_SYSTEM_ASK =
  /\b(sales|revenue|profit|p&l|pnl|overdue|xero|invoice|turnover|mailbox|outlook|inbox|aged receivables)\b/i;

const FOLLOW_UP_FILLERS = new Set([
  "exactly",
  "specifically",
  "precisely",
  "detail",
  "details",
  "info",
  "information",
  "summary",
  "summarise",
  "summarize",
  "overview",
  "points",
  "point",
  "main",
  "key",
  "keys",
  "gist",
  "else",
  "again",
  "further",
]);

const SHORT_FOLLOW_UP =
  /^(what exactly\??|when\??|when was that\??|who\??|who was that\??|more\??|more detail\??|more details\??|tell me more\??|go on\??|and\??|what about (him|her|them|that|it)\??|what does it say\??|what are the main points\??)$/i;

export function contentQueryTerms(query: string): string[] {
  return queryTerms(query).filter((term) => !FOLLOW_UP_FILLERS.has(term));
}

export function isShortDocumentFollowUp(query: string): boolean {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return false;
  if (SUBJECT_SHIFT.test(trimmed) || BUSINESS_SYSTEM_ASK.test(trimmed)) return false;
  if (SHORT_FOLLOW_UP.test(trimmed)) return true;
  return contentQueryTerms(trimmed).length < 2;
}

export function shouldDecayEnrichment(context: EnrichmentContext, query: string): boolean {
  if (context.userCorrection || context.documentChanged) return true;
  if (SUBJECT_SHIFT.test(query) || BUSINESS_SYSTEM_ASK.test(query)) return true;
  if (context.scopeChanged && context.scope && context.scope !== "CURRENT_DOCUMENT" && context.scope !== "RECENT_ENTITY") {
    return true;
  }
  if (
    context.lastAnswerTopic &&
    context.lastAnswerTopic !== "document" &&
    context.lastAnswerTopic !== "company_knowledge"
  ) {
    return true;
  }
  return false;
}

/**
 * Enrich short CURRENT_DOCUMENT / RECENT_ENTITY follow-ups for CHUNK RETRIEVAL only.
 * Does not lower the global search min score.
 * Reuses recent distinctive context from the SAME document/topic only.
 */
export function enrichDocumentQuery(
  query: string,
  context: EnrichmentContext,
): { query: string; enriched: boolean; terms: string[]; decayed: boolean } {
  const rawTerms = queryTerms(query);
  const decayed = shouldDecayEnrichment(context, query);
  if (decayed) {
    return { query, enriched: false, terms: rawTerms, decayed: true };
  }
  if (contentQueryTerms(query).length >= 2) {
    return { query, enriched: false, terms: rawTerms, decayed: false };
  }
  if (context.scope !== "CURRENT_DOCUMENT" && context.scope !== "RECENT_ENTITY") {
    return { query, enriched: false, terms: rawTerms, decayed: false };
  }

  const extras: string[] = [];
  const prior = context.lastContentQuestion || context.previousUserText;
  if (prior && !SUBJECT_SHIFT.test(prior) && !BUSINESS_SYSTEM_ASK.test(prior)) {
    extras.push(...queryTerms(prior));
  }
  extras.push(...distinctiveTopicTokens(context.currentTitle));
  const merged = [...new Set([...rawTerms, ...extras])].filter(Boolean);
  if (merged.length <= rawTerms.length) {
    return { query, enriched: false, terms: rawTerms, decayed: false };
  }
  return {
    query: `${query} ${extras.join(" ")}`.trim(),
    enriched: true,
    terms: merged,
    decayed: false,
  };
}

export function previousUserText(
  state: Pick<IntelligenceConversationState, "recentTurns" | "lastUserText">,
  currentText: string,
): string | null {
  return previousContentUserText(state, currentText);
}

/** Walk back past short follow-ups so enrichment stays on the same document topic. */
export function previousContentUserText(
  state: Pick<IntelligenceConversationState, "recentTurns" | "lastUserText"> & {
    lastContentQuestion?: string | null;
  },
  currentText: string,
): string | null {
  if (state.lastContentQuestion && state.lastContentQuestion.trim() !== currentText.trim()) {
    return state.lastContentQuestion;
  }
  const prior = [...(state.recentTurns ?? [])]
    .reverse()
    .find(
      (turn) =>
        turn.role === "user" &&
        turn.text.trim() &&
        turn.text.trim() !== currentText.trim() &&
        !isShortDocumentFollowUp(turn.text),
    );
  return prior?.text ?? null;
}

export function nextContentQuestion(input: {
  question: string;
  prior?: string | null;
  reset?: boolean;
}): string | null {
  if (input.reset) {
    return isShortDocumentFollowUp(input.question) ? null : input.question;
  }
  if (isShortDocumentFollowUp(input.question)) {
    return input.prior ?? null;
  }
  return input.question;
}
