import { withBoundedTimeout } from "../whatsapp-timeouts.js";
import { estimateWorkersAiCostUsd, resolveModelRoute } from "./models.js";
import { jsonSchemaResponseFormat, workersAiToolsPayload } from "./schema.js";
import { extractJsonObject } from "./parse.js";
import type { IntelligenceEnv, IntelligenceModelUsage } from "./types.js";

export const DEFAULT_WORKERS_AI_TEXT_MODEL = resolveModelRoute({}).primary;
export const FALLBACK_WORKERS_AI_TEXT_MODEL = resolveModelRoute({}).fallback;
/** Leftover V1 constant — V1.1 does not call OpenAI. */
export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini";
export const INTELLIGENCE_LLM_TIMEOUT_MS = 12_000;
export const INTELLIGENCE_FALLBACK_TIMEOUT_MS = 8_000;

export type IntelligenceCompleter = (input: {
  system: string;
  user: string;
  permittedTools?: string[];
  mode?: "decide" | "repair" | "synthesise";
}) => Promise<{
  text: string;
  usage: IntelligenceModelUsage;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured?: Record<string, unknown> | null;
}>;

export function inspectIntelligenceProvider(env: IntelligenceEnv): {
  provider: IntelligenceModelUsage["provider"];
  model: string | null;
  configured: boolean;
} {
  const route = resolveModelRoute(env);
  if (env.AI) {
    return { provider: "workers-ai", model: route.primary, configured: true };
  }
  return { provider: "none", model: null, configured: false };
}

export function createDefaultCompleter(env: IntelligenceEnv): IntelligenceCompleter {
  return async (input) => {
    const started = Date.now();
    const route = resolveModelRoute(env);
    if (env.AI) {
      const models = uniqueModels([route.primary, route.fallback, route.escalation]);
      for (const [index, model] of models.entries()) {
        const timeout = index === 0 ? INTELLIGENCE_LLM_TIMEOUT_MS : INTELLIGENCE_FALLBACK_TIMEOUT_MS;
        const ran = await withBoundedTimeout(
          runWorkersAi(env.AI, model, input),
          timeout,
          `intelligence_workers_ai_${index}`,
        );
        if (ran.ok && ran.value) {
          return {
            text: ran.value.text,
            toolCalls: ran.value.toolCalls,
            structured: ran.value.structured,
            usage: usageFrom(started, model, input, ran.value.text, ran.value.usage, index > 0),
          };
        }
      }
    }
    return {
      text: "",
      usage: {
        provider: env.AI ? "workers-ai" : "none",
        model: route.primary,
        latencyMs: Date.now() - started,
        promptTokens: null,
        completionTokens: null,
        estimatedCostUsd: null,
        fallbackUsed: false,
        malformed: true,
      },
    };
  };
}

function usageFrom(
  started: number,
  model: string,
  input: { system: string; user: string },
  output: string,
  raw?: { promptTokens?: number | null; completionTokens?: number | null },
  fallbackUsed = false,
): IntelligenceModelUsage {
  const promptTokens = raw?.promptTokens ?? estimateTokens(`${input.system}\n${input.user}`);
  const completionTokens = raw?.completionTokens ?? estimateTokens(output);
  return {
    provider: "workers-ai",
    model,
    latencyMs: Date.now() - started,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateWorkersAiCostUsd(model, promptTokens, completionTokens),
    fallbackUsed,
    malformed: !output.trim(),
  };
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCostUsd(
  provider: "workers-ai" | "openai" | "none",
  promptTokens: number,
  completionTokens: number,
  model?: string | null,
): number {
  if (provider === "none") return 0;
  if (provider === "workers-ai") return estimateWorkersAiCostUsd(model, promptTokens, completionTokens);
  return (promptTokens / 1_000_000) * 0.15 + (completionTokens / 1_000_000) * 0.6;
}

async function runWorkersAi(
  ai: NonNullable<IntelligenceEnv["AI"]>,
  model: string,
  input: { system: string; user: string; permittedTools?: string[]; mode?: "decide" | "repair" | "synthesise" },
): Promise<{
  text: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured?: Record<string, unknown> | null;
  usage?: { promptTokens?: number | null; completionTokens?: number | null };
} | null> {
  const messages = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  const attempts: Array<Record<string, unknown>> = [
    {
      messages,
      max_tokens: 640,
      temperature: input.mode === "repair" ? 0 : 0.1,
      tools: workersAiToolsPayload(input.permittedTools),
      response_format: jsonSchemaResponseFormat(),
    },
    {
      messages,
      max_tokens: 640,
      temperature: 0.1,
      tools: workersAiToolsPayload(input.permittedTools),
    },
    {
      messages,
      max_tokens: 640,
      temperature: 0.1,
      response_format: jsonSchemaResponseFormat(),
    },
    {
      messages,
      max_tokens: 520,
      temperature: 0.1,
    },
  ];
  for (const payload of attempts) {
    try {
      const raw = await ai.run(model, payload);
      const extracted = extractWorkersAiResult(raw);
      if (extracted.text || extracted.toolCalls?.length || extracted.structured) {
        return extracted;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function extractWorkersAiResult(raw: unknown): {
  text: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  structured?: Record<string, unknown> | null;
  usage?: { promptTokens?: number | null; completionTokens?: number | null };
} {
  const text = extractModelText(raw) ?? "";
  const toolCalls = extractNativeToolCalls(raw);
  const structured = extractStructured(raw) ?? extractJsonObject(text);
  return { text, toolCalls, structured, usage: extractUsage(raw) };
}

export function extractNativeToolCalls(
  raw: unknown,
): Array<{ name: string; arguments: Record<string, unknown> }> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const nested = record.result && typeof record.result === "object" ? (record.result as Record<string, unknown>) : record;
  const rows = (nested.tool_calls ?? nested.toolCalls ?? record.tool_calls) as unknown;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const calls = rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      const fn = item.function && typeof item.function === "object" ? (item.function as Record<string, unknown>) : item;
      const name = String(fn.name ?? item.name ?? "").trim();
      if (!name) return null;
      let args: Record<string, unknown> = {};
      const rawArgs = fn.arguments ?? item.arguments ?? item.parameters;
      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        args = rawArgs as Record<string, unknown>;
      }
      return { name, arguments: args };
    })
    .filter((row): row is { name: string; arguments: Record<string, unknown> } => Boolean(row));
  return calls.length ? calls : undefined;
}

function extractStructured(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["response", "result", "output"]) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value) && "action" in (value as object)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function extractUsage(raw: unknown): { promptTokens?: number | null; completionTokens?: number | null } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : record;
  const prompt = numberOrNull(usage.prompt_tokens ?? usage.promptTokens);
  const completion = numberOrNull(usage.completion_tokens ?? usage.completionTokens);
  if (prompt == null && completion == null) return undefined;
  return { promptTokens: prompt, completionTokens: completion };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractModelText(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.response === "string" && record.response.trim()) return record.response.trim();
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  if (typeof record.content === "string" && record.content.trim()) return record.content.trim();
  if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
    const nested = extractModelText(record.result);
    if (nested) return nested;
  }
  if (Array.isArray(record.result)) {
    const joined = record.result
      .map((row) => (row && typeof row === "object" && "generated_text" in row ? String(row.generated_text ?? "") : ""))
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  if (Array.isArray(record.output)) {
    const joined = record.output
      .map((row) => (typeof row === "string" ? row : extractModelText(row) ?? ""))
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  const toolText = extractNativeToolCalls(raw);
  if (toolText?.[0]) {
    return JSON.stringify({ action: "call_tool", name: toolText[0].name, arguments: toolText[0].arguments });
  }
  return null;
}

function uniqueModels(models: Array<string | null>): string[] {
  const out: string[] = [];
  for (const model of models) {
    const next = String(model ?? "").trim();
    if (!next || out.includes(next)) continue;
    out.push(next);
  }
  return out;
}
