import { newId, nowIso } from "../../db/mappers.js";
import { CURRENT_BUSINESS_DATA_PROTOCOL, INTELLIGENCE_TOOL_NAMES } from "./catalogue.js";
import { resolveBrainPolicy } from "./brain-policy.js";
import { classifyEvidenceNeed, sanitiseEvidenceForModel, stripSecretsFromText } from "./evidence.js";
import { inspectOpenAiKey, normaliseOpenAiToolName, redactOpenAiError, runOpenAiResponses } from "./openai-responses.js";
import { classifyScope } from "./scope.js";
import type {
  IntelligenceConversationState,
  IntelligenceEnv,
  IntelligenceTurnResult,
  ShadowEvalRecord,
} from "./types.js";

const SHADOW_TABLE = `CREATE TABLE IF NOT EXISTS openai_brain_shadow_evals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  channel TEXT,
  correlation_id TEXT,
  user_visible_provider TEXT NOT NULL,
  shadow_provider TEXT NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  cost_basis TEXT,
  estimated_cost_usd REAL,
  tool_proposal TEXT,
  failure TEXT,
  reused_evidence INTEGER,
  created_at TEXT NOT NULL
)`;

export type ShadowDb = {
  prepare(query: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all(): Promise<{ results: Array<Record<string, unknown>> }>;
    };
    run(): Promise<unknown>;
  };
};

export type OpenAiSmokeResult = {
  ok: boolean;
  success: boolean;
  model: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  estimatedCostUsd: number | null;
  costBasis: "estimated" | "unknown";
  correlationId: string | null;
  failure: string | null;
  replyClass: "pong" | "other" | "empty";
  keyConfigured: boolean;
  businessConnectorsUsed: false;
};

export async function runOpenAiConnectivitySmoke(env: IntelligenceEnv): Promise<OpenAiSmokeResult> {
  const correlationId = `openai-smoke-${Date.now().toString(36)}`;
  const key = inspectOpenAiKey(env);
  const result = await runOpenAiResponses(env, {
    system: "You are a connectivity probe. Reply with exactly one lowercase word. No punctuation.",
    user: "Reply with the single word pong",
    permittedTools: [],
    mode: "synthesise",
    correlationId,
    userText: "pong",
  });
  const text = stripSecretsFromText(result.text).trim().toLowerCase();
  const replyClass = text === "pong" ? "pong" : text ? "other" : "empty";
  return {
    ok: !result.failure && replyClass !== "empty",
    success: !result.failure && replyClass === "pong",
    model: result.usage.model,
    latencyMs: result.usage.latencyMs,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cachedTokens: result.usage.cachedTokens ?? null,
    estimatedCostUsd: result.usage.estimatedCostUsd,
    costBasis: result.usage.costBasis ?? "unknown",
    correlationId,
    failure: result.failure ? redactOpenAiError(result.failure) : null,
    replyClass,
    keyConfigured: key.configured,
    businessConnectorsUsed: false,
  };
}

export async function evaluateOpenAiShadow(input: {
  env: IntelligenceEnv;
  text: string;
  state: IntelligenceConversationState;
  live: IntelligenceTurnResult;
  correlationId?: string | null;
}): Promise<ShadowEvalRecord> {
  const evidence = sanitiseEvidenceForModel(input.state.recentEvidence ?? input.live.recentEvidence);
  const reusedEvidence = evidence !== "none";
  const correlationId = input.correlationId || input.live.correlationId || `openai-shadow-${Date.now().toString(36)}`;
  const permitted = input.state.permittedTools.length ? input.state.permittedTools : undefined;
  const scoped = classifyScope(input.text, input.state);
  const evidenceNeed = classifyEvidenceNeed(input.text, input.state);
  const requireTool =
    evidenceNeed === "NEEDS_FRESH_DATA" &&
    (scoped.scope === "BUSINESS_SYSTEM" ||
      scoped.scope === "COMPANY_KNOWLEDGE" ||
      scoped.scope === "SYSTEM_META" ||
      scoped.scope === "CONNECTOR_CAPABILITY");
  const result = await runOpenAiResponses(input.env, {
    system: stripSecretsFromText(
      [
        "Shadow evaluation only. Do not address the customer and do not execute tools yourself.",
        CURRENT_BUSINESS_DATA_PROTOCOL,
        "If a tool is required, emit a native function call for that INFRA tool. Do not write a prose or JSON answer instead of the function call.",
        "Only reply with JSON {\"action\":\"answer\",\"text\":\"short\"} when no INFRA tool is required.",
        "If you must name a tool in JSON, use {\"action\":\"call_tool\",\"name\":\"exact_tool_name\",\"arguments\":{}}.",
      ].join("\n"),
    ),
    user: stripSecretsFromText(
      [
        `User: ${input.text}`,
        `Scope: ${scoped.scope}. Evidence need: ${evidenceNeed}.`,
        `Authorised evidence:\n${evidence}`,
        requireTool
          ? "This turn depends on current company data that is not in evidence. Call the matching INFRA function now."
          : "If evidence already answers this turn, do not call a business tool.",
      ].join("\n\n"),
    ),
    permittedTools: permitted,
    mode: reusedEvidence && !requireTool ? "synthesise" : "decide",
    correlationId,
    userText: input.text,
    toolChoice: requireTool ? "required" : "auto",
  });
  const proposed = [
    ...(result.toolCalls ?? []).map((call) => normaliseOpenAiToolName(call.name)),
    ...toolNamesFromStructured(result.structured),
    ...toolNamesFromText(result.text),
  ].filter(Boolean);
  return {
    provider: "openai",
    model: result.usage.model,
    latencyMs: result.usage.latencyMs,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    cachedTokens: result.usage.cachedTokens ?? null,
    estimatedCostUsd: result.usage.estimatedCostUsd,
    costBasis: result.usage.costBasis ?? "unknown",
    correlationId,
    toolProposal: [...new Set(proposed)],
    failure: result.failure ? redactOpenAiError(result.failure) : null,
    reusedEvidence,
    executedLiveTools: false,
    userVisibleProvider: "cloudflare",
  };
}

export async function persistShadowEval(
  db: ShadowDb,
  record: ShadowEvalRecord,
  companyId: string,
  channel: string,
): Promise<string> {
  await db.prepare(SHADOW_TABLE).run();
  const id = newId("oshadow");
  await db
    .prepare(
      `INSERT INTO openai_brain_shadow_evals (
        id, company_id, channel, correlation_id, user_visible_provider, shadow_provider,
        model, latency_ms, prompt_tokens, completion_tokens, cached_tokens, cost_basis,
        estimated_cost_usd, tool_proposal, failure, reused_evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      companyId,
      channel,
      record.correlationId,
      record.userVisibleProvider,
      record.provider,
      record.model,
      record.latencyMs,
      record.promptTokens,
      record.completionTokens,
      record.cachedTokens,
      record.costBasis,
      record.estimatedCostUsd,
      record.toolProposal.join(","),
      record.failure,
      record.reusedEvidence ? 1 : 0,
      nowIso(),
    )
    .run();
  return id;
}

export async function listRecentShadowEvals(
  db: ShadowDb,
  companyId: string,
  limit = 8,
): Promise<Array<Record<string, unknown>>> {
  await db.prepare(SHADOW_TABLE).run();
  const result = await db
    .prepare(
      `SELECT id, company_id, channel, correlation_id, user_visible_provider, shadow_provider,
              model, latency_ms, prompt_tokens, completion_tokens, cached_tokens, cost_basis,
              estimated_cost_usd, tool_proposal, failure, reused_evidence, created_at
         FROM openai_brain_shadow_evals
        WHERE company_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(companyId, limit)
    .all();
  return result.results ?? [];
}

export function shouldRunOpenAiShadow(input: {
  env?: IntelligenceEnv | null;
  companyId?: string | null;
  channel?: string | null;
  completerInjected?: boolean;
}): boolean {
  if (input.completerInjected) return false;
  const policy = resolveBrainPolicy({ env: input.env, companyId: input.companyId, channel: input.channel });
  return policy.shadow && inspectOpenAiKey(input.env ?? {}).configured;
}

function toolNamesFromStructured(structured: Record<string, unknown> | null | undefined): string[] {
  if (!structured) return [];
  const name = normaliseOpenAiToolName(structured.name ?? structured.tool);
  if (structured.action === "call_tool" && name) return [name];
  return name && INTELLIGENCE_TOOL_NAMES.has(name) ? [name] : [];
}

function toolNamesFromText(text: string): string[] {
  const blob = String(text ?? "");
  return [...INTELLIGENCE_TOOL_NAMES].filter((name) => blob.includes(name));
}

export function publicShadowFields(record: ShadowEvalRecord | null | undefined): {
  shadowProvider: string | null;
  shadowModel: string | null;
  shadowLatencyMs: number | null;
  shadowPromptTokens: number | null;
  shadowCompletionTokens: number | null;
  shadowToolProposal: string[];
  shadowFailure: string | null;
} {
  if (!record) {
    return {
      shadowProvider: null,
      shadowModel: null,
      shadowLatencyMs: null,
      shadowPromptTokens: null,
      shadowCompletionTokens: null,
      shadowToolProposal: [],
      shadowFailure: null,
    };
  }
  return {
    shadowProvider: record.provider,
    shadowModel: record.model,
    shadowLatencyMs: record.latencyMs,
    shadowPromptTokens: record.promptTokens,
    shadowCompletionTokens: record.completionTokens,
    shadowToolProposal: record.toolProposal,
    shadowFailure: record.failure,
  };
}
