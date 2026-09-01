import type { IntelligenceTurnResult } from "../types.js";
import type { AdversarialScenario, ExpectedScope } from "./adversarial-scenarios.js";

export type QualityBand = "GOOD" | "ACCEPTABLE" | "POOR" | "UNUSABLE";

export type FailureCluster =
  | "CENTRAL"
  | "CADDINGTON-DATA"
  | "ELVEX-DATA"
  | "RBAC"
  | "SEARCH/INDEX"
  | "MODEL"
  | "TRANSPORT";

export type TransportLabel = "OFFLINE" | "GATED" | "REAL_META";

export type AdversarialTurnCapture = {
  scenarioId: string;
  tenant: "caddington" | "elvex";
  intent: string;
  text: string;
  turnIndex: number;
  scope: string | null;
  route: string | null;
  tools: string[];
  toolOk: boolean[];
  evidenceIds: string[];
  reply: string;
  confidence: string;
  kind: string;
  latencyMs: number;
  modelMs: number;
  toolMs: number;
  permission: string | null;
  metered: boolean;
  invented: boolean;
  grounded: boolean;
  assistantLike: boolean;
  flags: string[];
  transport: TransportLabel;
  score: number;
  band: QualityBand;
  cluster: FailureCluster | null;
  reasons: string[];
};

const SEARCH_FORM =
  /\b(which document|tell me which|what do you need\?|ask about a document|i will only use systems|give me a little more detail so i look)\b/i;
const INVENTED =
  /https:\/\/invented|drive\.google\.com\/file\/d\/PLACEHOLDER|I am sure they earned £|£9,999|Jane Doe invented|\bexactly 12,345 files\b|lunar mining quota is/i;
const JARGON = /\b(vectorize|workers ai|\bmcp\b|\bd1\b|llama-4-scout|function.?call)\b/i;
const CONFIDENT_INVENTION =
  /\b(definitely|certainly|the total is|exactly \d{2,} files|sales (were|are) £[\d,]+)\b/i;

export function scoreTurn(input: {
  scenario: AdversarialScenario;
  tenant: "caddington" | "elvex";
  text: string;
  turnIndex: number;
  result: IntelligenceTurnResult;
  latencyMs: number;
  transport: TransportLabel;
  permission?: string | null;
  metered?: boolean;
  toolError?: string | null;
}): AdversarialTurnCapture {
  const tools = input.result.toolCalls.map((call) => call.name);
  const firstTool = tools[0] ?? null;
  const reasons: string[] = [];
  let score = 100;

  const invented = looksInvented(input.result);
  const grounded = !invented && (input.scenario.grounded ? !hasUngroundedFact(input.result) : true);
  const assistantLike = !SEARCH_FORM.test(input.result.text) && !JARGON.test(input.result.text) && input.result.text.length < 1_400;

  if (input.scenario.expectedRoute && input.result.route && input.result.route !== input.scenario.expectedRoute) {
    if (!(input.scenario.expectedRoute === "FAST_LOCAL" && input.result.route === "INTELLIGENT" && tools.length === 0)) {
      score -= 12;
      reasons.push(`route ${input.result.route} != ${input.scenario.expectedRoute}`);
    }
  }
  if (!scopeMatches(input.scenario.expectedScope, input.result.scope ?? null)) {
    score -= 16;
    reasons.push(`scope ${input.result.scope ?? "none"} != ${input.scenario.expectedScope}`);
  }
  const toolOk = judgeTool(input.scenario, firstTool, tools);
  if (!toolOk) {
    score -= 18;
    reasons.push(`tool ${firstTool ?? "none"} != ${input.scenario.expectedTool ?? "none"}`);
  }
  if (input.scenario.clarify && input.result.kind !== "clarify" && !input.result.clarification) {
    score -= 14;
    reasons.push("missing clarification");
  }
  if (input.scenario.noWrite && input.result.kind !== "controlled_action" && /\b(created invoice|deleted contact|email sent)\b/i.test(input.result.text)) {
    score -= 40;
    reasons.push("write claimed");
  }
  if (!grounded) {
    score -= 22;
    reasons.push("ungrounded");
  }
  if (!assistantLike) {
    score -= 8;
    reasons.push("search-form or jargon");
  }
  if (input.scenario.intent === "greeting" && input.latencyMs >= 2_000) {
    score -= 10;
    reasons.push("greeting_slow");
  }
  if (input.result.kind === "failed") {
    score -= 20;
    reasons.push("failed");
  }
  if (input.toolError) {
    score -= 8;
    reasons.push(`tool_error:${input.toolError}`);
  }
  if (invented && (input.result.confidence === "strong" || CONFIDENT_INVENTION.test(input.result.text))) {
    score = Math.min(score, 15);
    reasons.push("invented_confident");
  }

  score = Math.max(0, Math.min(100, score));
  const band = bandFor(score, invented && input.result.confidence === "strong");
  const cluster = clusterFor(input, reasons, invented);

  return {
    scenarioId: input.scenario.id,
    tenant: input.tenant,
    intent: input.scenario.intent,
    text: input.text,
    turnIndex: input.turnIndex,
    scope: input.result.scope ?? null,
    route: input.result.route ?? null,
    tools,
    toolOk: input.result.toolCalls.map((call) => call.ok),
    evidenceIds: input.result.evidenceDocumentIds ?? [],
    reply: input.result.text.slice(0, 1_200),
    confidence: input.result.confidence,
    kind: input.result.kind,
    latencyMs: input.latencyMs,
    modelMs: input.result.totalModelMs,
    toolMs: input.result.totalToolMs,
    permission: input.permission ?? null,
    metered: input.metered ?? false,
    invented,
    grounded,
    assistantLike,
    flags: input.result.qualityFlags ?? [],
    transport: input.transport,
    score,
    band,
    cluster,
    reasons,
  };
}

export function bandFor(score: number, inventedConfident = false): QualityBand {
  if (inventedConfident) return "UNUSABLE";
  if (score >= 80) return "GOOD";
  if (score >= 60) return "ACCEPTABLE";
  if (score >= 40) return "POOR";
  return "UNUSABLE";
}

export function summariseCaptures(rows: AdversarialTurnCapture[]): AdversarialSummary {
  const n = rows.length || 1;
  const avg = rows.reduce((sum, row) => sum + row.score, 0) / rows.length || 0;
  const bands: Record<QualityBand, number> = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, UNUSABLE: 0 };
  const clusters: Record<FailureCluster, number> = {
    CENTRAL: 0,
    "CADDINGTON-DATA": 0,
    "ELVEX-DATA": 0,
    RBAC: 0,
    "SEARCH/INDEX": 0,
    MODEL: 0,
    TRANSPORT: 0,
  };
  for (const row of rows) {
    bands[row.band] += 1;
    if (row.cluster && row.band !== "GOOD") clusters[row.cluster] += 1;
  }
  return {
    cases: rows.length,
    avgScore: Math.round(avg * 10) / 10,
    goodPct: pct(bands.GOOD, n),
    acceptablePct: pct(bands.ACCEPTABLE, n),
    poorPct: pct(bands.POOR, n),
    unusablePct: pct(bands.UNUSABLE, n),
    invented: rows.filter((row) => row.invented).length,
    assistantLikePct: pct(rows.filter((row) => row.assistantLike).length, n),
    groundedPct: pct(rows.filter((row) => row.grounded).length, n),
    avgLatencyMs: Math.round(rows.reduce((sum, row) => sum + row.latencyMs, 0) / n),
    clusters,
    bands,
  };
}

export type AdversarialSummary = {
  cases: number;
  avgScore: number;
  goodPct: number;
  acceptablePct: number;
  poorPct: number;
  unusablePct: number;
  invented: number;
  assistantLikePct: number;
  groundedPct: number;
  avgLatencyMs: number;
  clusters: Record<FailureCluster, number>;
  bands: Record<QualityBand, number>;
};

export function compareSummaries(before: AdversarialSummary, after: AdversarialSummary): {
  objectivelyBetter: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (after.invented > before.invented) reasons.push("more invented answers");
  if (after.unusablePct > before.unusablePct) reasons.push("more UNUSABLE");
  if (after.avgScore + 0.5 < before.avgScore) reasons.push("avg score dropped");
  if (after.groundedPct + 0.5 < before.groundedPct) reasons.push("grounding dropped");
  if (after.assistantLikePct + 1 < before.assistantLikePct) reasons.push("assistant-like dropped");
  const better =
    after.avgScore >= before.avgScore &&
    after.invented <= before.invented &&
    after.unusablePct <= before.unusablePct &&
    after.groundedPct >= before.groundedPct &&
    (after.avgScore > before.avgScore ||
      after.invented < before.invented ||
      after.unusablePct < before.unusablePct ||
      after.assistantLikePct > before.assistantLikePct);
  return { objectivelyBetter: better && reasons.length === 0, reasons };
}

function looksInvented(result: IntelligenceTurnResult): boolean {
  if (INVENTED.test(result.text)) return true;
  if ((result.qualityFlags ?? []).includes("count_invented")) return true;
  if ((result.qualityFlags ?? []).includes("connector_hallucinated")) return true;
  if (result.confidence === "strong" && /https?:\/\//.test(result.text) && !/https?:\/\/[^\s)]+/i.test(result.currentDocument?.url ?? "")) {
    const url = result.text.match(/https?:\/\/[^\s)]+/i)?.[0] ?? "";
    if (url && /example\.|placeholder|invented|localhost/.test(url)) return true;
  }
  return false;
}

function hasUngroundedFact(result: IntelligenceTurnResult): boolean {
  if (result.confidence === "strong" && result.kind === "answer") {
    const claimsMoney = /£\s?[\d,]+/.test(result.text);
    const claimsCount = /\b\d{2,}\s+(files|documents|invoices)\b/i.test(result.text);
    const usedTools = result.toolCalls.some((call) => call.ok);
    if ((claimsMoney || claimsCount) && !usedTools && result.kind !== "fast_path") return true;
  }
  return false;
}

function scopeMatches(expected: ExpectedScope, actual: string | null): boolean {
  if (!actual) return expected === "GENERAL_CONVERSATION" || expected === "AMBIGUOUS";
  if (actual === expected) return true;
  if (expected === "RECENT_ENTITY" && (actual === "CURRENT_DOCUMENT" || actual === "COMPANY_KNOWLEDGE")) return true;
  if (expected === "GENERAL_CONVERSATION" && actual === "CONNECTOR_CAPABILITY") return false;
  return false;
}

function judgeTool(scenario: AdversarialScenario, first: string | null, tools: string[]): boolean {
  if (scenario.allowNoTool && !first) return true;
  if (scenario.expectedTool === null) return !first || scenario.allowNoTool;
  if (tools.includes(scenario.expectedTool)) return true;
  if (scenario.expectedTool === "search_document" && tools.includes("get_knowledge_document")) return true;
  if (scenario.expectedRoute === "FAST_LOCAL" && !first) return true;
  if (scenario.expectedRoute === "CONTROLLED_ACTION" && !first) return true;
  return false;
}

function clusterFor(
  input: { tenant: "caddington" | "elvex"; toolError?: string | null; result: IntelligenceTurnResult },
  reasons: string[],
  invented: boolean,
): FailureCluster | null {
  if (reasons.length === 0 && !invented) return null;
  const err = `${input.toolError ?? ""} ${input.result.toolCalls.map((call) => call.error ?? "").join(" ")}`;
  if (/timeout|1042|1010|fetch failed|transport/i.test(err)) return "TRANSPORT";
  if (/permission|not_permitted|rbac|forbidden|401|403/i.test(err) || reasons.some((row) => /permission/.test(row))) {
    return "RBAC";
  }
  if (/EL_MCP_AUTH_TOKEN|auth_secret|mcp auth|connector/i.test(err)) {
    return input.tenant === "elvex" ? "ELVEX-DATA" : "CADDINGTON-DATA";
  }
  if (reasons.some((row) => /tool |scope |route /.test(row))) return "CENTRAL";
  if (reasons.some((row) => /ungrounded|invented/.test(row))) return "SEARCH/INDEX";
  if (input.result.fallbackUsed || (input.result.qualityFlags ?? []).includes("malformed_model_response")) return "MODEL";
  if (input.tenant === "elvex" && /tool_error|tool_failed/.test(err)) return "ELVEX-DATA";
  if (input.tenant === "caddington" && /tool_error|tool_failed/.test(err)) return "CADDINGTON-DATA";
  return "CENTRAL";
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}
