/** Shared title-token helpers. Not a product phrase list — no company-specific titles. */

const TITLE_STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "document",
  "documents",
  "doc",
  "file",
  "files",
  "from",
  "with",
  "about",
  "into",
  "your",
  "our",
  "my",
  "use",
  "please",
]);

const WEAK_TOPIC = new Set([
  "policy",
  "policies",
  "report",
  "reports",
  "profile",
  "profiles",
  "summary",
  "summaries",
  "agreement",
  "agreements",
]);

export function titleTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TITLE_STOP.has(token));
}

export function distinctiveTopicTokens(value: string | null | undefined): string[] {
  return titleTokens(value).filter((token) => !WEAK_TOPIC.has(token));
}

export function titleTokenOverlap(left: string | null | undefined, right: string | null | undefined): number {
  const a = new Set(titleTokens(left));
  if (!a.size) return 0;
  let hits = 0;
  for (const token of titleTokens(right)) {
    if (a.has(token)) hits += 1;
  }
  return hits;
}

export function isWeakTopicToken(token: string): boolean {
  return WEAK_TOPIC.has(token.toLowerCase()) || TITLE_STOP.has(token.toLowerCase());
}
