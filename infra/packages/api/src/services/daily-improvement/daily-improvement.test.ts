import { describe, expect, it } from "vitest";
import { validateAutomationConfiguration } from "../automation-engine/actions/index";
import {
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  listAvailableAutomationTemplates,
} from "@infra/shared";
import { isGenuineCustomerTraffic } from "./audit";
import { clusterEvaluations, clustersFromMetrics, countBySeverity, seedKnownClusters } from "./cluster";
import { DAILY_IMPROVEMENT_CONTRACT } from "./constants";
import { CURSOR_RUNNER_BLOCKER, buildJobSpec, selectJobsForCycle } from "./engineering";
import { heuristicEvaluate } from "./evaluator";
import { emptyScores } from "./evaluator";
import { buildDailyReport, ensureReportClusters } from "./report";
import { assertReportSane, metricBreaches } from "./thresholds";
import { classifyDailyTraffic, looksLikeAutomatedTestPrompt } from "./traffic";
import { decideDailyImprovementWindow, reportSubject } from "./windows";
import type { DailyImprovementEvaluation, DailyImprovementInteraction, DimensionScores } from "./types";

function interaction(partial: Partial<DailyImprovementInteraction> = {}): DailyImprovementInteraction {
  return {
    id: "dii_1",
    interactionId: "int_1",
    customerRequestId: "int_1",
    companyId: "co_el",
    userId: "usr_1",
    role: "director",
    channel: "portal_chat",
    conversationId: "conv_1",
    createdAt: "2026-09-04T12:00:00.000Z",
    userMessage: "Xero sales this month and the latest finance email",
    provider: "openai",
    model: "gpt-5.6-terra",
    providerMode: "openai_shadow",
    availableCapabilities: ["ACCOUNTING_SALES", "EMAIL_LIST"],
    toolsRequested: ["xero_sales_summary"],
    toolsExecuted: ["xero_sales_summary"],
    evidenceRefs: [{ companyId: "co_el", source: "xero", toolName: "xero_sales_summary" }],
    assistantAnswer: "Sales were £10k.",
    terminalState: "ANSWER",
    latencyMs: 1200,
    customerChargeCents: 3,
    providerCostCents: 0,
    qualityResult: null,
    correlationId: "corr_1",
    trafficClass: "CUSTOMER_REQUEST",
    sourceClient: "portal_chat",
    ...partial,
  };
}

describe("daily improvement contracts", () => {
  it("keeps Cursor off the customer path and does not require approval", () => {
    expect(DAILY_IMPROVEMENT_CONTRACT.cursorInCustomerPath).toBe(false);
    expect(DAILY_IMPROVEMENT_CONTRACT.requiresHumanApproval).toBe(false);
    expect(DAILY_IMPROVEMENT_CONTRACT.autoPromoteProvider).toBe(false);
    expect(DAILY_IMPROVEMENT_CONTRACT.autoDeployFromSingleFailure).toBe(false);
    expect(DAILY_IMPROVEMENT_CONTRACT.qaCustomerChargeCents).toBe(0);
    expect(DAILY_IMPROVEMENT_CONTRACT.elCustomerRequestCents).toBe(3);
    expect(CURSOR_RUNNER_BLOCKER.canWorkerSpawnCursorCloudAgent).toBe(false);
  });

  it("does not expose the loop as a customer automation template", () => {
    const available = listAvailableAutomationTemplates().map((item) => item.key);
    expect(available).not.toContain(DAILY_IMPROVEMENT_QA_TEMPLATE);
    expect(validateAutomationConfiguration("internal", { handler: DAILY_IMPROVEMENT_QA_TEMPLATE })).toBeNull();
    expect(validateAutomationConfiguration("internal", { handler: DAILY_IMPROVEMENT_REPORT_TEMPLATE })).toBeNull();
    expect(validateAutomationConfiguration("internal", { handler: DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE })).toBeNull();
  });

  it("never bills QA, engineering, or test traffic as a customer request", () => {
    expect(isGenuineCustomerTraffic("CUSTOMER_REQUEST")).toBe(true);
    expect(isGenuineCustomerTraffic("QUALITY")).toBe(false);
    expect(isGenuineCustomerTraffic("ENGINEERING")).toBe(false);
    expect(isGenuineCustomerTraffic("TEST")).toBe(false);
    expect(isGenuineCustomerTraffic("SHADOW")).toBe(false);
  });

  it("fires QA, report, and engineering windows in Europe/London", () => {
    const qa = decideDailyImprovementWindow(new Date("2026-09-04T15:30:00.000Z"));
    const report = decideDailyImprovementWindow(new Date("2026-09-04T16:00:00.000Z"));
    const engineering = decideDailyImprovementWindow(new Date("2026-09-04T16:05:00.000Z"));
    expect(qa.some((item) => item.kind === "QA" && item.due)).toBe(true);
    expect(report.some((item) => item.kind === "REPORT" && item.due)).toBe(true);
    expect(engineering.some((item) => item.kind === "ENGINEERING" && item.due)).toBe(true);
    expect(decideDailyImprovementWindow(new Date("2026-09-04T07:00:00.000Z"))).toEqual([]);
  });
});

describe("daily improvement evaluator and clustering", () => {
  it("flags mixed multi-tool when only one family ran", () => {
    const evaluation = heuristicEvaluate({
      interaction: interaction(),
      sequence: [
        { role: "user", text: "Xero sales this month and the latest finance email" },
        { role: "assistant", text: "Sales were £10k." },
      ],
    });
    expect(evaluation.failureCategories).toContain("MIXED_MULTI_TOOL");
    expect(evaluation.customerChargeCents).toBe(0);
    expect(evaluation.trafficClass).toBe("QUALITY");
    expect(evaluation.findings.some((item) => item.category === "MIXED_MULTI_TOOL")).toBe(true);
    expect(evaluation.findings[0]?.expectedBehavior).toBeTruthy();
  });

  it("clusters shared categories across tenants without copying raw content", () => {
    const a: DailyImprovementEvaluation = {
      ...heuristicEvaluate({ interaction: interaction(), sequence: [] }),
      id: "e1",
      runId: "run_1",
      createdAt: "2026-09-04T12:00:00.000Z",
    };
    const b: DailyImprovementEvaluation = {
      ...heuristicEvaluate({
        interaction: interaction({ interactionId: "int_2", companyId: "co_caddington" }),
        sequence: [],
      }),
      id: "e2",
      runId: "run_1",
      createdAt: "2026-09-04T12:01:00.000Z",
    };
    const clusters = clusterEvaluations([a, b], "run_1");
    const mixed = clusters.find((item) => item.clusterKey === "MIXED_MULTI_TOOL");
    expect(mixed?.tenantCount).toBe(2);
    expect(mixed?.companyIds).toEqual(expect.arrayContaining(["co_el", "co_caddington"]));
    expect(JSON.stringify(mixed)).not.toMatch(/Sales were/);
  });

  it("can still enqueue known OpenAI clusters when explicitly seeded", () => {
    const seeded = seedKnownClusters("run_1", [], { onlyIfPresent: false });
    expect(seeded.map((item) => item.clusterKey)).toEqual(
      expect.arrayContaining(["MIXED_MULTI_TOOL", "XERO_EXACT_TOOL_SELECTION"]),
    );
    const issues = seeded.map((cluster, index) => ({
      id: `issue_${index}`,
      clusterId: cluster.id,
      runId: "run_1",
      title: cluster.title,
      category: String(cluster.category),
      severity: cluster.severity,
      status: "QUEUED",
      priorityScore: 10 - index,
      affectedInteractions: cluster.interactionCount,
      affectedTenants: cluster.tenantCount,
    }));
    const selected = selectJobsForCycle(issues, seeded, 5);
    expect(selected.length).toBeGreaterThan(0);
    expect(buildJobSpec(selected[0].cluster).forbidden.providerPromotion).toBe(true);
    expect(buildJobSpec(selected[0].cluster).reproduceFirst).toBe(true);
  });

  it("classifies cross-tenant evidence as critical", () => {
    const evaluation = heuristicEvaluate({
      interaction: interaction({
        evidenceRefs: [{ companyId: "co_ht", source: "xero", toolName: "xero_sales_summary" }],
      }),
      sequence: [],
    });
    expect(evaluation.failureCategories).toContain("CROSS_TENANT_RISK");
    expect(evaluation.severity).toBe("CRITICAL");
  });
});

describe("daily improvement report", () => {
  it("is informational and contains no approval CTA", () => {
    const clusters = clustersFromMetrics("run_1", badMetricSnapshot());
    const payload = buildDailyReport({
      date: "2026-09-04",
      recipients: ["daniel.dwyer123@gmail.com"],
      interactions: [interaction({ userMessage: "Please send the September aged receivables for EL." })],
      evaluations: [scoredEval({ overall: 67, tool: 51, exact: 51, first: 47, categories: ["HALLUCINATION"] })],
      clusters,
      yesterdaysFixes: [],
    });
    expect(payload.subject).toBe(reportSubject("2026-09-04"));
    expect(payload.bodyText).toMatch(/No approval is required/);
    expect(payload.bodyText).toMatch(/QUEUED FOR CURSOR/);
    expect(payload.bodyHtml.toLowerCase()).not.toMatch(/review &amp; approve|href=.*approve|>approve<|>confirm<|>deploy</);
    expect(payload.summary.actionPlan.length).toBeGreaterThan(0);
    const counts = countBySeverity(payload.summary.issues);
    expect(counts.HIGH).toBeGreaterThan(0);
  });

  it("turns the contradictory 67/51/38 fixture into multiple engineering findings", () => {
    const interactions = [
      interaction({ userMessage: "Please send the September aged receivables for EL." }),
      interaction({
        id: "dii_test",
        interactionId: "int_test",
        userMessage: "What are our Xero sales this month?",
        trafficClass: "TEST",
        customerChargeCents: 0,
      }),
    ];
    const evaluations = Array.from({ length: 10 }, (_, index) =>
      scoredEval({
        id: `e_${index}`,
        interactionId: index === 9 ? "int_test" : "int_1",
        overall: 67,
        tool: 51,
        exact: 51,
        first: 47,
        follow: 65,
        categories:
          index < 7
            ? ["HALLUCINATION", "EXPECTED_TOOL_MISSING", "USER_HAD_TO_REPEAT"]
            : ["EXPECTED_TOOL_MISSING"],
      }),
    );
    const clusters = ensureReportClusters({ runId: "run_bad", interactions, evaluations, clusters: [] });
    expect(clusters.length).toBeGreaterThan(1);
    const payload = buildDailyReport({
      date: "2026-09-04",
      recipients: ["daniel.dwyer123@gmail.com"],
      interactions,
      evaluations,
      clusters,
      yesterdaysFixes: [],
    });
    expect(payload.summary.issues.length).toBeGreaterThan(1);
    expect(payload.summary.actionPlan.length).toBeGreaterThan(1);
    expect(payload.bodyText).not.toMatch(/HIGH\nNone/);
    expect(payload.bodyText).toMatch(/AUTOMATIC ACTION PLAN/);
    expect(payload.bodyText).not.toMatch(/None queued/);
    expect(assertReportSane(payload.summary).ok).toBe(true);
    expect(payload.summary.testInteractions).toBe(1);
    expect(payload.summary.customerInteractions).toBe(1);
  });

  it("allows an empty improvement list only when customer metrics are healthy", () => {
    const healthy = scoredEval({
      overall: 99,
      tool: 100,
      exact: 100,
      first: 100,
      follow: 100,
      categories: [],
    });
    const clusters = ensureReportClusters({
      runId: "run_ok",
      interactions: [interaction({ userMessage: "Thanks — that aged-receivables pack is exactly what I needed." })],
      evaluations: [healthy],
      clusters: [],
    });
    const payload = buildDailyReport({
      date: "2026-09-04",
      recipients: ["daniel.dwyer123@gmail.com"],
      interactions: [interaction({ userMessage: "Thanks — that aged-receivables pack is exactly what I needed." })],
      evaluations: [healthy],
      clusters,
      yesterdaysFixes: [],
    });
    expect(payload.summary.overallQuality).toBeGreaterThanOrEqual(95);
    expect(payload.summary.hallucinations).toBe(0);
    expect(payload.summary.failures).toBe(0);
    expect(assertReportSane(payload.summary).ok).toBe(true);
  });

  it("rejects a report that shows bad metrics and no improvements", () => {
    const sane = assertReportSane({
      ...buildDailyReport({
        date: "2026-09-04",
        recipients: [],
        interactions: [interaction()],
        evaluations: [scoredEval({ overall: 67, tool: 51, exact: 51, first: 47, categories: ["HALLUCINATION"] })],
        clusters: [],
        yesterdaysFixes: [],
      }).summary,
      issues: [],
      actionPlan: [],
    });
    expect(sane.ok).toBe(false);
    expect(sane.reasons.join(" ")).toMatch(/zero improvements|empty action plan|hallucination/i);
  });
});

describe("traffic classification", () => {
  it("does not treat frozen-bench prompts as genuine customer chat", () => {
    expect(looksLikeAutomatedTestPrompt("What are our Xero sales this month?")).toBe(true);
    expect(classifyDailyTraffic({ userMessage: "What are our Xero sales this month?", sourceClient: "portal_chat" })).toBe(
      "TEST",
    );
    expect(classifyDailyTraffic({ userAgent: "InfraAcceptance/1.0", sourceClient: "portal_chat" })).toBe("TEST");
    expect(
      classifyDailyTraffic({
        userMessage: "Can you pull last Thursday's site-visit notes for the Bedford job?",
        sourceClient: "portal_chat",
      }),
    ).toBe("CUSTOMER_REQUEST");
  });
});

describe("permission and metric breach rules", () => {
  it("does not treat an expected RBAC denial as a defect cluster", () => {
    const evaluation = heuristicEvaluate({
      interaction: interaction({
        userMessage: "Show Xero sales",
        assistantAnswer: "I don't have access to Xero sales for this role.",
        terminalState: "permission_denied",
        toolsExecuted: [],
      }),
      sequence: [],
    });
    expect(evaluation.failureCategories).toContain("EXPECTED_PERMISSION_DENIAL");
    expect(evaluation.failureCategories).not.toContain("FALSE_PERMISSION_DENIAL");
    const clusters = clusterEvaluations(
      [{ ...evaluation, id: "e_perm", runId: "run_1", createdAt: "2026-09-04T12:00:00.000Z" }],
      "run_1",
    );
    expect(clusters.find((item) => item.clusterKey === "EXPECTED_PERMISSION_DENIAL")).toBeUndefined();
  });

  it("creates dimension clusters from the agreed score targets", () => {
    const breaches = metricBreaches(badMetricSnapshot());
    expect(breaches.map((item) => item.clusterKey)).toEqual(
      expect.arrayContaining([
        "TOOL_SELECTION_DEGRADATION",
        "EXACT_TOOL_DEGRADATION",
        "FIRST_ANSWER_INCOMPLETE",
        "HALLUCINATION",
      ]),
    );
  });
});

function scoredEval(input: {
  id?: string;
  interactionId?: string;
  overall: number;
  tool: number;
  exact: number;
  first: number;
  follow?: number;
  categories: DailyImprovementEvaluation["failureCategories"];
}): DailyImprovementEvaluation {
  const scores = emptyScores(input.overall) as DimensionScores;
  scores.TOOL_SELECTION = input.tool;
  scores.EXACT_TOOL = input.exact;
  scores.FIRST_ANSWER = input.first;
  scores.FOLLOW_UP = input.follow ?? 95;
  return {
    id: input.id ?? "e_score",
    interactionId: input.interactionId ?? "int_1",
    conversationId: "conv_1",
    runId: "run_1",
    companyId: "co_el",
    channel: "portal_chat",
    overallScore: input.overall,
    scores,
    failureCategories: input.categories,
    findings: input.categories.map((category) => ({
      category,
      severity: "HIGH",
      confidence: 0.9,
      expectedBehavior: "target met",
      actualBehavior: "target missed",
      evidenceReference: input.interactionId ?? "int_1",
      rootCauseHypothesis: "fixture",
      userImpact: String(category),
    })),
    severity: input.categories.length ? "HIGH" : null,
    notes: input.categories.join(","),
    evaluatorModel: "fixture",
    evaluatorKind: "heuristic",
    trafficClass: "QUALITY",
    customerChargeCents: 0,
    createdAt: "2026-09-04T12:00:00.000Z",
  };
}

function badMetricSnapshot() {
  return {
    overallQuality: 67,
    toolSelection: 51,
    exactTool: 51,
    firstAnswer: 47,
    followUp: 65,
    userRepeatRate: 23,
    hallucinations: 7,
    customerHallucinations: 7,
    falsePermissionDenials: 5,
    permissionLeaks: 0,
    failures: 38,
    customerFailures: 38,
    failureRatePct: 38,
    latencyP95Ms: 54_466,
    latencyMaxMs: 54_466,
    evaluatedTurns: 100,
    toolRequiredTurns: 100,
    toolCorrectTurns: 51,
    exactCorrectTurns: 51,
    firstAnswerCorrectTurns: 47,
  };
}
