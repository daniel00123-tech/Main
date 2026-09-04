import { describe, expect, it } from "vitest";
import { validateAutomationConfiguration } from "../automation-engine/actions/index";
import {
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  listAvailableAutomationTemplates,
} from "@infra/shared";
import { isGenuineCustomerTraffic } from "./audit";
import { clusterEvaluations, countBySeverity, seedKnownClusters } from "./cluster";
import { DAILY_IMPROVEMENT_CONTRACT } from "./constants";
import { CURSOR_RUNNER_BLOCKER, buildJobSpec, selectJobsForCycle } from "./engineering";
import { heuristicEvaluate } from "./evaluator";
import { buildDailyReport } from "./report";
import { decideDailyImprovementWindow, reportSubject } from "./windows";
import type { DailyImprovementEvaluation, DailyImprovementInteraction } from "./types";

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

  it("seeds the known OpenAI clusters into the engineering queue", () => {
    const seeded = seedKnownClusters("run_1", []);
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
    const payload = buildDailyReport({
      date: "2026-09-04",
      recipients: ["daniel.dwyer123@gmail.com"],
      interactions: [interaction()],
      evaluations: [],
      clusters: seedKnownClusters("run_1", []),
      yesterdaysFixes: [],
    });
    expect(payload.subject).toBe(reportSubject("2026-09-04"));
    expect(payload.bodyText).toMatch(/No approval is required/);
    expect(payload.bodyText).toMatch(/QUEUED FOR AUTOMATIC ENGINEERING/);
    expect(payload.bodyHtml.toLowerCase()).not.toMatch(/review &amp; approve|href=.*approve|>approve<|>confirm<|>deploy</);
    expect(payload.summary.actionPlan.length).toBeGreaterThan(0);
    const counts = countBySeverity(payload.summary.issues);
    expect(counts.HIGH).toBeGreaterThan(0);
  });
});
