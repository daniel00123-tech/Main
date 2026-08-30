import type { ParsedQuery } from "./query-parse";
import { containsPhrase } from "./query-parse";

export interface QueryRouting {
  topics: string[];
  intents: string[];
  boostTerms: string[];
  likelyCategories: string[];
  asksHistorical: boolean;
}

export interface IntentPattern {
  pattern: RegExp;
  intent: string;
  topics: string[];
  boost: string[];
  categories: string[];
}

export function routeSearchQuery(
  parsed: ParsedQuery,
  intentPatterns: readonly IntentPattern[] = []
): QueryRouting {
  const lower = parsed.normalized.toLowerCase();
  const topics = new Set<string>();
  const intents = new Set<string>();
  const boostTerms = new Set<string>(parsed.terms);
  const likelyCategories = new Set<string>();

  for (const entry of intentPatterns) {
    if (entry.pattern.test(lower)) {
      intents.add(entry.intent);
      for (const t of entry.topics) topics.add(t);
      for (const b of entry.boost) boostTerms.add(b);
      for (const c of entry.categories) likelyCategories.add(c);
    }
  }

  for (const phrase of parsed.phrases) {
    for (const word of phrase.split(/\s+/)) {
      if (word.length >= 4) boostTerms.add(word.toLowerCase());
    }
  }

  const asksHistorical =
    /\b(previous|previously|historical|old version|past|was agreed|used to)\b/i.test(
      lower
    ) || parsed.dates.length > 0;

  return {
    topics: [...topics],
    intents: [...intents],
    boostTerms: [...boostTerms],
    likelyCategories: [...likelyCategories],
    asksHistorical,
  };
}

export type { QueryRouting as SearchQueryRouting };
