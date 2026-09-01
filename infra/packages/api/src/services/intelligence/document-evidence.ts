import { NONE_IN_DOCUMENT_REPLY, synthesizeFromDocumentEvidence } from "../whatsapp-grounded-qa.js";
import type { IntelligenceConfidence, IntelligenceDocumentRef, IntelligenceToolResult } from "./types.js";

export function searchHits(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  return Array.isArray(results) ? results : [];
}

export function hitToDocument(hit: unknown): IntelligenceDocumentRef | null {
  if (!hit || typeof hit !== "object") return null;
  const row = hit as Record<string, unknown>;
  const id = String(row.id ?? row.document_id ?? row.documentId ?? "").trim();
  const title = String(row.title ?? "").trim();
  if (!id || !title) return null;
  const url = typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : null;
  return { id, title, url };
}

export function adoptFromSearchHits(
  toolCalls: IntelligenceToolResult[],
  current: IntelligenceDocumentRef | null,
  answerText?: string,
): IntelligenceDocumentRef | null {
  if (current) return current;
  const hits = searchHits(toolCalls.find((call) => call.name === "search_company_knowledge")?.data);
  if (hits.length === 1) return hitToDocument(hits[0]);
  if (answerText && hits.length > 1) {
    const mentioned = hits
      .map(hitToDocument)
      .filter((doc): doc is IntelligenceDocumentRef => Boolean(doc))
      .filter((doc) => answerText.toLowerCase().includes(doc.title.toLowerCase().slice(0, 24)));
    if (mentioned.length === 1) return mentioned[0]!;
  }
  return current;
}

export function toolDocumentChunks(toolCalls: IntelligenceToolResult[]): {
  none: boolean;
  title: string;
  chunks: Array<{ text: string; heading?: string | null; score?: number }>;
} {
  const last = [...toolCalls]
    .reverse()
    .find((call) => call.ok && (call.name === "search_document" || call.name === "get_knowledge_document"));
  if (!last || !last.data || typeof last.data !== "object") {
    return { none: false, title: "", chunks: [] };
  }
  const data = last.data as Record<string, unknown>;
  const raw = Array.isArray(data.chunks) ? data.chunks : [];
  const chunks = raw
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      text: String(row.text ?? ""),
      heading: typeof row.heading === "string" ? row.heading : null,
      score: typeof row.score === "number" ? row.score : undefined,
    }))
    .filter((row) => row.text.trim().length >= 20);
  return {
    none: data.none === true,
    title: String(data.title ?? ""),
    chunks,
  };
}

export function recoverScoutDocumentAnswer(input: {
  decision: { text: string; confidence: IntelligenceConfidence; offer_search_other: boolean };
  toolCalls: IntelligenceToolResult[];
  question: string;
  previousAnswer?: string | null;
  title: string;
  moreDetail?: boolean;
}): { text: string; confidence: IntelligenceConfidence; offerSearchOther: boolean; usedExtractive: boolean } {
  const evidence = toolDocumentChunks(input.toolCalls);
  const scoutEmpty =
    !input.decision.text.trim() ||
    input.decision.confidence === "none" ||
    input.decision.text.includes(NONE_IN_DOCUMENT_REPLY);
  if (evidence.none || !evidence.chunks.length) {
    return {
      text: input.decision.text.trim(),
      confidence: input.decision.confidence,
      offerSearchOther: input.decision.offer_search_other || input.decision.confidence === "none",
      usedExtractive: false,
    };
  }
  if (!scoutEmpty) {
    return {
      text: input.decision.text.trim(),
      confidence: input.decision.confidence,
      offerSearchOther: input.decision.offer_search_other,
      usedExtractive: false,
    };
  }
  const synth = synthesizeFromDocumentEvidence({
    title: evidence.title || input.title,
    question: input.question,
    chunks: evidence.chunks,
    previousAnswer: input.previousAnswer,
    mode: input.moreDetail ? "more_detail" : "answer",
  });
  return {
    text: synth.reply,
    confidence: synth.confidence,
    offerSearchOther: synth.confidence === "none",
    usedExtractive: true,
  };
}

export function documentHasUsableChunks(toolCalls: IntelligenceToolResult[]): boolean {
  const evidence = toolDocumentChunks(toolCalls);
  return !evidence.none && evidence.chunks.length > 0;
}
