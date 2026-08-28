/**
 * Parse explicit source scope from natural-language knowledge search queries.
 * Server-side enforcement — does not rely on LLM prompt instructions alone.
 */

export type KnowledgeSourceScope =
  | "ALL"
  | "MICROSOFT_365"
  | "ONEDRIVE"
  | "SHAREPOINT"
  | "OUTLOOK_SHARED"
  | "GOOGLE_DRIVE";

export type KnowledgeSourceFilters = {
  source?: string;
  category?: string;
};

const SCOPE_PATTERNS: Array<{
  scope: KnowledgeSourceScope;
  pattern: RegExp;
}> = [
  {
    scope: "MICROSOFT_365",
    pattern:
      /\b(?:search\s+)?microsoft\s+365\s+only(?:\s+for)?\s+/i,
  },
  {
    scope: "SHAREPOINT",
    pattern: /\bsearch\s+sharepoint(?:\s+for)?\s+/i,
  },
  {
    scope: "ONEDRIVE",
    pattern: /\bsearch\s+(?:my\s+)?onedrive(?:\s+for)?\s+/i,
  },
  {
    scope: "OUTLOOK_SHARED",
    pattern: /\bsearch\s+(?:the\s+)?shared\s+mailbox(?:\s+for)?\s+/i,
  },
  {
    scope: "GOOGLE_DRIVE",
    pattern: /\bsearch\s+google\s+drive(?:\s+for)?\s+/i,
  },
  {
    scope: "ALL",
    pattern: /\bsearch\s+company\s+knowledge(?:\s+for)?\s+/i,
  },
];

export function scopeToKnowledgeFilters(
  scope: KnowledgeSourceScope,
): KnowledgeSourceFilters {
  switch (scope) {
    case "MICROSOFT_365":
      return { source: "microsoft_365" };
    case "ONEDRIVE":
      return { category: "onedrive" };
    case "SHAREPOINT":
      return { category: "sharepoint" };
    case "OUTLOOK_SHARED":
      return { category: "outlook_shared" };
    case "GOOGLE_DRIVE":
      return { source: "google_drive" };
    default:
      return {};
  }
}

export function resolveKnowledgeSourceScope(query: string): {
  cleanedQuery: string;
  scope: KnowledgeSourceScope;
  filters: KnowledgeSourceFilters;
} {
  const trimmed = query.trim();
  for (const { scope, pattern } of SCOPE_PATTERNS) {
    if (pattern.test(trimmed)) {
      const cleanedQuery = trimmed.replace(pattern, "").trim() || trimmed;
      return {
        cleanedQuery,
        scope,
        filters: scopeToKnowledgeFilters(scope),
      };
    }
  }
  return { cleanedQuery: trimmed, scope: "ALL", filters: {} };
}

export function applyKnowledgeSourceScopeToSearchArgs(
  args: Record<string, unknown>,
): {
  args: Record<string, unknown>;
  scope: KnowledgeSourceScope;
  scopeApplied: boolean;
} {
  const query =
    typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { args, scope: "ALL", scopeApplied: false };
  }

  const resolved = resolveKnowledgeSourceScope(query);
  if (resolved.scope === "ALL") {
    return { args, scope: "ALL", scopeApplied: false };
  }

  const next: Record<string, unknown> = { ...args, query: resolved.cleanedQuery };
  if (resolved.filters.source && !args.source) {
    next.source = resolved.filters.source;
  }
  if (resolved.filters.category && !args.category) {
    next.category = resolved.filters.category;
  }
  return {
    args: next,
    scope: resolved.scope,
    scopeApplied: true,
  };
}
