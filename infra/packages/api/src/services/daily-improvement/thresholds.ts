import type { DailyImprovementSeverity, FailureCategory } from "./constants";
import type { DailyImprovementCluster, DailyReportSummary, QualityFinding } from "./types";

export const QUALITY_TARGETS = {
  overall: 95,
  toolSelection: 98,
  exactTool: 98,
  firstAnswer: 95,
  followUp: 95,
  rbac: 100,
  grounding: 100,
  hallucinationCount: 0,
  repeatRatePct: 5,
  failureRatePct: 5,
  latencyP95Ms: 8_000,
  latencyMaxMs: 20_000,
} as const;

export type MetricSnapshot = {
  overallQuality: number | null;
  toolSelection: number | null;
  exactTool: number | null;
  firstAnswer: number | null;
  followUp: number | null;
  userRepeatRate: number | null;
  hallucinations: number;
  customerHallucinations: number;
  falsePermissionDenials: number;
  permissionLeaks: number;
  failures: number;
  customerFailures: number;
  failureRatePct: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  evaluatedTurns: number;
  toolRequiredTurns: number;
  toolCorrectTurns: number;
  exactCorrectTurns: number;
  firstAnswerCorrectTurns: number;
};

export type MetricBreach = {
  clusterKey: string;
  category: FailureCategory | string;
  title: string;
  severity: DailyImprovementSeverity;
  currentBehaviour: string;
  expectedBehaviour: string;
  rootCause: string;
  proposedFix: string;
  testsRequired: string;
  expectedBenefit: string;
  risk: string;
};

export function scoreBandSeverity(score: number | null): DailyImprovementSeverity | null {
  if (score == null) return null;
  if (score >= 95) return null;
  if (score >= 90) return "LOW";
  if (score >= 80) return "MEDIUM";
  if (score >= 70) return "HIGH";
  return "HIGH";
}

export function severityForCause(
  category: string,
  score: number | null,
): DailyImprovementSeverity {
  if (
    category === "CROSS_TENANT_RISK" ||
    category === "PERMISSION_LEAK" ||
    category === "UNAUTHORISED_WRITE"
  ) {
    return "CRITICAL";
  }
  if (
    category === "HALLUCINATION" ||
    category === "FALSE_PERMISSION_DENIAL" ||
    category === "RBAC_RESPONSE_CONTRADICTION" ||
    category === "WRONG_CAPABILITY" ||
    category === "EMAIL_TO_XERO" ||
    category === "MIXED_MULTI_TOOL" ||
    category === "XERO_EXACT_TOOL_SELECTION" ||
    category === "TOOL_SELECTION_DEGRADATION" ||
    category === "EXACT_TOOL_DEGRADATION" ||
    category === "PROVIDER_FAILURE" ||
    category === "RELIABILITY_DEGRADATION"
  ) {
    return "HIGH";
  }
  if (category === "HALLUCINATION" && (score == null || score >= 80)) return "MEDIUM";
  const band = scoreBandSeverity(score);
  if (category === "LATENCY_OUTLIER" || category === "PERFORMANCE_DEGRADATION") {
    return band === "HIGH" ? "MEDIUM" : band ?? "LOW";
  }
  if (category === "FIRST_ANSWER_INCOMPLETE" || category === "FOLLOW_UP_CONTEXT_FAILURE") {
    return score != null && score < 70 ? "HIGH" : "MEDIUM";
  }
  return band ?? "MEDIUM";
}

export function metricBreaches(metrics: MetricSnapshot): MetricBreach[] {
  const breaches: MetricBreach[] = [];
  const push = (breach: MetricBreach) => {
    breaches.push(breach);
  };

  if (below(metrics.toolSelection, QUALITY_TARGETS.toolSelection)) {
    push(
      degradation({
        clusterKey: "TOOL_SELECTION_DEGRADATION",
        category: "TOOL_SELECTION_DEGRADATION",
        title: "Tool-selection accuracy below platform target",
        score: metrics.toolSelection,
        target: QUALITY_TARGETS.toolSelection,
        severity: severityForCause("TOOL_SELECTION_DEGRADATION", metrics.toolSelection),
        current: `Tool selection ${fmtScore(metrics.toolSelection)} on ${metrics.toolRequiredTurns} tool-required turns (${metrics.toolCorrectTurns} exact-family matches).`,
        expected: `Tool selection ≥${QUALITY_TARGETS.toolSelection} on authorised customer turns that required a tool.`,
        rootCause: "Planner is under-selecting or mis-selecting live capability families.",
        fix: "Improve shared planner tool metadata and multi-capability continuation. No phrase patches.",
        tests: "Frozen mixed-tool + exact-family regression + tenant isolation.",
      }),
    );
  }
  if (below(metrics.exactTool, QUALITY_TARGETS.exactTool)) {
    push(
      degradation({
        clusterKey: "EXACT_TOOL_DEGRADATION",
        category: "EXACT_TOOL_DEGRADATION",
        title: "Exact-tool family selection below platform target",
        score: metrics.exactTool,
        target: QUALITY_TARGETS.exactTool,
        severity: severityForCause("EXACT_TOOL_DEGRADATION", metrics.exactTool),
        current: `Exact tool ${fmtScore(metrics.exactTool)} (${metrics.exactCorrectTurns}/${metrics.toolRequiredTurns} evaluated tool-required turns).`,
        expected: `Exact-tool family ≥${QUALITY_TARGETS.exactTool}.`,
        rootCause: "Capability detector collapses related accounting/mailbox/knowledge families onto a neighbour tool.",
        fix: "Generic family routing: outstanding → invoice search; P&L/aged → reports; named contact → contacts; mailbox invoice stays Outlook.",
        tests: "Exact-family bench for invoice search/get, reports, contacts, sales, mailbox search vs list.",
      }),
    );
  }
  if (below(metrics.firstAnswer, QUALITY_TARGETS.firstAnswer)) {
    push(
      degradation({
        clusterKey: "FIRST_ANSWER_INCOMPLETE",
        category: "FIRST_ANSWER_INCOMPLETE",
        title: "First-answer completeness below target",
        score: metrics.firstAnswer,
        target: QUALITY_TARGETS.firstAnswer,
        severity: severityForCause("FIRST_ANSWER_INCOMPLETE", metrics.firstAnswer),
        current: `First answer ${fmtScore(metrics.firstAnswer)} (${metrics.firstAnswerCorrectTurns}/${metrics.evaluatedTurns} evaluated turns).`,
        expected: `First answer ≥${QUALITY_TARGETS.firstAnswer} so the user does not have to re-ask.`,
        rootCause: "First synthesis drops evidence or answers only one part of a compound ask.",
        fix: "Require the first reply to cover every requested authorised capability before ending the turn.",
        tests: "First-answer completeness cases + follow-up should not be required for the original ask.",
      }),
    );
  }
  if (below(metrics.followUp, QUALITY_TARGETS.followUp)) {
    push(
      degradation({
        clusterKey: "FOLLOW_UP_CONTEXT_FAILURE",
        category: "FOLLOW_UP_CONTEXT_FAILURE",
        title: "Follow-up context reuse below target",
        score: metrics.followUp,
        target: QUALITY_TARGETS.followUp,
        severity: severityForCause("FOLLOW_UP_CONTEXT_FAILURE", metrics.followUp),
        current: `Follow-up ${fmtScore(metrics.followUp)}.`,
        expected: `Follow-up ≥${QUALITY_TARGETS.followUp} with prior evidence reused when still valid.`,
        rootCause: "Conversation state drops evidence or re-plans from scratch on a correction.",
        fix: "Reuse prior authorised evidence and replan only the corrected capability.",
        tests: "Correction + evidence-reuse frozen sequences.",
      }),
    );
  }
  if (above(metrics.userRepeatRate, QUALITY_TARGETS.repeatRatePct)) {
    push(
      degradation({
        clusterKey: "EXCESSIVE_USER_REPAIR",
        category: "EXCESSIVE_USER_REPAIR",
        title: "Users are repeating themselves to repair the answer",
        score: metrics.userRepeatRate,
        target: QUALITY_TARGETS.repeatRatePct,
        severity: "MEDIUM",
        current: `Repeat rate ${fmtScore(metrics.userRepeatRate)}% (target ≤${QUALITY_TARGETS.repeatRatePct}%).`,
        expected: "The first authorised answer should make a repeat unnecessary.",
        rootCause: "Incomplete first answers and lost context force the user to restate the ask.",
        fix: "Close first-answer and follow-up gaps; detect near-duplicate user turns as a quality event.",
        tests: "Repeat-detection fixtures + first-answer regressions.",
      }),
    );
  }
  if (metrics.hallucinations > QUALITY_TARGETS.hallucinationCount) {
    push(
      degradation({
        clusterKey: "HALLUCINATION",
        category: "HALLUCINATION",
        title: "Hallucinated business claims detected",
        score: metrics.overallQuality,
        target: QUALITY_TARGETS.hallucinationCount,
        severity: metrics.customerHallucinations > 0 ? "HIGH" : "MEDIUM",
        current: `${metrics.hallucinations} hallucination findings (${metrics.customerHallucinations} on genuine customer turns). Target is 0.`,
        expected: "Every business figure, document claim, and email claim must be grounded in retrieved evidence.",
        rootCause: "Synthesis asserted facts that were not present in tool evidence.",
        fix: "Grounding guard: no unsupported numeric or document claims. Investigate each customer event.",
        tests: "Unsupported-figure and unsupported-email-claim fixtures. Grounding must stay 100.",
      }),
    );
  }
  if (metrics.falsePermissionDenials > 0) {
    push(
      degradation({
        clusterKey: "RBAC_RESPONSE_CONTRADICTION",
        category: "FALSE_PERMISSION_DENIAL",
        title: "False permission denials",
        score: metrics.overallQuality,
        target: 0,
        severity: "HIGH",
        current: `${metrics.falsePermissionDenials} false permission denials. Expected correct RBAC denials are not defects.`,
        expected: "Deny only when the role truly lacks the capability. Never invent a denial after a successful authorised tool.",
        rootCause: "Response text contradicted the authorised catalogue or a successful tool result.",
        fix: "Separate expected RBAC denial from false denial. Do not change RBAC policy.",
        tests: "Director vs office-staff Xero/mailbox cases. No RBAC weakening.",
      }),
    );
  }
  if (metrics.permissionLeaks > 0) {
    push(
      degradation({
        clusterKey: "PERMISSION_LEAK",
        category: "PERMISSION_LEAK",
        title: "Permission or tenant-isolation leak",
        score: 0,
        target: 0,
        severity: "CRITICAL",
        current: `${metrics.permissionLeaks} leak/cross-tenant findings.`,
        expected: "Zero cross-tenant evidence and zero unauthorised capability disclosure.",
        rootCause: "Evidence or answer content crossed a tenant or role boundary.",
        fix: "Contain first. Trace correlation IDs. Do not weaken RBAC.",
        tests: "Tenant-isolation suite must fail closed before any other fix ships.",
      }),
    );
  }
  if (above(metrics.failureRatePct, QUALITY_TARGETS.failureRatePct) || metrics.customerFailures > 0) {
    if (above(metrics.failureRatePct, QUALITY_TARGETS.failureRatePct)) {
      push(
        degradation({
          clusterKey: "RELIABILITY_DEGRADATION",
          category: "RELIABILITY_DEGRADATION",
          title: "Reliability / failure rate above threshold",
          score: metrics.failureRatePct,
          target: QUALITY_TARGETS.failureRatePct,
          severity: "HIGH",
          current: `${metrics.failures} scored failures (${metrics.customerFailures} customer). Failure rate ${fmtScore(metrics.failureRatePct)}%.`,
          expected: `Failure rate ≤${QUALITY_TARGETS.failureRatePct}% on evaluated customer turns.`,
          rootCause: "Provider, connector, tool, timeout, or missing-final-response failures are repeating.",
          fix: "Break down by provider/connector/tool/timeout and repair the dominant shared cause.",
          tests: "Failure-class fixtures + no-final-response watchdog.",
        }),
      );
    }
  }
  if (
    above(metrics.latencyP95Ms, QUALITY_TARGETS.latencyP95Ms) ||
    above(metrics.latencyMaxMs, QUALITY_TARGETS.latencyMaxMs)
  ) {
    push(
      degradation({
        clusterKey: "PERFORMANCE_DEGRADATION",
        category: "PERFORMANCE_DEGRADATION",
        title: "Latency outliers above agreed threshold",
        score: metrics.overallQuality,
        target: QUALITY_TARGETS.latencyP95Ms,
        severity: "LOW",
        current: `p95 ${fmtMs(metrics.latencyP95Ms)}, max ${fmtMs(metrics.latencyMaxMs)}.`,
        expected: `Customer p95 ≤${QUALITY_TARGETS.latencyP95Ms}ms; isolate test-fixture latency from customer experience.`,
        rootCause: "Slow provider or tool fan-out, often amplified by automated suites.",
        fix: "Separate customer vs test latency. Cap outliers and fix the slow authorised path.",
        tests: "Latency budget on customer-class turns only.",
      }),
    );
  }
  if (below(metrics.overallQuality, 70) && !breaches.some((item) => item.severity === "HIGH" || item.severity === "CRITICAL")) {
    push(
      degradation({
        clusterKey: "QUALITY_SCORE_DEGRADATION",
        category: "RELIABILITY_DEGRADATION",
        title: "Overall quality is below 70",
        score: metrics.overallQuality,
        target: QUALITY_TARGETS.overall,
        severity: "HIGH",
        current: `Overall quality ${fmtScore(metrics.overallQuality)}.`,
        expected: `Overall quality ≥${QUALITY_TARGETS.overall}.`,
        rootCause: "Multiple dimensions failed together; score-only view hid the defects.",
        fix: "Force structured findings from each failed dimension and cluster by root cause.",
        tests: "Bad-metrics fixture must never render an empty improvement list.",
      }),
    );
  }
  return breaches;
}

export function metricsRequireFindings(metrics: Pick<MetricSnapshot, "overallQuality" | "toolSelection" | "exactTool" | "firstAnswer" | "hallucinations" | "failures">): boolean {
  return (
    below(metrics.overallQuality, QUALITY_TARGETS.overall) ||
    below(metrics.toolSelection, QUALITY_TARGETS.toolSelection) ||
    below(metrics.exactTool, QUALITY_TARGETS.exactTool) ||
    below(metrics.firstAnswer, QUALITY_TARGETS.firstAnswer) ||
    metrics.hallucinations > 0 ||
    metrics.failures > 0
  );
}

export function assertReportSane(summary: DailyReportSummary): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const metricsBad = metricsRequireFindings({
    overallQuality: summary.overallQuality,
    toolSelection: summary.toolSelection,
    exactTool: summary.exactTool,
    firstAnswer: summary.firstAnswer,
    hallucinations: summary.hallucinations,
    failures: summary.failures,
  });
  if (metricsBad && summary.issues.length === 0) {
    reasons.push("bad metrics cannot render zero improvements");
  }
  if (metricsBad && summary.actionPlan.length === 0) {
    reasons.push("bad metrics cannot render an empty action plan");
  }
  if ((summary.totalInteractions ?? 0) > 0 && !summary.byTrafficClass) {
    reasons.push("interactions present but traffic classes missing");
  }
  if ((summary.totalInteractions ?? 0) > 0 && Object.keys(summary.byTrafficClass ?? {}).length === 0) {
    reasons.push("301-style interaction counts with zero classification");
  }
  if (summary.hallucinations > 0 && !summary.actionPlan.some((item) => /hallucin/i.test(item.title))) {
    reasons.push("hallucinations present but no hallucination action");
  }
  if (summary.failures > 0 && summary.issues.length === 0) {
    reasons.push("failures present but no issues");
  }
  return { ok: reasons.length === 0, reasons };
}

export function findingsFromMetricBreach(breach: MetricBreach): QualityFinding {
  return {
    category: breach.category,
    severity: breach.severity,
    confidence: 0.95,
    expectedBehavior: breach.expectedBehaviour,
    actualBehavior: breach.currentBehaviour,
    evidenceReference: "aggregate_metrics",
    rootCauseHypothesis: breach.rootCause,
    userImpact: breach.title,
  };
}

export function clusterStubFromBreach(
  runId: string,
  breach: MetricBreach,
  extras?: Partial<DailyImprovementCluster>,
): Omit<DailyImprovementCluster, "id"> {
  return {
    runId,
    clusterKey: breach.clusterKey,
    category: breach.category,
    title: breach.title,
    severity: breach.severity,
    interactionCount: extras?.interactionCount ?? 0,
    tenantCount: extras?.tenantCount ?? 1,
    companyIds: extras?.companyIds ?? [],
    channels: extras?.channels ?? [],
    exampleIds: extras?.exampleIds ?? [],
    currentBehaviour: breach.currentBehaviour,
    expectedBehaviour: breach.expectedBehaviour,
    rootCause: breach.rootCause,
    proposedFix: breach.proposedFix,
    risk: breach.risk,
    testsRequired: breach.testsRequired,
    expectedBenefit: breach.expectedBenefit,
    status: "OPEN",
    lifecycle: extras?.lifecycle ?? "NEW",
  };
}

function degradation(input: {
  clusterKey: string;
  category: FailureCategory | string;
  title: string;
  score: number | null;
  target: number;
  severity: DailyImprovementSeverity;
  current: string;
  expected: string;
  rootCause: string;
  fix: string;
  tests: string;
}): MetricBreach {
  return {
    clusterKey: input.clusterKey,
    category: input.category,
    title: input.title,
    severity: input.severity,
    currentBehaviour: input.current,
    expectedBehaviour: input.expected,
    rootCause: input.rootCause,
    proposedFix: input.fix,
    testsRequired: input.tests,
    expectedBenefit: `Restore ${input.clusterKey} to target ${input.target}.`,
    risk: input.severity === "CRITICAL" ? "HIGH — contain first." : "MEDIUM — reproduce, generic fix, regression, isolation, billing, deploy guard.",
  };
}

function below(value: number | null, target: number): boolean {
  return value != null && value < target;
}

function above(value: number | null, target: number): boolean {
  return value != null && value > target;
}

function fmtScore(value: number | null): string {
  return value == null ? "n/a" : String(value);
}

function fmtMs(value: number | null): string {
  return value == null ? "n/a" : `${value}ms`;
}
