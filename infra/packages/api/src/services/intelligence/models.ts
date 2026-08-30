/**
 * Cloudflare Workers AI catalogue for Conversational Intelligence V1.1.
 * Primary + fallback are Workers AI only. Do not add OpenAI/Anthropic/Gemini.
 *
 * Live availability is probed via the Worker AI binding (REST catalogue
 * search is not granted to the deploy token). Do not treat this list as
 * the account inventory until probeModels() confirms a run succeeds.
 */

export type WorkersAiCapability = "chat" | "json_schema" | "function_calling" | "guided_json";

export type WorkersAiModelSpec = {
  id: string;
  label: string;
  role: "primary_candidate" | "fallback_candidate" | "escalation_candidate" | "v1_baseline" | "rejected";
  paramsHint: string;
  capabilities: WorkersAiCapability[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  notes: string;
};

/** V1 primary — weak tool-calling orchestrator; kept as known-working fallback. */
export const V1_PRIMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const V1_FALLBACK_MODEL = "@cf/meta/llama-3.2-3b-instruct";

/**
 * Strongest realistic Cloudflare-native candidate for instruction following,
 * tool/function selection, and structured output without picking the largest
 * 30B/70B models as a default.
 */
export const DEFAULT_PRIMARY_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** Known-working Workers AI fallback from V1 production (not the weaker 3B). */
export const DEFAULT_FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Compact agentic model — only used if live probe shows quality/cost benefit. */
export const OPTIONAL_ESCALATION_MODEL = "@cf/ibm/granite-4.0-h-micro";

export const WORKERS_AI_MODELS: WorkersAiModelSpec[] = [
  {
    id: DEFAULT_PRIMARY_MODEL,
    label: "Llama 4 Scout 17B",
    role: "primary_candidate",
    paramsHint: "17B active / 16 experts",
    capabilities: ["chat", "json_schema", "function_calling", "guided_json"],
    inputUsdPerMillion: 0.27,
    outputUsdPerMillion: 0.85,
    notes: "Function calling + JSON/guided_json. Mid-size, not the 70B class.",
  },
  {
    id: DEFAULT_FALLBACK_MODEL,
    label: "Llama 3.1 8B Instruct",
    role: "fallback_candidate",
    paramsHint: "8B",
    capabilities: ["chat", "json_schema"],
    inputUsdPerMillion: 0.282,
    outputUsdPerMillion: 0.827,
    notes: "V1 production model. Weak JSON/tool orchestration; known to run on this account.",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fast",
    label: "Llama 3.1 8B Instruct Fast",
    role: "fallback_candidate",
    paramsHint: "8B",
    capabilities: ["chat", "json_schema"],
    inputUsdPerMillion: 0.282,
    outputUsdPerMillion: 0.827,
    notes: "Same family as V1 primary with a fast variant.",
  },
  {
    id: V1_FALLBACK_MODEL,
    label: "Llama 3.2 3B Instruct",
    role: "v1_baseline",
    paramsHint: "3B",
    capabilities: ["chat"],
    inputUsdPerMillion: 0.051,
    outputUsdPerMillion: 0.34,
    notes: "V1 fallback. Weaker instruction following; not a V1.1 primary.",
  },
  {
    id: OPTIONAL_ESCALATION_MODEL,
    label: "Granite 4.0 H Micro",
    role: "escalation_candidate",
    paramsHint: "micro",
    capabilities: ["chat", "function_calling", "json_schema"],
    inputUsdPerMillion: 0.017,
    outputUsdPerMillion: 0.11,
    notes: "Cloudflare-hosted IBM agentic/RAG model. Escalate only if live bench shows benefit.",
  },
  {
    id: "@cf/meta/llama-3.2-11b-vision-instruct",
    label: "Llama 3.2 11B Vision",
    role: "primary_candidate",
    paramsHint: "11B",
    capabilities: ["chat", "json_schema"],
    inputUsdPerMillion: 0.049,
    outputUsdPerMillion: 0.68,
    notes: "JSON mode listed. Vision unused for WhatsApp text turns.",
  },
  {
    id: "@cf/zhipu/glm-4.7-flash",
    label: "GLM 4.7 Flash",
    role: "primary_candidate",
    paramsHint: "flash",
    capabilities: ["chat", "function_calling"],
    inputUsdPerMillion: 0.29,
    outputUsdPerMillion: 0.86,
    notes: "Multi-turn tool calling. Probe before promoting.",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B FP8 Fast",
    role: "rejected",
    paramsHint: "70B",
    capabilities: ["chat", "function_calling"],
    inputUsdPerMillion: 0.29,
    outputUsdPerMillion: 2.25,
    notes: "Largest class. Not auto-picked. Latency/cost vs WhatsApp SLA.",
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B A3B",
    role: "rejected",
    paramsHint: "30B MoE",
    capabilities: ["chat", "function_calling"],
    inputUsdPerMillion: 0.29,
    outputUsdPerMillion: 2.25,
    notes: "Too large as a default WhatsApp orchestrator.",
  },
];

export const LIVE_PROBE_MODELS = WORKERS_AI_MODELS.filter((model) => model.role !== "rejected").map(
  (model) => model.id,
);

export function modelSpec(id: string | null | undefined): WorkersAiModelSpec | null {
  const key = String(id ?? "").trim();
  return WORKERS_AI_MODELS.find((model) => model.id === key) ?? null;
}

export function estimateWorkersAiCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const spec = modelSpec(model);
  const inputRate = spec?.inputUsdPerMillion ?? 0.282;
  const outputRate = spec?.outputUsdPerMillion ?? 0.827;
  return (promptTokens / 1_000_000) * inputRate + (completionTokens / 1_000_000) * outputRate;
}

export function resolveModelRoute(env: {
  WHATSAPP_GROUNDED_MODEL?: string;
  INTELLIGENCE_FALLBACK_MODEL?: string;
  INTELLIGENCE_ESCALATE_MODEL?: string;
}): { primary: string; fallback: string; escalation: string | null } {
  const configured = String(env.WHATSAPP_GROUNDED_MODEL ?? "").trim();
  const fallback = String(env.INTELLIGENCE_FALLBACK_MODEL ?? "").trim() || DEFAULT_FALLBACK_MODEL;
  const escalate = String(env.INTELLIGENCE_ESCALATE_MODEL ?? "").trim();
  return {
    primary: configured || DEFAULT_PRIMARY_MODEL,
    fallback: fallback === configured ? DEFAULT_FALLBACK_MODEL : fallback,
    escalation: escalate || null,
  };
}
