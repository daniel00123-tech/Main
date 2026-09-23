import { INTELLIGENCE_TOOL_NAMES } from "./catalogue.js";
import type { IntelligenceConfidence, IntelligenceDecision } from "./types.js";

export type RecoveredDecision = IntelligenceDecision & { recovered?: boolean; source?: string };

export function parseIntelligenceDecision(raw: string): IntelligenceDecision {
  const { decision } = recoverDecision({ text: raw });
  if (decision.action === "invalid") return { action: "invalid", reason: decision.reason };
  if (decision.action === "call_tool") {
    return { action: "call_tool", name: decision.name, arguments: decision.arguments };
  }
  if (decision.action === "clarify") return { action: "clarify", text: decision.text };
  return {
    action: "answer",
    text: decision.text,
    confidence: decision.confidence,
    offer_search_other: decision.offer_search_other,
    cite_source: decision.cite_source,
  };
}

export function recoverDecision(input: {
  text?: string | null;
  toolCalls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
  structured?: Record<string, unknown> | null;
}): { decision: RecoveredDecision; malformed: boolean } {
  const native = decisionFromToolCalls(input.toolCalls);
  if (native) return { decision: { ...native, recovered: false, source: "native_tool_calls" }, malformed: false };

  const structured = decisionFromObject(input.structured);
  if (structured && structured.action !== "invalid") {
    return { decision: { ...structured, recovered: false, source: "structured" }, malformed: false };
  }

  const fromJson = decisionFromObject(extractJsonObject(String(input.text ?? "")));
  if (fromJson && fromJson.action !== "invalid") {
    return { decision: { ...fromJson, recovered: false, source: "json" }, malformed: false };
  }

  const repaired = decisionFromObject(extractRepairedJson(String(input.text ?? "")));
  if (repaired && repaired.action !== "invalid") {
    return { decision: { ...repaired, recovered: true, source: "repaired_json" }, malformed: true };
  }

  const proseTool = extractProseToolCall(String(input.text ?? ""));
  if (proseTool) return { decision: { ...proseTool, recovered: true, source: "prose_tool" }, malformed: true };

  const proseAnswer = extractProseAnswer(String(input.text ?? ""));
  if (proseAnswer) return { decision: { ...proseAnswer, recovered: true, source: "prose_answer" }, malformed: true };

  return {
    decision: { action: "invalid", reason: fromJson && "reason" in fromJson ? fromJson.reason : "not_json" },
    malformed: Boolean(String(input.text ?? "").trim()),
  };
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  return parseObjectSlice(candidate);
}

function extractRepairedJson(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let slice = trimmed.slice(start);
  if (!slice.includes("}")) slice = `${slice}"}`;
  const opens = (slice.match(/{/g) ?? []).length;
  const closes = (slice.match(/}/g) ?? []).length;
  if (opens > closes) slice += "}".repeat(opens - closes);
  slice = slice.replace(/,\s*([}\]])/g, "$1");
  return parseObjectSlice(slice);
}

function parseObjectSlice(candidate: string): Record<string, unknown> | null {
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decisionFromToolCalls(
  toolCalls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>,
): RecoveredDecision | null {
  const first = toolCalls?.[0];
  if (!first) return null;
  const name = String(first.name ?? first.function?.name ?? "").trim();
  if (!name || !INTELLIGENCE_TOOL_NAMES.has(name)) return null;
  return {
    action: "call_tool",
    name,
    arguments: asRecord(parseMaybeJson(first.arguments ?? first.function?.arguments)),
  };
}

function decisionFromObject(json: Record<string, unknown> | null | undefined): RecoveredDecision | null {
  if (!json) return { action: "invalid", reason: "not_json" };
  const action = String(json.action ?? json.type ?? json.decision ?? "").trim().toLowerCase();
  if (action === "call_tool" || action === "tool" || action === "function") {
    const name = String(json.name ?? json.tool ?? json.function ?? "").trim();
    if (!name) return { action: "invalid", reason: "missing_tool_name" };
    return { action: "call_tool", name, arguments: asRecord(json.arguments ?? json.args ?? json.parameters) };
  }
  if (action === "answer" || action === "final" || action === "reply") {
    const text = String(json.text ?? json.reply ?? json.message ?? json.content ?? "").trim();
    if (!text) return { action: "invalid", reason: "missing_answer_text" };
    return {
      action: "answer",
      text,
      confidence: normalizeConfidence(json.confidence),
      offer_search_other: Boolean(json.offer_search_other ?? json.offerSearchOther),
      cite_source: Boolean(json.cite_source ?? json.citeSource),
    };
  }
  if (action === "clarify" || action === "ask" || action === "question") {
    const text = String(json.text ?? json.question ?? json.reply ?? "").trim();
    if (!text) return { action: "invalid", reason: "missing_clarify_text" };
    return { action: "clarify", text };
  }
  if (typeof json.name === "string" && INTELLIGENCE_TOOL_NAMES.has(json.name)) {
    return { action: "call_tool", name: json.name, arguments: asRecord(json.arguments ?? json.args ?? json.parameters) };
  }
  return { action: "invalid", reason: "unknown_action" };
}

function extractProseToolCall(raw: string): RecoveredDecision | null {
  const text = String(raw ?? "");
  for (const name of INTELLIGENCE_TOOL_NAMES) {
    if (!text.includes(name)) continue;
    const query = text.match(/query["'\s:=]+([^"'\n]{2,180})/i)?.[1]?.trim();
    const documentId = text.match(/document[_ ]?id["'\s:=]+([a-z0-9._:-]{3,180})/i)?.[1]?.trim();
    const arguments_: Record<string, unknown> = {};
    if (query) arguments_.query = query.replace(/["']$/, "");
    if (documentId) arguments_.document_id = documentId;
    return { action: "call_tool", name, arguments: arguments_ };
  }
  return null;
}

function extractProseAnswer(raw: string): RecoveredDecision | null {
  const text = String(raw ?? "").trim();
  if (text.length < 12 || text.length > 2_400) return null;
  if (/^\s*\{/.test(text)) return null;
  if (/function\(|SELECT |drop table|mcp|vectorize|\bd1\b/i.test(text)) return null;
  return {
    action: "answer",
    text,
    confidence: "partial",
    offer_search_other: /other (doc|document|file)/i.test(text),
    cite_source: /https?:\/\//i.test(text),
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeConfidence(value: unknown): IntelligenceConfidence {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "strong" || raw === "partial" || raw === "none") return raw;
  return "partial";
}

export function validateToolRequest(name: string, args: Record<string, unknown>): {
  ok: boolean;
  name: string;
  arguments: Record<string, unknown>;
  reason?: string;
} {
  const clean = String(name ?? "").trim();
  if (!INTELLIGENCE_TOOL_NAMES.has(clean)) {
    return { ok: false, name: clean, arguments: {}, reason: "unknown_tool" };
  }
  const next = { ...args };
  if (clean === "search_company_knowledge" && !String(next.query ?? "").trim()) {
    return { ok: false, name: clean, arguments: next, reason: "query_required" };
  }
  if (clean === "search_document") {
    if (!String(next.document_id ?? next.documentId ?? next.id ?? "").trim()) {
      return { ok: false, name: clean, arguments: next, reason: "document_id_required" };
    }
    if (!String(next.query ?? "").trim()) next.query = "summarise the current document";
  }
  if (clean === "get_knowledge_document" && !String(next.document_id ?? next.documentId ?? next.id ?? "").trim()) {
    return { ok: false, name: clean, arguments: next, reason: "document_id_required" };
  }
  if (clean === "outlook_search_mailbox" && !String(next.query ?? "").trim()) {
    return { ok: false, name: clean, arguments: next, reason: "query_required" };
  }
  if (clean === "xero_get_invoice" && !String(next.invoice_id ?? next.id ?? "").trim()) {
    return { ok: false, name: clean, arguments: next, reason: "invoice_id_required" };
  }
  return { ok: true, name: clean, arguments: next };
}
