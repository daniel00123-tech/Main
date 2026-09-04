import { withBoundedTimeout } from "../whatsapp-timeouts.js";
import { cloudflareToolDefs } from "./schema.js";
import { extractJsonObject } from "./parse.js";
import { estimateOpenAiCostUsd, pickOpenAiTier, resolveOpenAiModel } from "./openai-models.js";
import type { IntelligenceEnv, IntelligenceModelUsage } from "./types.js";

export const OPENAI_RESPONSES_TIMEOUT_MS = 14_000;
export const OPENAI_RESPONSES_RETRY_TIMEOUT_MS = 8_000;
const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_INPUT_CHARS = 10_000;

export type OpenAiResponsesResult = {
  text: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured?: Record<string, unknown> | null;
  usage: IntelligenceModelUsage;
  failure?: OpenAiProviderFailure;
};

export type OpenAiProviderFailure =
  | "missing_key"
  | "invalid_key"
  | "rate_limit"
  | "timeout"
  | "upstream_5xx"
  | "malformed"
  | "unavailable";

export function hasOpenAiApiKey(env: IntelligenceEnv): boolean {
  return String(env.OPENAI_API_KEY ?? "").trim().length >= 20;
}

export function inspectOpenAiKey(env: IntelligenceEnv): { configured: boolean; lengthClass: "missing" | "present" } {
  return { configured: hasOpenAiApiKey(env), lengthClass: hasOpenAiApiKey(env) ? "present" : "missing" };
}

export function redactOpenAiError(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]");
}

export function classifyOpenAiHttpFailure(status: number): OpenAiProviderFailure {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream_5xx";
  if (status === 404 || status === 408 || status === 409) return "unavailable";
  return "unavailable";
}

export function isTrueProviderFailure(failure?: OpenAiProviderFailure | null): boolean {
  return failure === "timeout" || failure === "upstream_5xx" || failure === "rate_limit" || failure === "unavailable";
}

export async function runOpenAiResponses(
  env: IntelligenceEnv,
  input: {
    system: string;
    user: string;
    permittedTools?: string[];
    mode?: "decide" | "repair" | "synthesise";
    correlationId?: string;
    userText?: string;
  },
): Promise<OpenAiResponsesResult> {
  const started = Date.now();
  const tier = pickOpenAiTier({
    mode: input.mode,
    userText: input.userText ?? input.user,
    hasFreshBusinessQuestion: /\b(xero|sales|invoice|outlook|inbox|email)\b/i.test(input.user),
  });
  const model = resolveOpenAiModel(env, tier);
  if (!hasOpenAiApiKey(env)) {
    return emptyFailure(started, model, "missing_key", input.correlationId);
  }

  const tools = openaiToolsPayload(input.permittedTools);
  const payload = {
    model,
    instructions: clip(input.system, MAX_INSTRUCTION_CHARS),
    input: clip(input.user, MAX_INPUT_CHARS),
    store: false,
    max_output_tokens: input.mode === "synthesise" ? 700 : 640,
    ...(tools ? { tools } : {}),
    metadata: input.correlationId ? { infra_correlation_id: input.correlationId } : undefined,
  };

  const first = await invokeResponses(env, payload, OPENAI_RESPONSES_TIMEOUT_MS, input.correlationId);
  if (first.ok) return toResult(started, model, first.value, input.correlationId);
  if (first.failure === "timeout" || first.failure === "upstream_5xx") {
    const retry = await invokeResponses(env, payload, OPENAI_RESPONSES_RETRY_TIMEOUT_MS, input.correlationId);
    if (retry.ok) {
      const result = toResult(started, model, retry.value, input.correlationId);
      result.usage.fallbackUsed = true;
      return result;
    }
    return emptyFailure(started, model, retry.failure ?? first.failure, input.correlationId);
  }
  return emptyFailure(started, model, first.failure ?? "unavailable", input.correlationId);
}

function openaiToolsPayload(permitted?: string[]): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(permitted) && permitted.length === 0) return undefined;
  return cloudflareToolDefs(permitted).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

async function invokeResponses(
  env: IntelligenceEnv,
  payload: Record<string, unknown>,
  timeoutMs: number,
  correlationId?: string,
): Promise<{ ok: true; value: unknown } | { ok: false; failure: OpenAiProviderFailure }> {
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  const base = String(env.OPENAI_BASE_URL ?? "").trim().replace(/\/+$/, "") || "https://api.openai.com";
  const ran = await withBoundedTimeout(
    fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(correlationId ? { "x-infra-correlation-id": correlationId } : {}),
      },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      const body = await response.text();
      if (!response.ok) {
        return { ok: false as const, failure: classifyOpenAiHttpFailure(response.status), status: response.status, body };
      }
      try {
        return { ok: true as const, value: JSON.parse(body) as unknown };
      } catch {
        return { ok: false as const, failure: "malformed" as const, status: response.status, body };
      }
    }),
    timeoutMs,
    "openai_responses",
  );
  if (!ran.ok) return { ok: false, failure: "timeout" };
  if (ran.value && "ok" in ran.value && ran.value.ok && "value" in ran.value) {
    return { ok: true, value: ran.value.value };
  }
  const failure =
    ran.value && "failure" in ran.value ? (ran.value.failure as OpenAiProviderFailure) : "unavailable";
  return { ok: false, failure };
}

export function extractOpenAiResponses(raw: unknown): {
  text: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured?: Record<string, unknown> | null;
  usage?: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null };
} {
  if (!raw || typeof raw !== "object") return { text: "" };
  const record = raw as Record<string, unknown>;
  const toolCalls = extractFunctionCalls(record);
  const text = extractOutputText(record);
  const structured = extractJsonObject(text);
  return { text, toolCalls, structured, usage: extractOpenAiUsage(record) };
}

function extractOutputText(record: Record<string, unknown>): string {
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text === "string") parts.push(row.text);
    const content = Array.isArray(row.content) ? row.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const piece = block as Record<string, unknown>;
      if (typeof piece.text === "string") parts.push(piece.text);
    }
  }
  return parts.join("\n").trim();
}

function extractFunctionCalls(
  record: Record<string, unknown>,
): Array<{ name: string; arguments: Record<string, unknown> }> | undefined {
  const output = Array.isArray(record.output) ? record.output : [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const type = String(row.type ?? "");
    if (type !== "function_call" && type !== "tool_call") continue;
    const name = normaliseOpenAiToolName(row.name);
    if (!name) continue;
    calls.push({ name, arguments: parseArgs(row.arguments ?? row.input) });
  }
  return calls.length ? calls : undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function extractOpenAiUsage(record: Record<string, unknown>): {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
} {
  const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : {};
  const details =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens: numberOrNull(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: numberOrNull(usage.output_tokens ?? usage.completion_tokens),
    cachedTokens: numberOrNull(details.cached_tokens ?? usage.cached_tokens),
  };
}

function toResult(
  started: number,
  model: string,
  raw: unknown,
  correlationId?: string,
): OpenAiResponsesResult {
  const extracted = extractOpenAiResponses(raw);
  const cost = estimateOpenAiCostUsd({
    model,
    inputTokens: extracted.usage?.inputTokens ?? null,
    outputTokens: extracted.usage?.outputTokens ?? null,
    cachedTokens: extracted.usage?.cachedTokens ?? null,
  });
  const malformed = !extracted.text.trim() && !extracted.toolCalls?.length && !extracted.structured;
  return {
    text: extracted.text,
    toolCalls: extracted.toolCalls,
    structured: extracted.structured,
    usage: {
      provider: "openai",
      model,
      latencyMs: Date.now() - started,
      promptTokens: extracted.usage?.inputTokens ?? null,
      completionTokens: extracted.usage?.outputTokens ?? null,
      cachedTokens: extracted.usage?.cachedTokens ?? null,
      estimatedCostUsd: cost.estimatedCostUsd,
      costBasis: cost.costBasis,
      correlationId: correlationId ?? null,
      fallbackUsed: false,
      malformed,
    },
    failure: malformed ? "malformed" : undefined,
  };
}

function emptyFailure(
  started: number,
  model: string,
  failure: OpenAiProviderFailure,
  correlationId?: string,
): OpenAiResponsesResult {
  return {
    text: "",
    usage: {
      provider: "openai",
      model,
      latencyMs: Date.now() - started,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      estimatedCostUsd: null,
      costBasis: "unknown",
      correlationId: correlationId ?? null,
      fallbackUsed: false,
      malformed: true,
    },
    failure,
  };
}

export function normaliseOpenAiToolName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^functions\./, "")
    .replace(/^tools\./, "");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}
