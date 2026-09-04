import { toolFamilyOf } from "./catalogue.js";
import { classifyEvidenceNeed } from "./evidence.js";
import { classifyScope } from "./scope.js";
import { looksPermissionDenied } from "./verbalise-business.js";
import type {
  EngineeringFailureCategory,
  EngineeringFailureEvent,
  IntelligenceTurnResult,
} from "./types.js";

export function newCorrelationId(): string {
  return `intel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function capabilityFromTool(tool?: string | null): string | null {
  const name = String(tool ?? "");
  if (name.startsWith("xero_")) return "xero";
  if (/outlook/i.test(name)) return "outlook";
  if (/knowledge|search_document|list_documents|fetch/.test(name)) return "knowledge";
  if (name === "web_search") return "web.public";
  return name || null;
}

export function classifyTurnFailures(input: {
  result: IntelligenceTurnResult;
  question: string;
  companyId?: string | null;
  channel?: string | null;
  role?: string | null;
}): EngineeringFailureEvent[] {
  const result = input.result;
  const events: EngineeringFailureEvent[] = [];
  const correlationId = result.correlationId || newCorrelationId();
  const lastTool = result.toolCalls.at(-1)?.name ?? null;
  const base = {
    correlationId,
    companyId: input.companyId ?? null,
    channel: input.channel ?? "api",
    capability: capabilityFromTool(lastTool) ?? result.scope ?? null,
    tool: lastTool,
    model: result.model,
    provider: result.provider,
    latencyMs: result.totalModelMs + result.totalToolMs,
    outcome: result.kind,
  };

  const flags = new Set(result.qualityFlags ?? []);
  if (flags.has("wrong_tool")) {
    events.push(event(base, "WRONG_TOOL", { flag: "wrong_tool" }));
  }
  const evidenceNeed = classifyEvidenceNeed(input.question, {
    recentEvidence: result.recentEvidence ?? null,
    lastAnswerText: result.text,
    lastAnswerTopic: result.lastAnswerTopic ?? null,
    currentBusinessSystem: null,
  });
  const scoped = classifyScope(input.question, {
    currentDocument: result.currentDocument,
    currentScope: result.scope ?? null,
    lastAnswerTopic: result.lastAnswerTopic ?? null,
    lastUserIntent: result.lastUserIntent ?? null,
    userCorrection: false,
    recentDocuments: [],
    currentBusinessSystem: null,
    lastSuccessfulTool: lastTool,
  });
  if (
    evidenceNeed === "NEEDS_FRESH_DATA" &&
    result.toolCalls.length === 0 &&
    (scoped.scope === "BUSINESS_SYSTEM" || scoped.scope === "COMPANY_KNOWLEDGE" || scoped.scope === "SYSTEM_META")
  ) {
    events.push(event(base, "EXPECTED_TOOL_MISSING", { scope: scoped.scope, evidenceNeed }));
  }
  if (
    result.toolCalls.some((call) => call.ok) &&
    (/more detail|what exactly would you like|can you give me a little more detail/i.test(result.text) ||
      (result.text.trim().split(/\s+/).length < 8 && /sales_total|messages|invoices|documents/.test(JSON.stringify(result.toolCalls))))
  ) {
    events.push(event(base, "FIRST_ANSWER_INCOMPLETE", { textLength: result.text.length }));
  }
  if (flags.has("user_correction")) {
    events.push(event(base, "USER_CORRECTION_AFTER_BAD_ROUTE", { flag: "user_correction" }));
  }
  if (result.fallbackUsed || flags.has("fallback")) {
    events.push(event(base, "FALLBACK_USED", { fallbackUsed: true }));
  }
  if (result.repaired && (result.guardChecks ?? []).some((check) => !check.ok)) {
    events.push(
      event(base, "QUALITY_GUARD_REPAIR", {
        failedChecks: (result.guardChecks ?? []).filter((check) => !check.ok).map((check) => check.id),
      }),
    );
  }
  if (result.confidence === "none" && result.kind !== "clarify") {
    events.push(event(base, "LOW_CONFIDENCE_FINAL", { confidence: result.confidence }));
  }
  if (result.kind === "failed" && !result.toolCalls.some((call) => call.ok) && !result.text.trim()) {
    events.push(event(base, "NO_FINAL_RESPONSE", { kind: result.kind }));
  }

  const denied = result.toolCalls.filter((call) => !call.ok && looksPermissionDenied(call));
  for (const call of denied) {
    events.push(
      event(
        { ...base, tool: call.name, capability: capabilityFromTool(call.name) },
        "RBAC_DENIAL",
        { errorClass: call.error ?? "permission_denied" },
      ),
    );
  }
  const failed = result.toolCalls.filter((call) => !call.ok && !looksPermissionDenied(call));
  for (const call of failed) {
    const category: EngineeringFailureCategory = call.error === "timeout" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE";
    events.push(
      event(
        { ...base, tool: call.name, capability: capabilityFromTool(call.name), latencyMs: call.latencyMs },
        category,
        { errorClass: call.error ?? "tool_failed" },
      ),
    );
  }

  const successful = result.toolCalls.filter((call) => call.ok);
  const hashes = new Map<string, number>();
  for (const call of successful) {
    const key = `${call.name}:${stableArgs(call)}`;
    hashes.set(key, (hashes.get(key) ?? 0) + 1);
  }
  for (const [key, count] of hashes) {
    if (count > 1) {
      events.push(event(base, "DUPLICATE_TOOL", { key, count }));
      events.push(event(base, "DUPLICATE_TOOL_CALL", { key, count }));
    }
  }

  if (
    result.kind === "failed" &&
    successful.length > 0 &&
    /couldn.?t (reach|complete|find)|need another moment/i.test(result.text)
  ) {
    events.push(event(base, "SYNTHESIS_CONTRADICTION", { successfulTools: successful.map((call) => call.name) }));
  }

  if (successful.length > 0 && /couldn.?t find any/i.test(result.text) && hasPayload(successful)) {
    events.push(event(base, "UNEXPECTED_NO_RESULT", { successfulTools: successful.map((call) => call.name) }));
  }

  if ((result.qualityFlags ?? []).includes("unsupported_answer") && successful.length > 0) {
    events.push(event(base, "EVIDENCE_DROPPED", { flags: [...flags] }));
  }

  const shadowTools = result.shadowEval?.toolProposal ?? [];
  const liveFamilies = new Set(successful.map((call) => toolFamilyOf(call.name)).filter((family) => family !== "none"));
  const shadowFamilies = new Set(shadowTools.map((name) => toolFamilyOf(name)).filter((family) => family !== "none"));
  if (liveFamilies.size > 0 && shadowFamilies.size === 0 && evidenceNeed === "NEEDS_FRESH_DATA") {
    events.push(event(base, "EXPECTED_TOOL_MISSING", { source: "openai_shadow", liveTools: successful.map((call) => call.name) }));
  } else if (liveFamilies.size > 0 && shadowFamilies.size > 0 && [...liveFamilies].some((family) => !shadowFamilies.has(family))) {
    events.push(event(base, "WRONG_TOOL", { source: "openai_shadow", live: [...liveFamilies], shadow: [...shadowFamilies] }));
  }

  return events;
}

function event(
  base: Omit<EngineeringFailureEvent, "id" | "category" | "metadata" | "createdAt">,
  category: EngineeringFailureCategory,
  metadata: Record<string, unknown>,
): EngineeringFailureEvent {
  return {
    id: `ef_${category.toLowerCase()}_${Math.random().toString(36).slice(2, 10)}`,
    category,
    metadata: sanitiseMetadata(metadata),
    createdAt: new Date().toISOString(),
    ...base,
  };
}

export function clusterKey(event: Pick<EngineeringFailureEvent, "category" | "capability" | "tool" | "companyId">): string {
  return [event.category, event.capability ?? "none", event.tool ?? "none", event.companyId ?? "any"].join(":");
}

export function sanitiseMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value).replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { redacted: true };
  }
}

function stableArgs(call: { name: string; data?: unknown }): string {
  try {
    return JSON.stringify(call.data ?? "").slice(0, 80);
  } catch {
    return call.name;
  }
}

function hasPayload(calls: IntelligenceTurnResult["toolCalls"]): boolean {
  return calls.some((call) => /sales_total|messages|invoices|results|documents|subject/.test(JSON.stringify(call.data ?? "")));
}
