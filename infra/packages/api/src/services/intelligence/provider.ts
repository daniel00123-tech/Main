import { withBoundedTimeout } from "../whatsapp-timeouts.js";
import type { IntelligenceEnv, IntelligenceModelUsage } from "./types.js";

export const DEFAULT_WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const FALLBACK_WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini";
export const INTELLIGENCE_LLM_TIMEOUT_MS = 10_000;

const WORKERS_AI_INPUT_USD_PER_M = 0.282;
const WORKERS_AI_OUTPUT_USD_PER_M = 0.827;
const OPENAI_MINI_INPUT_USD_PER_M = 0.15;
const OPENAI_MINI_OUTPUT_USD_PER_M = 0.6;

export type IntelligenceCompleter = (input: {
  system: string;
  user: string;
}) => Promise<{ text: string; usage: IntelligenceModelUsage }>;

export function inspectIntelligenceProvider(env: IntelligenceEnv): {
  provider: IntelligenceModelUsage["provider"];
  model: string | null;
  configured: boolean;
} {
  const configuredModel = String(env.WHATSAPP_GROUNDED_MODEL ?? "").trim();
  if (env.AI) {
    return {
      provider: "workers-ai",
      model: configuredModel || DEFAULT_WORKERS_AI_TEXT_MODEL,
      configured: true,
    };
  }
  if (String(env.OPENAI_API_KEY ?? "").trim().length >= 20) {
    return {
      provider: "openai",
      model: configuredModel || DEFAULT_OPENAI_TEXT_MODEL,
      configured: true,
    };
  }
  return { provider: "none", model: null, configured: false };
}

export function createDefaultCompleter(env: IntelligenceEnv): IntelligenceCompleter {
  return async (input) => {
    const started = Date.now();
    const inspected = inspectIntelligenceProvider(env);
    if (inspected.provider === "workers-ai" && env.AI) {
      const models = uniqueModels([
        inspected.model,
        DEFAULT_WORKERS_AI_TEXT_MODEL,
        FALLBACK_WORKERS_AI_TEXT_MODEL,
      ]);
      for (const model of models) {
        const ran = await withBoundedTimeout(
          runWorkersAi(env.AI, model, input.system, input.user),
          INTELLIGENCE_LLM_TIMEOUT_MS,
          "intelligence_workers_ai",
        );
        if (ran.ok && ran.value) {
          return {
            text: ran.value.text,
            usage: usageFrom(started, "workers-ai", model, input, ran.value.text, ran.value.usage),
          };
        }
      }
    }
    const openaiKey = String(env.OPENAI_API_KEY ?? "").trim();
    if (openaiKey.length >= 20) {
      const model = String(env.WHATSAPP_GROUNDED_MODEL ?? "").trim() || DEFAULT_OPENAI_TEXT_MODEL;
      const ran = await withBoundedTimeout(
        runOpenAi(openaiKey, env.OPENAI_BASE_URL, model, input.system, input.user),
        INTELLIGENCE_LLM_TIMEOUT_MS,
        "intelligence_openai",
      );
      if (ran.ok && ran.value) {
        return {
          text: ran.value.text,
          usage: usageFrom(started, "openai", model, input, ran.value.text, ran.value.usage),
        };
      }
      return {
        text: "",
        usage: {
          provider: "openai",
          model,
          latencyMs: Date.now() - started,
          promptTokens: null,
          completionTokens: null,
          estimatedCostUsd: null,
        },
      };
    }
    return {
      text: "",
      usage: {
        provider: inspected.provider,
        model: inspected.model,
        latencyMs: Date.now() - started,
        promptTokens: null,
        completionTokens: null,
        estimatedCostUsd: null,
      },
    };
  };
}

function usageFrom(
  started: number,
  provider: "workers-ai" | "openai",
  model: string,
  input: { system: string; user: string },
  output: string,
  raw?: { promptTokens?: number | null; completionTokens?: number | null },
): IntelligenceModelUsage {
  const promptTokens = raw?.promptTokens ?? estimateTokens(`${input.system}\n${input.user}`);
  const completionTokens = raw?.completionTokens ?? estimateTokens(output);
  return {
    provider,
    model,
    latencyMs: Date.now() - started,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCostUsd(provider, promptTokens, completionTokens),
  };
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCostUsd(
  provider: "workers-ai" | "openai" | "none",
  promptTokens: number,
  completionTokens: number,
): number {
  if (provider === "none") return 0;
  const inputRate = provider === "openai" ? OPENAI_MINI_INPUT_USD_PER_M : WORKERS_AI_INPUT_USD_PER_M;
  const outputRate = provider === "openai" ? OPENAI_MINI_OUTPUT_USD_PER_M : WORKERS_AI_OUTPUT_USD_PER_M;
  return (promptTokens / 1_000_000) * inputRate + (completionTokens / 1_000_000) * outputRate;
}

async function runWorkersAi(
  ai: NonNullable<IntelligenceEnv["AI"]>,
  model: string,
  system: string,
  user: string,
): Promise<{ text: string; usage?: { promptTokens?: number | null; completionTokens?: number | null } } | null> {
  try {
    const raw = await ai.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 520,
      temperature: 0.1,
    });
    const text = extractModelText(raw);
    if (!text) return null;
    return { text, usage: extractUsage(raw) };
  } catch {
    return null;
  }
}

async function runOpenAi(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
  system: string,
  user: string,
): Promise<{ text: string; usage?: { promptTokens?: number | null; completionTokens?: number | null } } | null> {
  const endpoint = String(baseUrl ?? "").trim() || "https://api.openai.com/v1/chat/completions";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 520,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = extractModelText(payload.choices?.[0]?.message?.content ?? payload);
  if (!text) return null;
  return {
    text,
    usage: {
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    },
  };
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
