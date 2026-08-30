const STOP_WORDS = new Set([
  "find",
  "the",
  "our",
  "for",
  "and",
  "about",
  "documents",
  "document",
  "files",
  "file",
  "search",
  "relating",
  "what",
  "have",
  "we",
  "do",
  "with",
  "from",
  "this",
  "that",
  "your",
  "please",
]);

export function searchTokens(query?: string | null): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9@/_-]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part));
}

export function buildGraphKeywordQuery(raw: string): string {
  const words = searchTokens(raw);
  const inner = (words.length ? words.join(" AND ") : raw).replace(/["\\]/g, " ").trim();
  return inner ? `isDocument:true AND (${inner})` : "isDocument:true";
}
