export interface ParsedQuery {
  raw: string;
  normalized: string;
  terms: string[];
  phrases: string[];
  postcodes: string[];
  monetaryValues: string[];
  dates: string[];
  referenceNumbers: string[];
  distinctiveTerms: string[];
  titleCasePhrases: string[];
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi;
const MONEY = /£\s?[\d,]+(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g;
const DATE =
  /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/g;
const REF_NUMBER = /\b(?:ref[:\s#-]*)?(\d{5,})\b/gi;
const QUOTED = /"([^"]+)"|'([^']+)'/g;

export function parseSearchQuery(query: string): ParsedQuery {
  const raw = query.trim();
  const normalized = raw.replace(/\s+/g, " ").trim();
  const phrases: string[] = [];
  const quoted = [...normalized.matchAll(QUOTED)];
  for (const match of quoted) {
    const phrase = (match[1] ?? match[2] ?? "").trim();
    if (phrase.length >= 2) phrases.push(phrase);
  }

  const withoutQuotes = normalized.replace(QUOTED, " ");
  const postcodes = [...withoutQuotes.matchAll(UK_POSTCODE)].map((m) =>
    m[1].toUpperCase().replace(/\s+/g, " ")
  );
  const monetaryValues = [...withoutQuotes.matchAll(MONEY)].map((m) => m[0]);
  const dates = [...withoutQuotes.matchAll(DATE)].map((m) => m[0]);
  const referenceNumbers = [...withoutQuotes.matchAll(REF_NUMBER)].map(
    (m) => m[1]
  );

  const titleCasePhrases = extractTitleCasePhrases(withoutQuotes);
  for (const phrase of titleCasePhrases) {
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }

  const terms = withoutQuotes
    .toLowerCase()
    .split(/[^a-z0-9£]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const distinctiveTerms = [
    ...new Set(
      terms.filter(
        (t) =>
          t.length >= 8 ||
          /\d/.test(t) ||
          t.includes("£") ||
          postcodes.some((p) => p.toLowerCase().includes(t))
      )
    ),
  ];

  return {
    raw,
    normalized,
    terms: [...new Set(terms)],
    phrases: [...new Set(phrases)],
    postcodes: [...new Set(postcodes)],
    monetaryValues: [...new Set(monetaryValues)],
    dates: [...new Set(dates)],
    referenceNumbers: [...new Set(referenceNumbers)],
    distinctiveTerms,
    titleCasePhrases,
  };
}

function extractTitleCasePhrases(text: string): string[] {
  const matches = text.match(
    /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}|[A-Z][a-z]+(?:\s+[A-Z][a-z]*)*)\b/g
  );
  if (!matches) return [];
  return matches
    .map((m) => m.trim())
    .filter((m) => m.split(/\s+/).length >= 2 || /^[A-Z][a-z]+$/.test(m));
}

export function buildFtsMatchQuery(parsed: ParsedQuery): string | null {
  const parts: string[] = [];

  for (const phrase of parsed.phrases) {
    const escaped = phrase.replace(/"/g, "").trim();
    if (escaped.length >= 2) parts.push(`"${escaped}"`);
  }

  for (const value of parsed.postcodes) {
    parts.push(value.replace(/"/g, ""));
  }

  for (const value of parsed.monetaryValues) {
    parts.push(value.replace(/"/g, ""));
  }

  for (const value of parsed.referenceNumbers) {
    parts.push(value);
  }

  for (const term of parsed.distinctiveTerms.slice(0, 8)) {
    parts.push(term.replace(/"/g, ""));
  }

  if (parts.length === 0) {
    const fallback = parsed.terms
      .filter((t) => t.length >= 3)
      .slice(0, 6)
      .map((t) => t.replace(/"/g, ""));
    if (fallback.length === 0) return null;
    return fallback.join(" OR ");
  }

  return parts.join(" OR ");
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return haystack.toLowerCase().includes(phrase.toLowerCase());
}

export function containsAnyPhrase(haystack: string, phrases: string[]): boolean {
  return phrases.some((phrase) => containsPhrase(haystack, phrase));
}
