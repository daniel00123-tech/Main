import { queryTerms } from "../whatsapp-grounded-qa.js";
import { distinctiveTopicTokens } from "./titles.js";
import type { IntelligenceConversationState, IntelligenceScope } from "./types.js";

export type EnrichmentContext = {
  scope?: IntelligenceScope | null;
  currentTitle?: string | null;
  previousUserText?: string | null;
  lastAnswerTopic?: string | null;
  userCorrection?: boolean;
  documentChanged?: boolean;
  scopeChanged?: boolean;
};

const SUBJECT_SHIFT =
  /\b(instead|forget|drop|never mind|i meant|wrong|not that|something else|search other|all documents|whole system)\b/i;

/**
 * Enrich short CURRENT_DOCUMENT / RECENT_ENTITY follow-ups for CHUNK RETRIEVAL only.
 * Does not lower the global search min score.
 */
export function enrichDocumentQuery(
  query: string,
  context: EnrichmentContext,
): { query: string; enriched: boolean; terms: string[]; decayed: boolean } {
  const rawTerms = queryTerms(query);
  const decayed = Boolean(
    context.userCorrection ||
      context.documentChanged ||
      context.scopeChanged ||
      SUBJECT_SHIFT.test(query) ||
      (context.lastAnswerTopic &&
        context.lastAnswerTopic !== "document" &&
        context.lastAnswerTopic !== "company_knowledge"),
  );
  if (decayed) {
    return { query, enriched: false, terms: rawTerms, decayed: true };
  }
  if (rawTerms.length >= 2) {
    return { query, enriched: false, terms: rawTerms, decayed: false };
  }
  if (context.scope !== "CURRENT_DOCUMENT" && context.scope !== "RECENT_ENTITY") {
    return { query, enriched: false, terms: rawTerms, decayed: false };
  }

  const extras: string[] = [];
  if (context.previousUserText && !SUBJECT_SHIFT.test(context.previousUserText)) {
    extras.push(...queryTerms(context.previousUserText));
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

export function previousUserText(state: Pick<IntelligenceConversationState, "recentTurns" | "lastUserText">, currentText: string): string | null {
  const prior = [...(state.recentTurns ?? [])]
    .reverse()
    .find((turn) => turn.role === "user" && turn.text.trim() && turn.text.trim() !== currentText.trim());
  return prior?.text ?? null;
}
