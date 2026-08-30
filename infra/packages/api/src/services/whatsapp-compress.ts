import { documentResultCopy } from "./whatsapp-tone";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export const CONCISE_MAX_CHARS = 520;
export const FULL_DETAIL_MAX_CHARS = 1600;
export const ACK_AFTER_MS = 800;

export function wantsFullDetail(text: string): boolean {
  return /\b(full detail|more detail|full document|the whole|give me the full|give me (more )?detail|entire (doc|document|thing)|paste (it|the)|everything in (it|the)|explain properly|full summary|show me (more|everything)|tell me more)\b/i.test(
    text,
  );
}

export function wantsVeryShort(text: string): boolean {
  return /\b(quickly|briefly|just tell me|in brief|short version)\b/i.test(text);
}

export function wantsSummary(text: string): boolean {
  return /\bsummaris[ee](\s+(that|it|this|the))?\b|\bsummarize(\s+(that|it|this|the))?\b|\b(quick summary)\b/i.test(
    text,
  );
}

export function wantsAlternatives(text: string): boolean {
  return /\b(alternatives?|other (results?|matches|documents?)|what else|more results)\b/i.test(text);
}

export function sanitizeWhatsAppSource(text: string, options?: { keepUrls?: boolean }): string {
  let next = String(text ?? "").replace(/\r\n/g, "\n");
  next = next.replace(UUID_RE, "");
  next = next.replace(EMAIL_RE, "");
  next = next.replace(/^#{1,6}\s+/gm, "");
  next = next.replace(/\\#/g, "");
  next = next.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  next = next.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  next = next.replace(/```[\s\S]*?```/g, "");
  next = next.replace(/^\s*\|.+\|\s*$/gm, "");
  if (!options?.keepUrls) {
    next = next.replace(/https?:\/\/\S+/gi, "");
  }
  next = next.replace(/jsessionid=\S+/gi, "");
  next = next.replace(/__EMPTY(_\d+)?/g, "");
  next = next.replace(/\b(PDFFormatVersion|IsLinearized|IsAcroFormPresent|IsXFAPresent|IsCollectionPresent|IsSignaturesPresent|CreationDate|ModDate|Producer|PDFFormat)\b[^\n]*/gi, "");
  next = next.replace(/^\s*Metadata\s*$/gim, "");
  next = next.replace(/Description automatically generated[^\n]*/gi, "");
  next = next.replace(/This is a secure page[^\n]*/gi, "");
  next = next.replace(/\b(mobile|tel|telephone|phone|e-?mail|address|fax|dob)\s*:/gi, "\n");
  next = next.replace(/^\s*\+?\d[\d\s-]{6,}\s*$/gm, "");
  next = next.replace(/[ \t]{2,}/g, " ");
  next = next.replace(/\n{3,}/g, "\n\n");
  return next.trim();
}

function cleanTitle(title: string): string {
  return sanitizeWhatsAppSource(title).replace(/\s+/g, " ").trim() || "Document";
}

function isFieldNoise(sentence: string): boolean {
  const t = sentence.trim();
  if (/^(mobile|tel|telephone|phone|e-?mail|address|fax|dob|date of birth)\s*:/i.test(t)) return true;
  if (/\b(?:mobile|tel|telephone|phone)\s*:\s*\+?\d{6,}/i.test(t)) return true;
  if (/^(references?|education|experience|skills|contents|index|curriculum vitae)\s*$/i.test(t)) {
    return true;
  }
  if (t.length < 28 && /^(references?|erences)\b/i.test(t)) return true;
  if (t.length < 50 && /driving licence/i.test(t) && !/\b(from|with|who|worked|held)\b/i.test(t)) {
    return true;
  }
  return false;
}

function isJunkSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (t.length < 18) return true;
  if (isFieldNoise(t)) return true;
  if (/^(page \d+|contents|metadata|confirmation \|)/i.test(t)) return true;
  if (/ssl\/tls|secure socket layer|1\/1|o'clock/i.test(t)) return true;
  if (/^[\d./:\sPMAM]+$/i.test(t)) return true;
  if ((t.match(/\|/g) ?? []).length >= 3) return true;
  return false;
}

function firstUsefulSentences(text: string, max = 2): string {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) =>
      part
        .replace(/^[-•]\s*/, "")
        .replace(/^(?:[^.?\n]{0,40}\blicence)\s+(?=[A-Z])/i, "")
        .trim(),
    )
    .filter((part) => part && !isJunkSentence(part));
  const picked = parts.slice(0, max).join(" ");
  return picked.length > 280 ? `${picked.slice(0, 277).trim()}…` : picked;
}

const FINANCIAL_HINT = /\b(invoice|payment confirmation|order id|paid|amount due|total due|payment was successful)\b/i;

function isIdLikeToken(value: string): boolean {
  const token = value.trim();
  if (token.length < 4 || token.length > 40) return false;
  if (/^(references?|erences|email|mobile|phone|amount)$/i.test(token)) return false;
  return /\d/.test(token) || /^[A-Z]{2,}[-/][A-Z0-9]+$/i.test(token);
}

export function extractKeyFacts(text: string): { amount?: string; reference?: string } {
  const financial = FINANCIAL_HINT.test(text);
  let amount: string | undefined;
  for (const match of text.matchAll(/£\s?[\d,]+(?:\.\d{2})?/g)) {
    const idx = match.index ?? 0;
    const window = text.slice(Math.max(0, idx - 48), idx + match[0].length + 24);
    if (/\b(amount|total|paid|payment|invoice|order id|fee)\b/i.test(window) && financial) {
      amount = match[0].replace(/\s+/g, " ");
      break;
    }
  }
  const order = text.match(
    /\b(?:order[ -]?id|ref(?:erence)?(?:\s*(?:no\.?|number|#))?)\s*[:.#-]\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/i,
  );
  const reference = order?.[1] && isIdLikeToken(order[1]) ? order[1] : undefined;
  return { amount, reference };
}

export function inferRelatesTo(title: string, text: string): string {
  const hay = `${title}\n${text}`;
  if (/coal search/i.test(hay) && /payment/i.test(hay)) {
    return "It relates to a coal-search payment confirmation.";
  }
  if (/coal search/i.test(title) || /coal search/i.test(text)) {
    return "It relates to a coal search for the property.";
  }
  if (/rental|arnold crescent/i.test(hay)) {
    return "It relates to rental / investment information for Arnold Crescent.";
  }
  const first = firstUsefulSentences(text, 1);
  if (first && !isFieldNoise(first) && !/^(mobile|email|tel|phone|reference)\b/i.test(first)) {
    const clipped = first.replace(/^this (document|file) /i, "");
    return /^it relates/i.test(clipped) ? clipped : `It relates to ${clipped.charAt(0).toLowerCase()}${clipped.slice(1)}`;
  }
  return `This is ${cleanTitle(title)} from your connected files.`;
}

export function compressDocumentAnswer(input: {
  title: string;
  text?: string | null;
  question: string;
}): string {
  const title = cleanTitle(input.title);
  const clean = sanitizeWhatsAppSource(input.text ?? "");
  if (wantsFullDetail(input.question)) {
    const body = firstUsefulSentences(clean, 10) || clean.slice(0, FULL_DETAIL_MAX_CHARS);
    return trimReply(`${title}\n\n${body}`, FULL_DETAIL_MAX_CHARS);
  }
  if (wantsSummary(input.question)) {
    const summary = firstUsefulSentences(clean, 3) || inferRelatesTo(title, clean);
    return trimReply(`${title}\n\n${summary}`, CONCISE_MAX_CHARS);
  }
  const relates = inferRelatesTo(title, clean);
  const facts = extractKeyFacts(clean);
  if (wantsVeryShort(input.question)) {
    return trimReply(`I found ${title} 📄\n${relates}`, 240);
  }
  return trimReply(
    documentResultCopy({
      title,
      relates,
      amount: facts.amount,
      reference: facts.reference,
    }),
    CONCISE_MAX_CHARS,
  );
}

export function compressSearchAnswer(input: {
  title: string;
  snippet?: string | null;
  question: string;
}): string {
  return compressDocumentAnswer({
    title: input.title,
    text: input.snippet ?? "",
    question: input.question,
  });
}

export function compressToolResult(result: unknown, question: string): string {
  if (result == null) {
    return "I looked this up but did not get a usable summary.";
  }
  if (typeof result === "string") {
    return trimReply(sanitizeWhatsAppSource(result), wantsFullDetail(question) ? FULL_DETAIL_MAX_CHARS : CONCISE_MAX_CHARS);
  }
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const summary =
      (typeof record.summary === "string" && record.summary) ||
      (typeof record.text === "string" && record.text) ||
      (typeof record.message === "string" && record.message);
    if (summary) {
      return trimReply(sanitizeWhatsAppSource(summary), wantsFullDetail(question) ? FULL_DETAIL_MAX_CHARS : CONCISE_MAX_CHARS);
    }
  }
  return "I found matching business data. Ask a more specific follow-up if you need a narrower figure.";
}

export function looksLikeRawToolDump(text: string): boolean {
  const t = String(text ?? "");
  if (/```|__EMPTY|PDFFormatVersion|jsessionid=|Also found:/i.test(t)) return true;
  if (/^\s*[{\[]/.test(t)) return true;
  if ((t.match(/\|/g) ?? []).length >= 6) return true;
  if (t.length > FULL_DETAIL_MAX_CHARS + 200) return true;
  return false;
}

const ANSWER_STOP = new Set([
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
]);

function questionTerms(question: string): string[] {
  return String(question ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 3 && !ANSWER_STOP.has(token));
}

function fuzzyIncludes(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  if (term.length < 5) return false;
  return haystack.split(/[^a-z0-9]+/).some((token) => token.length >= 5 && editDistance(token, term) <= 1);
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 1) return 2;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) grid[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      grid[i]![j] = Math.min(grid[i - 1]![j]! + 1, grid[i]![j - 1]! + 1, grid[i - 1]![j - 1]! + cost);
    }
  }
  return grid[left.length]![right.length]!;
}

export function answerFromDocument(input: { title: string; text?: string | null; question: string }): string {
  const title = cleanTitle(input.title);
  const clean = sanitizeWhatsAppSource(input.text ?? "");
  const terms = questionTerms(input.question);
  const distinctive = terms.filter((term) => term.length >= 4);
  const hay = clean.toLowerCase();
  const missing = distinctive.filter((term) => !fuzzyIncludes(hay, term));
  if (distinctive.length && missing.length === distinctive.length) {
    const topic = missing.slice(0, 2).join(" or ");
    return `I read ${title}. It does not mention ${topic}.`;
  }
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/^[-•]\s*/, "").trim())
    .filter((part) => part && !isJunkSentence(part));
  const scored = sentences
    .map((sentence) => ({
      sentence,
      hits: terms.filter((term) => fuzzyIncludes(sentence.toLowerCase(), term)).length,
    }))
    .filter((row) => row.hits > 0)
    .sort((left, right) => right.hits - left.hits);
  if (scored.length) {
    const body = scored
      .slice(0, 3)
      .map((row) => row.sentence)
      .join(" ");
    return trimReply(`${title}\n\n${body}`, CONCISE_MAX_CHARS);
  }
  return compressDocumentAnswer({ title, text: clean, question: "summarise it" });
}

function trimReply(text: string, maxChars: number): string {
  const next = sanitizeWhatsAppSource(text);
  if (next.length <= maxChars) return next;
  const cut = next.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return (lastBreak > 80 ? cut.slice(0, lastBreak + 1) : cut).trim();
}
