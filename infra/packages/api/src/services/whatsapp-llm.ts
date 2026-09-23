import type { Env } from "../env";
import { withBoundedTimeout } from "./whatsapp-timeouts";

export type GroundedLlmProvider = "workers-ai" | "openai" | "none";

export const DEFAULT_WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const FALLBACK_WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini";
export const GROUNDED_LLM_TIMEOUT_MS = 8_000;

export function inspectGroundedQaProvider(env: Env): {
  provider: GroundedLlmProvider;
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

export type GroundedLlmResult = {
  ok: boolean;
  text: string | null;
  provider: GroundedLlmProvider;
  model: string | null;
  reason?: string;
};

/**
 * Configured INFRA text generation only (Workers AI, then optional OpenAI).
 * Never calls ChatGPT consumer, Cursor, or invents credentials.
 */
export async function generateGroundedCompletion(
  env: Env,
  input: { system: string; user: string; timeoutMs?: number },
): Promise<GroundedLlmResult> {
  const inspected = inspectGroundedQaProvider(env);
  const timeoutMs = input.timeoutMs ?? GROUNDED_LLM_TIMEOUT_MS;
  if (inspected.provider === "workers-ai" && env.AI) {
    const models = uniqueModels([
      inspected.model,
      DEFAULT_WORKERS_AI_TEXT_MODEL,
      FALLBACK_WORKERS_AI_TEXT_MODEL,
    ]);
    for (const model of models) {
      const ran = await withBoundedTimeout(
        runWorkersAi(env.AI, model, input.system, input.user),
        timeoutMs,
        "grounded_workers_ai",
      );
      if (ran.ok && ran.value) {
        return { ok: true, text: ran.value, provider: "workers-ai", model };
      }
    }
  }
  const openaiKey = String(env.OPENAI_API_KEY ?? "").trim();
  if (openaiKey.length >= 20) {
    const model = String(env.WHATSAPP_GROUNDED_MODEL ?? "").trim() || DEFAULT_OPENAI_TEXT_MODEL;
    const ran = await withBoundedTimeout(
      runOpenAi(openaiKey, model, input.system, input.user),
      timeoutMs,
      "grounded_openai",
    );
    if (ran.ok && ran.value) {
      return { ok: true, text: ran.value, provider: "openai", model };
    }
    return {
      ok: false,
      text: null,
      provider: "openai",
      model,
      reason: ran.timedOut ? "timeout" : "provider_error",
    };
  }
  if (inspected.provider === "none") {
    return { ok: false, text: null, provider: "none", model: null, reason: "not_configured" };
  }
  return { ok: false, text: null, provider: inspected.provider, model: inspected.model, reason: "provider_error" };
}

async function runWorkersAi(
  ai: NonNullable<Env["AI"]>,
  model: string,
  system: string,
  user: string,
): Promise<string | null> {
  const raw = await ai.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 420,
    temperature: 0.1,
  });
  return extractModelText(raw);
}

async function runOpenAi(apiKey: string, model: string, system: string, user: string): Promise<string | null> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 420,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return extractModelText(payload.choices?.[0]?.message?.content ?? payload);
}

function extractModelText(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.response === "string" && record.response.trim()) return record.response.trim();
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  if (typeof record.content === "string" && record.content.trim()) return record.content.trim();
  if (Array.isArray(record.result)) {
    const joined = record.result
      .map((row) => (row && typeof row === "object" && "generated_text" in row ? String(row.generated_text ?? "") : ""))
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
