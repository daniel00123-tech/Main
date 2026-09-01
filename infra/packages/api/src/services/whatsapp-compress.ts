import { documentResultCopy } from "./whatsapp-tone";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export const CONCISE_MAX_CHARS = 520;
export const FULL_DETAIL_MAX_CHARS = 1600;
export const ACK_AFTER_MS = 800;

export function wantsFullDetail(text: string): boolean {
  return /\b(full detail|full document|the whole|give me the full|give me detail|entire (doc|document|thing)|paste (it|the)|everything in (it|the)|explain properly|full summary|show me everything)\b/i.test(
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
  next = next.replace(/[ \t]{2,}/g, " ");
  next = next.replace(/\n{3,}/g, "\n\n");
  return next.trim();
}

function cleanTitle(title: string): string {
  return sanitizeWhatsAppSource(title).replace(/\s+/g, " ").trim() || "Document";
}

function isJunkSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (t.length < 18) return true;
  if (/^(page \d+|contents|metadata|confirmation \|)/i.test(t)) return true;
  if (/ssl\/tls|secure socket layer|1\/1|o'clock/i.test(t)) return true;
  if (/^[\d./:\sPMAM]+$/i.test(t)) return true;
  if ((t.match(/\|/g) ?? []).length >= 3) return true;
  return false;
}

function firstUsefulSentences(text: string, max = 2): string {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/^[-•]\s*/, "").trim())
    .filter((part) => part && !isJunkSentence(part));
  const picked = parts.slice(0, max).join(" ");
  return picked.length > 280 ? `${picked.slice(0, 277).trim()}…` : picked;
}

function extractKeyFacts(text: string): { amount?: string; reference?: string } {
  const money = text.match(/£\s?[\d,]+(?:\.\d{2})?/);
  const order = text.match(/\b(?:order id|ref(?:\.? no)?\.?)\s*[:.]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/i);
  return {
    amount: money ? money[0].replace(/\s+/g, " ") : undefined,
    reference: order?.[1],
  };
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
  if (first) {
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
    const body = firstUsefulSentences(clean, 8) || clean.slice(0, FULL_DETAIL_MAX_CHARS);
    return trimReply(`${title}\n\n${body}`, FULL_DETAIL_MAX_CHARS);
  }
  if (wantsSummary(input.question)) {
    const summary = firstUsefulSentences(clean, 4) || inferRelatesTo(title, clean);
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

function trimReply(text: string, maxChars: number): string {
  const next = sanitizeWhatsAppSource(text);
  if (next.length <= maxChars) return next;
  const cut = next.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return (lastBreak > 80 ? cut.slice(0, lastBreak + 1) : cut).trim();
}
