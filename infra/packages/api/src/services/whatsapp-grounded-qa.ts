import type { Env } from "../env";
import { collectDocumentChunks, type StandardDocumentChunk, type StandardFetchPayload } from "./mcp-knowledge-standard";
import { generateGroundedCompletion, inspectGroundedQaProvider, type GroundedLlmProvider } from "./whatsapp-llm";
import { sanitizeWhatsAppSource } from "./whatsapp-compress";

export type DocumentClass =
  | "cv_resume"
  | "policy_procedure"
  | "invoice_payment"
  | "spreadsheet"
  | "email"
  | "general";

export type GroundedConfidence = "strong" | "partial" | "none";
export type GroundedMode = "answer" | "summarise" | "more_detail";

export type DocumentChunk = {
  id: string;
  documentId: string;
  text: string;
  heading?: string | null;
  index: number;
};

export const NONE_IN_DOCUMENT_REPLY = "I can't see anything in this document that answers that.";
export const SEARCH_OTHER_DOCS_HINT = "I can search other documents if you want.";
export const GLOBAL_SEARCH_MIN_SCORE = 2;
export const DOCUMENT_CHUNK_MIN_SCORE = 1;

const PII_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PII_PHONE = /(?<!\d)(?:\+?\d[\d\s()-]{7,}\d)/g;
const ASKED_CONTACT =
  /\b(phone|mobile|tel|telephone|e-?mail|contact (number|details|email)|how (do i|can i) (call|email|contact))\b/i;

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
const SYNONYMS: Record<string, string[]> = {
  van: ["vehicle", "vehicles", "fleet", "car"],
  vehicle: ["van", "vehicles", "fleet"],
  drive: ["driver", "driving", "driven"],
  fuel: ["petrol", "diesel", "mileage", "litre"],
  sales: ["selling", "sold"],
};

export type GroundedQaResult = {
  reply: string;
  confidence: GroundedConfidence;
  mode: GroundedMode;
  documentId: string;
  documentClass: DocumentClass;
  usedChunkIds: string[];
  scoped: true;
  globalSearchUsed: false;
  provider: GroundedLlmProvider;
  model: string | null;
  synthesisMode: "model" | "extractive_fallback";
  moreDetailNovel: boolean;
  repeatedExcerpt: boolean;
  unsolicitedPii: boolean;
  malformedExtraction: boolean;
};

export function classifyDocument(input: { title?: string | null; text?: string | null; path?: string | null }): DocumentClass {
  const hay = `${input.title ?? ""}\n${input.path ?? ""}\n${String(input.text ?? "").slice(0, 1200)}`.toLowerCase();
  if (
    /\b(curriculum vitae|\bcv\b|resume|résumé|staff profile)\b/.test(hay) ||
    /\b(work experience|employment history|career history|professional experience)\b/.test(hay)
  ) {
    return "cv_resume";
  }
  if (/\b(policy|procedure|guidance|handbook|code of conduct)\b/.test(hay)) {
    return "policy_procedure";
  }
  if (/\b(invoice|payment confirmation|amount due|order id|paid in full)\b/.test(hay)) {
    return "invoice_payment";
  }
  if (/\.(xlsx?|csv)\b/.test(hay) || /__empty/.test(hay) || /\bspreadsheet\b/.test(hay)) {
    return "spreadsheet";
  }
  if (/\b(inbox|outlook|mailbox|from:|subject:)\b/.test(hay) || /\.(eml|msg)\b/.test(hay)) {
    return "email";
  }
  return "general";
}

export function extractTypedFacts(
  text: string,
  documentClass: DocumentClass,
): { amount?: string; reference?: string } {
  if (documentClass !== "invoice_payment") return {};
  let amount: string | undefined;
  for (const match of text.matchAll(/£\s?[\d,]+(?:\.\d{2})?/g)) {
    const idx = match.index ?? 0;
    const window = text.slice(Math.max(0, idx - 48), idx + match[0].length + 24);
    if (/\b(amount|total|paid|payment|invoice|order id|fee)\b/i.test(window)) {
      amount = match[0].replace(/\s+/g, " ");
      break;
    }
  }
  const order = text.match(
    /\b(?:order[ -]?id|ref(?:erence)?(?:\s*(?:no\.?|number|#))?)\s*[:.#-]\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/i,
  );
  const token = order?.[1]?.trim() ?? "";
  const reference = token && /\d/.test(token) ? token : undefined;
  return { amount, reference };
}

export function chunksFromFetchPayload(payload: StandardFetchPayload, documentId: string): DocumentChunk[] {
  const fromPayload = (payload.chunks ?? []).map((chunk, index) => toChunk(chunk, documentId, index));
  const usable = fromPayload.filter((chunk) => chunk.text.trim().length >= 20);
  if (usable.length >= 2) return usable;
  const joined = payload.text || usable.map((chunk) => chunk.text).join("\n\n");
  return structuralChunk(joined, documentId);
}

export function structuralChunk(text: string, documentId: string): DocumentChunk[] {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const lines = clean.split("\n");
  const units: Array<{ heading: string | null; body: string[] }> = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };
  const flush = () => {
    const body = current.body.join("\n").trim();
    if (current.heading || body) units.push({ heading: current.heading, body: current.body.slice() });
    current = { heading: null, body: [] };
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current.body.length) current.body.push("");
      continue;
    }
    if (isStructuralHeading(line)) {
      if (current.heading || current.body.some((part) => part.trim())) flush();
      current.heading = line.replace(/^#{1,6}\s+/, "");
      continue;
    }
    current.body.push(line);
    const joined = current.body.join("\n");
    if (joined.length >= 900) flush();
  }
  flush();
  const chunks: DocumentChunk[] = [];
  let buffer = "";
  let heading: string | null = null;
  const push = () => {
    const textBlock = buffer.trim();
    if (textBlock.length < 20) {
      buffer = "";
      return;
    }
    chunks.push({
      id: `${documentId}:c${chunks.length}`,
      documentId,
      text: heading ? `${heading}\n${textBlock}` : textBlock,
      heading,
      index: chunks.length,
    });
    buffer = "";
  };
  for (const unit of units) {
    const piece = [unit.heading, unit.body.join("\n")].filter(Boolean).join("\n").trim();
    if (!piece) continue;
    if (buffer && buffer.length + piece.length > 900) push();
    heading = unit.heading ?? heading;
    buffer = buffer ? `${buffer}\n\n${piece}` : piece;
    if (buffer.length >= 400) push();
  }
  push();
  return chunks.length ? chunks : [{ id: `${documentId}:c0`, documentId, text: clean.slice(0, 1600), heading: null, index: 0 }];
}

export function searchDocument(
  documentId: string,
  query: string,
  chunks: DocumentChunk[],
  options?: { tenantId?: string | null },
): Array<DocumentChunk & { score: number }> {
  void options?.tenantId;
  const scoped = chunks.filter((chunk) => chunk.documentId === documentId);
  const terms = queryTerms(query);
  return scoped
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, terms, query) }))
    .filter((chunk) => chunk.score >= DOCUMENT_CHUNK_MIN_SCORE || terms.length === 0)
    .sort((left, right) => right.score - left.score);
}

export function scoreGlobalSearchHit(
  hit: {
    id?: string;
    title: string;
    snippet?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  },
  query: string,
  context?: { currentDocumentId?: string | null; preferredClass?: DocumentClass | null },
): number {
  const terms = queryTerms(query);
  const title = String(hit.title ?? "").toLowerCase();
  const snippet = String(hit.snippet ?? "").toLowerCase();
  const path = String(hit.metadata?.path ?? hit.metadata?.folder ?? "").toLowerCase();
  const filename = String(hit.metadata?.filename ?? hit.metadata?.name ?? title).toLowerCase();
  const sourceType = String(hit.metadata?.source ?? hit.metadata?.sourceSystem ?? "").toLowerCase();
  const recency = recencyBoost(hit.metadata);
  const classified = classifyDocument({ title: hit.title, text: hit.snippet, path });
  const queryNorm = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let score = 0;
  if (queryNorm && (title.includes(queryNorm) || filename.includes(queryNorm))) score += 8;
  const generic = new Set(["policy", "document", "documents", "file", "files", "report", "profile", "summary"]);
  for (const term of terms) {
    const weight = generic.has(term) ? 1 : 4;
    if (title.includes(term)) score += weight;
    else if (filename.includes(term)) score += Math.max(1, weight - 1);
    else if (path.includes(term)) score += 2;
    else if (snippet.includes(term)) score += 1;
    else if (expandTerm(term).some((alt) => title.includes(alt) || snippet.includes(alt))) score += 1;
  }
  if (context?.preferredClass && classified === context.preferredClass) score += 1;
  if (context?.currentDocumentId && hit.id && hit.id === context.currentDocumentId) score += 2;
  if (sourceType) score += 0.25;
  score += recency;
  return score;
}

export function rejectWeakSearchHits<T extends { title: string; snippet?: string; id?: string; metadata?: Record<string, unknown> }>(
  hits: T[],
  query: string,
  context?: { currentDocumentId?: string | null; preferredClass?: DocumentClass | null },
): T[] {
  const scored = hits
    .map((hit) => ({ hit, score: scoreGlobalSearchHit(hit, query, context) }))
    .sort((left, right) => right.score - left.score);
  const strong = scored.filter((row) => row.score >= GLOBAL_SEARCH_MIN_SCORE);
  if (strong.length) return strong.map((row) => row.hit);
  if (scored.length === 1 && scored[0]!.score >= 1) return [scored[0]!.hit];
  return [];
}

export function redactUnsolicitedPii(
  text: string,
  question: string,
  documentClass: DocumentClass,
): { text: string; redacted: boolean } {
  if (documentClass !== "cv_resume" || ASKED_CONTACT.test(question)) {
    return { text, redacted: false };
  }
  const next = text.replace(PII_EMAIL, "[contact withheld]").replace(PII_PHONE, "[contact withheld]");
  return { text: next, redacted: next !== text };
}

export function looksLikeUnsolicitedPii(text: string, question: string, documentClass: DocumentClass): boolean {
  if (documentClass !== "cv_resume" || ASKED_CONTACT.test(question)) return false;
  return PII_EMAIL.test(text) || PII_PHONE.test(text);
}

export async function runGroundedQa(
  env: Env,
  input: {
    question: string;
    documentId: string;
    title: string;
    fetch: StandardFetchPayload;
    mode: GroundedMode;
    previousAnswer?: string | null;
    path?: string | null;
    tenantId?: string | null;
    qualityGuidance?: string | null;
  },
): Promise<GroundedQaResult> {
  const documentClass = classifyDocument({
    title: input.title,
    text: input.fetch.text,
    path: input.path,
  });
  const chunks = chunksFromFetchPayload(input.fetch, input.documentId);
  const ranked =
    input.mode === "answer"
      ? searchDocument(input.documentId, input.question, chunks, { tenantId: input.tenantId })
      : chunks.map((chunk, index) => ({ ...chunk, score: Math.max(1, chunks.length - index) }));
  const selected = selectChunks(ranked, input.mode, input.previousAnswer);
  const evidence = selected.map((chunk) => chunk.text).join("\n\n");
  const confidence = confidenceFromEvidence(input.mode, input.question, selected, evidence);
  const facts = extractTypedFacts(evidence, documentClass);
  const malformedExtraction = documentClass === "cv_resume" && Boolean(facts.amount || facts.reference);

  if (confidence === "none") {
    return baseResult(input, documentClass, selected, {
      reply: `${NONE_IN_DOCUMENT_REPLY} ${SEARCH_OTHER_DOCS_HINT}`,
      confidence: "none",
      provider: inspectGroundedQaProvider(env).provider,
      model: inspectGroundedQaProvider(env).model,
      synthesisMode: "extractive_fallback",
      moreDetailNovel: false,
      repeatedExcerpt: false,
      unsolicitedPii: false,
      malformedExtraction,
    });
  }

  const extractive = extractiveAnswer({
    title: input.title,
    mode: input.mode,
    question: input.question,
    evidence,
    chunks: selected,
    previousAnswer: input.previousAnswer,
    confidence,
  });
  const generated = await generateGroundedCompletion(env, {
    system: groundedSystemPrompt(input.mode, input.qualityGuidance),
    user: groundedUserPrompt({
      title: input.title,
      question: input.question,
      mode: input.mode,
      evidence,
      previousAnswer: input.previousAnswer,
    }),
  });
  let raw = generated.ok && generated.text && isGroundedToEvidence(generated.text, evidence)
    ? generated.text
    : extractive;
  if (
    input.mode === "more_detail" &&
    input.previousAnswer &&
    similarText(raw, input.previousAnswer)
  ) {
    raw = extractive;
  }
  const synthesisMode = generated.ok && raw === generated.text ? "model" : "extractive_fallback";
  const pii = redactUnsolicitedPii(raw, input.question, documentClass);
  const repeatedExcerpt = Boolean(input.previousAnswer && similarText(pii.text, input.previousAnswer));
  const moreDetailNovel =
    input.mode !== "more_detail" ||
    (!repeatedExcerpt &&
      (addsInformation(pii.text, input.previousAnswer) ||
        selected.some((chunk) => {
          const needle = normalizeCompare(chunk.text).slice(0, 48);
          return needle.length >= 24 && !normalizeCompare(input.previousAnswer ?? "").includes(needle);
        })));

  return baseResult(input, documentClass, selected, {
    reply: pii.text.trim(),
    confidence,
    provider: generated.provider,
    model: generated.model,
    synthesisMode,
    moreDetailNovel,
    repeatedExcerpt,
    unsolicitedPii: pii.redacted || looksLikeUnsolicitedPii(raw, input.question, documentClass),
    malformedExtraction,
  });
}

function baseResult(
  input: { documentId: string; mode: GroundedMode },
  documentClass: DocumentClass,
  selected: DocumentChunk[],
  rest: Omit<GroundedQaResult, "documentId" | "documentClass" | "usedChunkIds" | "scoped" | "globalSearchUsed" | "mode">,
): GroundedQaResult {
  return {
    ...rest,
    mode: input.mode,
    documentId: input.documentId,
    documentClass,
    usedChunkIds: selected.map((chunk) => chunk.id),
    scoped: true,
    globalSearchUsed: false,
  };
}

function selectChunks(
  ranked: Array<DocumentChunk & { score?: number }>,
  mode: GroundedMode,
  previousAnswer?: string | null,
): Array<DocumentChunk & { score?: number }> {
  if (mode === "summarise") return ranked.slice(0, Math.max(2, Math.ceil(ranked.length / 2)));
  if (mode === "more_detail") {
    const previous = normalizeCompare(previousAnswer ?? "");
    const unused = ranked.filter((chunk) => {
      const needle = normalizeCompare(chunk.text).slice(0, 80);
      return needle.length >= 24 && !previous.includes(needle.slice(0, 48));
    });
    if (unused.length) return unused.slice(0, 6);
    const later = ranked.slice(Math.floor(ranked.length / 2));
    return (later.length ? later : ranked).slice(0, 6);
  }
  return ranked.slice(0, 5);
}

function confidenceFromEvidence(
  mode: GroundedMode,
  question: string,
  chunks: Array<DocumentChunk & { score?: number }>,
  evidence: string,
): GroundedConfidence {
  if (!evidence.trim()) return "none";
  if (mode !== "answer") return chunks.length >= 2 ? "strong" : "partial";
  const terms = queryTerms(question).filter((term) => term.length >= 3 || KEEP_SHORT.has(term));
  if (!terms.length) return chunks.length ? "partial" : "none";
  const hay = evidence.toLowerCase();
  const hits = terms.filter((term) => fuzzyIncludes(hay, term) || expandTerm(term).some((alt) => hay.includes(alt)));
  if (!hits.length) return "none";
  if (hits.length === terms.length && (chunks[0]?.score ?? 0) >= 3) return "strong";
  return "partial";
}

function extractiveAnswer(input: {
  title: string;
  mode: GroundedMode;
  question: string;
  evidence: string;
  chunks: DocumentChunk[];
  previousAnswer?: string | null;
  confidence: GroundedConfidence;
}): string {
  const clean = sanitizeWhatsAppSource(input.evidence, { keepUrls: false });
  if (input.mode === "summarise") {
    const bullets = usefulSentences(clean, 6)
      .slice(0, 5)
      .map((line) => `• ${line}`);
    return [`${input.title}`, ...bullets].join("\n");
  }
  if (input.mode === "more_detail") {
    const extra = usefulSentences(clean, 10).filter((line) => !overlaps(line, input.previousAnswer ?? ""));
    const body = extra.slice(0, 8).join(" ");
    if (body) return `${input.title}\n\n${body}`;
    return `${input.title}\n\nI don't have more distinct detail in this file beyond what I already sent. Ask about a specific part, or search other documents.`;
  }
  const terms = queryTerms(input.question);
  const sentences = usefulSentences(clean, 16);
  const scored = sentences
    .map((sentence) => ({
      sentence,
      hits: terms.filter((term) => fuzzyIncludes(sentence.toLowerCase(), term)).length,
    }))
    .filter((row) => row.hits > 0)
    .sort((left, right) => right.hits - left.hits);
  const body = (scored.length ? scored.slice(0, 4).map((row) => row.sentence) : sentences.slice(0, 3)).join(" ");
  return `${input.title}\n\n${body}`;
}

function groundedSystemPrompt(mode: GroundedMode, qualityGuidance?: string | null): string {
  return [
    "You answer only from the provided document evidence.",
    "Never invent facts, names, dates, roles, or figures that are not in the evidence.",
    "If the evidence does not answer the question, reply exactly:",
    NONE_IN_DOCUMENT_REPLY,
    mode === "summarise" ? "Write a short grounded bullet summary plus key experience or rules." : "",
    mode === "more_detail" ? "Add information that was not in the previous answer. Do not restate the same excerpt." : "",
    "Do not list other documents. Do not mention tools, models, or retrieval.",
    "Do not include phone numbers or email addresses unless the user asked for them.",
    qualityGuidance?.trim() ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

function groundedUserPrompt(input: {
  title: string;
  question: string;
  mode: GroundedMode;
  evidence: string;
  previousAnswer?: string | null;
}): string {
  return [
    `Document: ${input.title}`,
    `Mode: ${input.mode}`,
    `Question: ${input.question}`,
    input.previousAnswer ? `Previous answer:\n${input.previousAnswer.slice(0, 600)}` : "",
    `Evidence:\n${input.evidence.slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isGroundedToEvidence(answer: string, evidence: string): boolean {
  const clean = answer.trim();
  if (!clean) return false;
  if (clean.includes(NONE_IN_DOCUMENT_REPLY)) return true;
  const terms = queryTerms(clean).filter((term) => term.length >= 5);
  if (terms.length < 2) return usefulSentences(evidence, 8).some((sentence) => overlaps(clean, sentence));
  const hay = evidence.toLowerCase();
  const grounded = terms.filter((term) => hay.includes(term)).length;
  return grounded / terms.length >= 0.35;
}

function usefulSentences(text: string, max: number): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/^[-•]\s*/, "").trim())
    .filter((part) => part.length >= 24)
    .filter((part) => !/^(mobile|tel|telephone|phone|e-?mail|address|fax|dob)\s*:/i.test(part))
    .slice(0, max);
}

export function queryTerms(query: string): string[] {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => (token.length >= 3 || KEEP_SHORT.has(token)) && !STOP.has(token));
}

function expandTerm(term: string): string[] {
  return SYNONYMS[term] ?? [];
}

function scoreChunk(chunk: DocumentChunk, terms: string[], query: string): number {
  const hay = chunk.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const alts = [term, ...expandTerm(term)];
    if (alts.some((alt) => chunk.heading?.toLowerCase().includes(alt))) score += 3;
    else if (alts.some((alt) => hay.includes(alt))) score += 2;
    else if (alts.some((alt) => fuzzyIncludes(hay, alt))) score += 1;
  }
  if (!terms.length && query.trim()) score += 1;
  return score;
}

function fuzzyIncludes(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  if (term.length < 5) return false;
  return haystack.split(/[^a-z0-9]+/).some((token) => token.length >= 5 && editDistance(token, term) <= 1);
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 1) return 2;
  let misses = left.length === right.length ? 0 : 1;
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    if (left[i] !== right[i]) misses += 1;
    if (misses > 1) return 2;
  }
  return misses;
}

function overlaps(left: string, right: string): boolean {
  const a = normalizeCompare(left);
  const b = normalizeCompare(right);
  if (!a || !b) return false;
  if (a.includes(b.slice(0, 80)) || b.includes(a.slice(0, 80))) return true;
  return jaccard(a, b) >= 0.72;
}

function similarText(left: string, right: string): boolean {
  return jaccard(normalizeCompare(left), normalizeCompare(right)) >= 0.82;
}

function addsInformation(next: string, previous?: string | null): boolean {
  if (!previous) return true;
  const fresh = queryTerms(next).filter((term) => !normalizeCompare(previous).includes(term));
  return fresh.length >= 3 || next.length > previous.length + 40;
}

function normalizeCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(" ").filter((token) => token.length >= 4));
  const right = new Set(b.split(" ").filter((token) => token.length >= 4));
  if (!left.size || !right.size) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / new Set([...left, ...right]).size;
}

function recencyBoost(metadata?: Record<string, unknown>): number {
  const raw = metadata?.updatedAt ?? metadata?.modifiedAt ?? metadata?.lastModified;
  if (typeof raw !== "string") return 0;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return 0;
  const ageDays = (Date.now() - ms) / 86_400_000;
  if (ageDays < 30) return 1;
  if (ageDays < 180) return 0.5;
  return 0;
}

function isStructuralHeading(line: string): boolean {
  if (/^#{1,6}\s+\S/.test(line)) return true;
  if (/^(19|20)\d{2}\s*[-–]/.test(line)) return true;
  if (line.length <= 72 && /^(experience|education|skills|profile|summary|responsibilities|duties|references|policy|purpose|scope|procedure)\b/i.test(line)) {
    return true;
  }
  if (line.length <= 64 && /^[A-Z][A-Za-z0-9 &/().-]{2,}$/.test(line) && !/[.?!]$/.test(line)) {
    return true;
  }
  return false;
}

function toChunk(chunk: StandardDocumentChunk, documentId: string, index: number): DocumentChunk {
  return {
    id: chunk.id || `${documentId}:c${index}`,
    documentId,
    text: chunk.text,
    heading: chunk.heading ?? null,
    index: chunk.index ?? index,
  };
}

export { collectDocumentChunks };
