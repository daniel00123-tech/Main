import { LIVE_PROBE_MODELS, modelSpec, WORKERS_AI_MODELS } from "../models.js";
import { extractWorkersAiResult } from "../provider.js";
import { recoverDecision } from "../parse.js";
import { policyCompleter, runEvaluationSuite, v1FragileCompleter, type EvalScores } from "./harness.js";
import type { IntelligenceEnv } from "../types.js";

export type ModelBenchmark = {
  model: string;
  label: string;
  available: boolean | null;
  structuredReliability: number | null;
  toolCallReliability: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  estimatedCostPerTurnUsd: number | null;
  infraScore: number | null;
  notes: string;
  policyScores?: EvalScores;
};

const STRUCTURED_PROMPT = {
  system: 'Reply with only JSON: {"action":"clarify","text":"Which document?"}',
  user: "What's the policy?",
};

const TOOL_PROMPT = {
  system: 'Reply with only JSON: {"action":"call_tool","name":"search_document","arguments":{"document_id":"doc_1","query":"main rules"}}',
  user: "Current document: Vehicle policy (id=doc_1)\nUser: What are the main rules?",
};

export async function runOfflineBenchmarks(): Promise<{
  v11Policy: EvalScores;
  v1Fragile: EvalScores;
  catalogue: typeof WORKERS_AI_MODELS;
}> {
  const [v11Policy, v1Fragile] = await Promise.all([
    runEvaluationSuite(policyCompleter()),
    runEvaluationSuite(v1FragileCompleter()),
  ]);
  return { v11Policy: v11Policy.scores, v1Fragile: v1Fragile.scores, catalogue: WORKERS_AI_MODELS };
}

export async function probeWorkersAiModels(env: IntelligenceEnv): Promise<ModelBenchmark[]> {
  const out: ModelBenchmark[] = [];
  if (!env.AI) {
    return LIVE_PROBE_MODELS.map((id) => ({
      model: id,
      label: modelSpec(id)?.label ?? id,
      available: false,
      structuredReliability: null,
      toolCallReliability: null,
      avgLatencyMs: null,
      p95LatencyMs: null,
      estimatedCostPerTurnUsd: null,
      infraScore: null,
      notes: "AI binding not present in this runtime.",
    }));
  }
  for (const id of LIVE_PROBE_MODELS) {
    const latencies: number[] = [];
    let structuredHits = 0;
    let toolHits = 0;
    let available = false;
    for (const prompt of [STRUCTURED_PROMPT, TOOL_PROMPT, STRUCTURED_PROMPT]) {
      const started = Date.now();
      try {
        const raw = await env.AI.run(id, {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_tokens: 160,
          temperature: 0,
        });
        available = true;
        latencies.push(Date.now() - started);
        const extracted = extractWorkersAiResult(raw);
        const recovered = recoverDecision({
          text: extracted.text,
          toolCalls: extracted.toolCalls,
          structured: extracted.structured,
        });
        if (recovered.decision.action !== "invalid") structuredHits += 1;
        if (recovered.decision.action === "call_tool" || extracted.toolCalls?.length) toolHits += 1;
      } catch {
        latencies.push(Date.now() - started);
      }
    }
    const spec = modelSpec(id);
    out.push({
      model: id,
      label: spec?.label ?? id,
      available,
      structuredReliability: available ? Math.round((structuredHits / 3) * 100) : null,
      toolCallReliability: available ? Math.round((toolHits / 3) * 100) : null,
      avgLatencyMs: available && latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      p95LatencyMs: available && latencies.length ? Math.max(...latencies) : null,
      estimatedCostPerTurnUsd: spec ? (1200 / 1_000_000) * spec.inputUsdPerMillion + (180 / 1_000_000) * spec.outputUsdPerMillion : null,
      infraScore: available ? structuredHits * 20 + toolHits * 15 : null,
      notes: available
        ? "Live AI binding probe. Same prompts for every candidate."
        : "Model rejected or unavailable on this account/runtime.",
    });
  }
  return out;
}

export function selectWinningModel(probes: ModelBenchmark[]): {
  primary: string;
  fallback: string;
  escalate: string | null;
  reason: string;
} {
  const usable = probes.filter((row) => row.available && (row.structuredReliability ?? 0) >= 30);
  const scout = usable.find((row) => row.model.includes("llama-4-scout"));
  const eight = usable.find((row) => row.model.includes("llama-3.1-8b-instruct") && !row.model.includes("fast"));
  const granite = usable.find((row) => row.model.includes("granite"));
  if (scout && (scout.structuredReliability ?? 0) >= (eight?.structuredReliability ?? 0)) {
    return {
      primary: scout.model,
      fallback: eight?.model ?? "@cf/meta/llama-3.1-8b-instruct",
      escalate: granite && (granite.infraScore ?? 0) > (scout.infraScore ?? 0) + 20 ? granite.model : null,
      reason: "Llama 4 Scout produced more reliable structured/tool decisions than the V1 8B orchestrator without using a 70B model.",
    };
  }
  if (granite && (granite.structuredReliability ?? 0) > (eight?.structuredReliability ?? 33)) {
    return {
      primary: granite.model,
      fallback: eight?.model ?? "@cf/meta/llama-3.1-8b-instruct",
      escalate: null,
      reason: "Granite 4 micro beat Llama 3.1 8B on structured reliability; Scout was unavailable or weaker.",
    };
  }
  return {
    primary: eight?.model ?? "@cf/meta/llama-3.1-8b-instruct",
    fallback: "@cf/meta/llama-3.1-8b-instruct-fast",
    escalate: null,
    reason: "No larger Cloudflare-native candidate materially beat Llama 3.1 8B on the live probe. Keep 8B and ship model-independent recovery.",
  };
}
