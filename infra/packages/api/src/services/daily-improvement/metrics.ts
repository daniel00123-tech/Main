import { COMPANY_LABELS } from "./constants";
import { isGenuineCustomerTraffic, trafficBucket } from "./traffic";
import type { MetricSnapshot } from "./thresholds";
import type {
  CustomerChatSummary,
  DailyImprovementEvaluation,
  DailyImprovementInteraction,
  DailyReportSummary,
  LatencyStats,
  MetricTrend,
} from "./types";

export function latencyStats(values: Array<number | null | undefined>): LatencyStats {
  const sorted = values.filter((n): n is number => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, p95: null, max: null };
  return {
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

export function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function scoreLabel(score: number | null, correct: number, total: number, unit: string): string {
  if (score == null) return "n/a";
  if (!total) return `${score}% (no ${unit})`;
  return `${score}% (${correct}/${total} ${unit})`;
}

export function countByTraffic(interactions: DailyImprovementInteraction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of interactions) {
    const key = row.trafficClass || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function interactionForEval(
  evaluations: DailyImprovementEvaluation[],
  interactions: DailyImprovementInteraction[],
): Map<string, DailyImprovementInteraction> {
  const byId = new Map(interactions.map((row) => [row.interactionId, row]));
  return byId;
}

export function customerEvaluations(
  evaluations: DailyImprovementEvaluation[],
  interactions: DailyImprovementInteraction[],
): DailyImprovementEvaluation[] {
  const byId = new Map(interactions.map((row) => [row.interactionId, row]));
  return evaluations.filter((evaluation) => {
    const interaction = byId.get(evaluation.interactionId);
    const traffic = interaction?.trafficClass ?? evaluation.interactionTrafficClass ?? "CUSTOMER_REQUEST";
    return isGenuineCustomerTraffic(traffic);
  });
}

export function buildMetricSnapshot(
  evaluations: DailyImprovementEvaluation[],
  interactions: DailyImprovementInteraction[],
): MetricSnapshot {
  const customer = customerEvaluations(evaluations, interactions);
  const byId = new Map(interactions.map((row) => [row.interactionId, row]));
  const avg = (select: (row: DailyImprovementEvaluation) => number) => average(customer.map(select));
  const toolRequired = customer.filter((row) => {
    const interaction = byId.get(row.interactionId);
    return (interaction?.toolsRequested.length ?? 0) > 0 || row.scores.TOOL_SELECTION < 100 || row.failureCategories.some((cat) => cat.includes("TOOL"));
  });
  const toolCorrect = toolRequired.filter((row) => row.scores.TOOL_SELECTION >= 98).length;
  const exactCorrect = toolRequired.filter((row) => row.scores.EXACT_TOOL >= 98).length;
  const firstCorrect = customer.filter((row) => row.scores.FIRST_ANSWER >= 95).length;
  const hallucinations = customer.filter((row) => row.failureCategories.includes("HALLUCINATION")).length;
  const allHallucinations = evaluations.filter((row) => row.failureCategories.includes("HALLUCINATION")).length;
  const falsePermission = customer.filter((row) =>
    row.failureCategories.some((cat) => cat === "FALSE_PERMISSION_DENIAL" || cat === "RBAC_RESPONSE_CONTRADICTION"),
  ).length;
  const leaks = customer.filter((row) =>
    row.failureCategories.some((cat) => cat === "PERMISSION_LEAK" || cat === "CROSS_TENANT_RISK"),
  ).length;
  const repeats = customer.filter((row) => row.failureCategories.includes("USER_HAD_TO_REPEAT")).length;
  const failures = customer.filter((row) => row.failureCategories.some((cat) => !["EXPECTED_PERMISSION_DENIAL"].includes(cat))).length;
  const customerLatencies = interactions.filter((row) => isGenuineCustomerTraffic(row.trafficClass)).map((row) => row.latencyMs);
  const stats = latencyStats(customerLatencies);
  return {
    overallQuality: avg((row) => row.overallScore),
    toolSelection: avg((row) => row.scores.TOOL_SELECTION),
    exactTool: avg((row) => row.scores.EXACT_TOOL),
    firstAnswer: avg((row) => row.scores.FIRST_ANSWER),
    followUp: avg((row) => row.scores.FOLLOW_UP),
    userRepeatRate: customer.length ? Math.round((repeats / customer.length) * 100) : null,
    hallucinations: allHallucinations,
    customerHallucinations: hallucinations,
    falsePermissionDenials: falsePermission,
    permissionLeaks: leaks,
    failures,
    customerFailures: failures,
    failureRatePct: customer.length ? Math.round((failures / customer.length) * 100) : null,
    latencyP95Ms: stats.p95,
    latencyMaxMs: stats.max,
    evaluatedTurns: customer.length,
    toolRequiredTurns: toolRequired.length,
    toolCorrectTurns: toolCorrect,
    exactCorrectTurns: exactCorrect,
    firstAnswerCorrectTurns: firstCorrect,
  };
}

export function hallucinationKind(notes: string | null, answer: string | null): string {
  const text = `${notes ?? ""} ${answer ?? ""}`.toLowerCase();
  if (/email|mailbox|inbox|outlook/.test(text)) return "unsupported email claim";
  if (/document|policy|sharepoint|onedrive|file/.test(text)) return "unsupported document claim";
  if (/£|invoice|sales|xero|revenue|overdue/.test(text)) return "unsupported business figure";
  return "unsupported claim";
}

export function failureBucket(categories: string[], terminalState?: string | null): string {
  const joined = `${categories.join(" ")} ${terminalState ?? ""}`.toUpperCase();
  if (joined.includes("PROVIDER_FAILURE")) return "provider";
  if (joined.includes("UPSTREAM_FAILURE")) return "upstream";
  if (joined.includes("NO_FINAL_RESPONSE")) return "no-final-response";
  if (joined.includes("LATENCY") || joined.includes("TIMEOUT")) return "timeout";
  if (joined.includes("PERMISSION") || joined.includes("RBAC")) return "quality guard";
  if (joined.includes("TOOL") || joined.includes("WRONG_CAPABILITY") || joined.includes("MIXED")) return "tool";
  if (joined.includes("CONNECTOR") || joined.includes("XERO") || joined.includes("OUTLOOK")) return "connector";
  if (categories.length) return "quality guard";
  return "other";
}

export function safeUserLabel(userId: string | null, fallback = "customer"): string {
  if (!userId) return fallback;
  const tail = userId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  return tail ? `user …${tail}` : fallback;
}

export function safeTopic(text: string | null): string {
  const cleaned = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "(no prompt stored)";
}

export function buildChatSummaries(
  interactions: DailyImprovementInteraction[],
  evaluations: DailyImprovementEvaluation[],
): CustomerChatSummary[] {
  const evalByConversation = new Map<string, DailyImprovementEvaluation[]>();
  const evalByInteraction = new Map(evaluations.map((row) => [row.interactionId, row]));
  for (const evaluation of evaluations) {
    const key = evaluation.conversationId ?? evaluation.interactionId;
    const list = evalByConversation.get(key) ?? [];
    list.push(evaluation);
    evalByConversation.set(key, list);
  }
  const groups = new Map<string, DailyImprovementInteraction[]>();
  for (const row of interactions.filter((item) => isGenuineCustomerTraffic(item.trafficClass))) {
    const key = row.conversationId ?? row.interactionId;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([conversationId, turns]) => {
      const companyId = turns[0]?.companyId ?? "unknown";
      const scored = evalByConversation.get(conversationId) ?? turns.map((turn) => evalByInteraction.get(turn.interactionId)).filter(Boolean);
      const quality = average(scored.map((row) => row!.overallScore));
      const hasIssue = scored.some((row) => (row?.failureCategories.length ?? 0) > 0 && row!.severity);
      const last = turns[turns.length - 1];
      return {
        company: COMPANY_LABELS[companyId] ?? companyId,
        user: safeUserLabel(turns[0]?.userId ?? null),
        channel: turns[0]?.channel ?? "unknown",
        topic: safeTopic(turns[0]?.userMessage ?? null),
        turns: turns.length,
        qualityScore: quality,
        hasIssue,
        outcome: last?.terminalState ?? (last?.assistantAnswer ? "ANSWER" : "NO_FINAL_RESPONSE"),
        conversationId,
      };
    })
    .sort((a, b) => Number(b.hasIssue) - Number(a.hasIssue) || (a.qualityScore ?? 100) - (b.qualityScore ?? 100))
    .slice(0, 40);
}

export function emptyTrend(today: number | null): MetricTrend {
  return { today, yesterday: null, weekAverage: null };
}

export function mergeTrend(today: number | null, previous: Array<number | null>): MetricTrend {
  const yesterday = previous[0] ?? null;
  const week = previous.filter((value): value is number => value != null);
  return {
    today,
    yesterday,
    weekAverage: week.length ? Math.round(week.reduce((sum, value) => sum + value, 0) / week.length) : null,
  };
}

export function trafficCounts(interactions: DailyImprovementInteraction[]): Pick<
  DailyReportSummary,
  | "customerInteractions"
  | "testInteractions"
  | "shadowInteractions"
  | "automationInternalInteractions"
  | "customerConversations"
> {
  let customer = 0;
  let test = 0;
  let shadow = 0;
  let automation = 0;
  const customerConversations = new Set<string>();
  for (const row of interactions) {
    const bucket = trafficBucket(row.trafficClass);
    if (bucket === "customer") {
      customer += 1;
      customerConversations.add(row.conversationId ?? row.interactionId);
    } else if (bucket === "test") test += 1;
    else if (bucket === "shadow") shadow += 1;
    else automation += 1;
  }
  return {
    customerInteractions: customer,
    testInteractions: test,
    shadowInteractions: shadow,
    automationInternalInteractions: automation,
    customerConversations: customerConversations.size,
  };
}

export { interactionForEval as evaluationsByInteraction };
