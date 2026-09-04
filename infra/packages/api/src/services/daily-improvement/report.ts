import type { Env } from "../../env";
import { listQualityLoopRecipients, sendQualityLoopEmail } from "../quality-loop/email";
import { COMPANY_LABELS } from "./constants";
import {
  average,
  buildChatSummaries,
  buildMetricSnapshot,
  countByTraffic,
  customerEvaluations,
  failureBucket,
  hallucinationKind,
  latencyStats,
  mergeTrend,
  scoreLabel,
  trafficCounts,
} from "./metrics";
import { applyLifecycle, clusterEvaluations, clustersFromMetrics, mergeClusters } from "./cluster";
import { assertReportSane, metricsRequireFindings } from "./thresholds";
import { isGenuineCustomerTraffic, trafficBucket } from "./traffic";
import type {
  DailyImprovementCluster,
  DailyImprovementEvaluation,
  DailyImprovementInteraction,
  DailyReportPayload,
  DailyReportSummary,
} from "./types";
import { correctedReportSubject, reportSubject } from "./windows";

export function buildDailyReport(input: {
  date: string;
  recipients: string[];
  interactions: DailyImprovementInteraction[];
  evaluations: DailyImprovementEvaluation[];
  clusters: DailyImprovementCluster[];
  yesterdaysFixes: Array<Record<string, unknown>>;
  previousSummaries?: Array<{ runDate: string; summary: Record<string, unknown> }>;
  openKeys?: Set<string>;
  deployedTodayKeys?: Set<string>;
  corrected?: boolean;
}): DailyReportPayload {
  const summary = summarise(input);
  const subject = input.corrected ? correctedReportSubject(input.date) : reportSubject(input.date);
  const bodyText = renderText(input.date, summary, subject);
  const bodyHtml = renderHtml(input.date, subject, summary);
  return { date: input.date, subject, bodyText, bodyHtml, recipients: input.recipients, summary };
}

export function ensureReportClusters(input: {
  runId: string;
  interactions: DailyImprovementInteraction[];
  evaluations: DailyImprovementEvaluation[];
  clusters: DailyImprovementCluster[];
}): DailyImprovementCluster[] {
  const metrics = buildMetricSnapshot(input.evaluations, input.interactions);
  const fromEvals = clusterEvaluations(input.evaluations, input.runId);
  const fromMetrics = metricsRequireFindings(metrics) ? clustersFromMetrics(input.runId, metrics) : [];
  return mergeClusters(input.runId, [input.clusters, fromEvals, fromMetrics]);
}

export async function sendDailyImprovementReport(
  env: Env,
  payload: DailyReportPayload,
  resourceId: string,
): Promise<{ sent: boolean; error?: string; recipients: string[] }> {
  const recipients =
    payload.recipients.length > 0 ? payload.recipients : await listQualityLoopRecipients(env.DB, env);
  const result = await sendQualityLoopEmail(env, env.DB, {
    subject: payload.subject,
    bodyText: payload.bodyText,
    bodyHtml: payload.bodyHtml,
    recipients,
    eventType: payload.summary.corrected ? "daily_improvement.corrected_report_sent" : "daily_improvement.report_sent",
    resourceId,
  });
  return { ...result, recipients };
}

function summarise(input: {
  date?: string;
  interactions: DailyImprovementInteraction[];
  evaluations: DailyImprovementEvaluation[];
  clusters: DailyImprovementCluster[];
  yesterdaysFixes: Array<Record<string, unknown>>;
  previousSummaries?: Array<{ runDate: string; summary: Record<string, unknown> }>;
  openKeys?: Set<string>;
  deployedTodayKeys?: Set<string>;
  corrected?: boolean;
}): DailyReportSummary {
  const byChannel: Record<string, number> = {};
  const byCompany: Record<string, number> = {};
  const provider: Record<string, { count: number; qualitySum: number; qualityN: number; latencies: number[] }> = {};
  for (const row of input.interactions) {
    byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1;
    const label = COMPANY_LABELS[row.companyId] ?? row.companyId;
    byCompany[label] = (byCompany[label] ?? 0) + 1;
    const key = `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`;
    provider[key] ??= { count: 0, qualitySum: 0, qualityN: 0, latencies: [] };
    provider[key].count += 1;
    if (row.latencyMs != null) provider[key].latencies.push(row.latencyMs);
  }
  const customerEvals = customerEvaluations(input.evaluations, input.interactions);
  const testEvals = input.evaluations.filter((evaluation) => {
    const interaction = input.interactions.find((row) => row.interactionId === evaluation.interactionId);
    return trafficBucket(interaction?.trafficClass ?? evaluation.interactionTrafficClass) === "test";
  });
  const metrics = buildMetricSnapshot(input.evaluations, input.interactions);
  const byId = new Map(input.interactions.map((row) => [row.interactionId, row]));
  const avg = (rows: DailyImprovementEvaluation[], select: (row: DailyImprovementEvaluation) => number) =>
    average(rows.map(select));

  const hallucinationBreakdown = { customer: 0, test: 0, shadow: 0, kinds: {} as Record<string, number> };
  for (const evaluation of input.evaluations.filter((row) => row.failureCategories.includes("HALLUCINATION"))) {
    const interaction = byId.get(evaluation.interactionId);
    const bucket = trafficBucket(interaction?.trafficClass ?? evaluation.interactionTrafficClass);
    if (bucket === "customer") hallucinationBreakdown.customer += 1;
    else if (bucket === "shadow") hallucinationBreakdown.shadow += 1;
    else hallucinationBreakdown.test += 1;
    const kind = hallucinationKind(evaluation.notes, interaction?.assistantAnswer ?? null);
    hallucinationBreakdown.kinds[kind] = (hallucinationBreakdown.kinds[kind] ?? 0) + 1;
  }

  const expectedPermission = input.evaluations.filter((row) => row.failureCategories.includes("EXPECTED_PERMISSION_DENIAL")).length;
  const falsePermission = input.evaluations.filter((row) =>
    row.failureCategories.some((cat) => cat === "FALSE_PERMISSION_DENIAL" || cat === "RBAC_RESPONSE_CONTRADICTION"),
  ).length;
  const leaks = input.evaluations.filter((row) =>
    row.failureCategories.some((cat) => cat === "PERMISSION_LEAK" || cat === "CROSS_TENANT_RISK"),
  ).length;

  const failureBreakdown: Record<string, number> = {};
  let customerFailures = 0;
  let testFailures = 0;
  for (const evaluation of input.evaluations) {
    const defects = evaluation.failureCategories.filter((cat) => cat !== "EXPECTED_PERMISSION_DENIAL");
    if (!defects.length) continue;
    const interaction = byId.get(evaluation.interactionId);
    const bucket = trafficBucket(interaction?.trafficClass ?? evaluation.interactionTrafficClass);
    if (bucket === "customer") customerFailures += 1;
    if (bucket === "test") testFailures += 1;
    const key = `${failureBucket(defects, interaction?.terminalState)}:${bucket}`;
    failureBreakdown[key] = (failureBreakdown[key] ?? 0) + 1;
  }

  const clusters = applyLifecycle(input.clusters, {
    openKeys: input.openKeys ?? new Set(),
    deployedTodayKeys: input.deployedTodayKeys ?? new Set(),
    previousKeys: new Set(
      (input.previousSummaries ?? []).flatMap((row) => {
        const issues = row.summary.issues;
        if (!Array.isArray(issues)) return [];
        return issues.map((item) => String((item as { clusterKey?: string }).clusterKey ?? "")).filter(Boolean);
      }),
    ),
  });

  const lifecycle = {
    newToday: clusters.filter((item) => item.lifecycle === "NEW").map((item) => item.title),
    stillOpen: clusters.filter((item) => item.lifecycle === "STILL_OPEN").map((item) => item.title),
    fixedToday: clusters.filter((item) => item.lifecycle === "FIXED").map((item) => item.title),
    regressed: [] as string[],
  };

  const prev = (input.previousSummaries ?? []).map((row) => row.summary);
  const trend = (key: string, today: number | null): DailyReportSummary["trends"][string] =>
    mergeTrend(
      today,
      prev.map((summary) => (typeof summary[key] === "number" ? Number(summary[key]) : null)),
    );
  if (trend("overallQuality", metrics.overallQuality).yesterday != null) {
    const previousQuality = trend("overallQuality", metrics.overallQuality).yesterday;
    if (previousQuality != null && metrics.overallQuality != null && metrics.overallQuality < previousQuality - 5) {
      lifecycle.regressed.push(`Quality dropped from ${previousQuality} to ${metrics.overallQuality}`);
    }
  }

  const traffic = trafficCounts(input.interactions);
  const customerTurns = input.interactions.filter((row) => isGenuineCustomerTraffic(row.trafficClass));
  const testTurns = input.interactions.filter((row) => trafficBucket(row.trafficClass) === "test");
  const actionPlan = clusters.map((cluster) => ({
    title: cluster.title,
    status: cluster.lifecycle === "FIXED" ? "FIXED TODAY" : "QUEUED FOR CURSOR",
    severity: cluster.severity,
    clusterKey: cluster.clusterKey,
    affected: cluster.interactionCount,
    channels: cluster.channels ?? [],
    tenants: cluster.companyIds,
    examples: cluster.exampleIds ?? [],
    currentBehaviour: cluster.currentBehaviour ?? "",
    expectedBehaviour: cluster.expectedBehaviour ?? "",
    rootCause: cluster.rootCause ?? "",
    proposedFix: cluster.proposedFix ?? "",
    testsRequired: cluster.testsRequired ?? "",
    risk: cluster.risk ?? "",
  }));

  const summary: DailyReportSummary = {
    totalChats: traffic.customerConversations,
    totalInteractions: input.interactions.length,
    ...traffic,
    byTrafficClass: countByTraffic(input.interactions),
    byChannel,
    byCompany,
    overallQuality: metrics.overallQuality,
    testQuality: avg(testEvals, (row) => row.overallScore),
    correctAnswerRate: avg(customerEvals, (row) => (row.overallScore >= 80 ? 100 : 0)),
    toolSelection: metrics.toolSelection,
    exactTool: metrics.exactTool,
    firstAnswer: metrics.firstAnswer,
    followUp: metrics.followUp,
    toolSelectionLabel: scoreLabel(
      metrics.toolSelection,
      metrics.toolCorrectTurns,
      metrics.toolRequiredTurns,
      "evaluated tool-required customer turns",
    ),
    exactToolLabel: scoreLabel(
      metrics.exactTool,
      metrics.exactCorrectTurns,
      metrics.toolRequiredTurns,
      "evaluated tool-required customer turns",
    ),
    firstAnswerLabel: scoreLabel(
      metrics.firstAnswer,
      metrics.firstAnswerCorrectTurns,
      metrics.evaluatedTurns,
      "evaluated customer turns",
    ),
    followUpLabel: scoreLabel(metrics.followUp, 0, metrics.evaluatedTurns, "evaluated customer turns"),
    userRepeatRate: metrics.userRepeatRate,
    hallucinations: metrics.hallucinations,
    hallucinationBreakdown,
    permissionIssues: falsePermission + leaks,
    expectedPermissionDenials: expectedPermission,
    falsePermissionDenials: falsePermission,
    permissionLeaks: leaks,
    failures: metrics.failures,
    customerFailures,
    testFailures,
    failureBreakdown,
    averageLatencyMs: latencyStats(customerTurns.map((row) => row.latencyMs)).median,
    latency: latencyStats(input.interactions.map((row) => row.latencyMs)),
    customerLatency: latencyStats(customerTurns.map((row) => row.latencyMs)),
    testLatency: latencyStats(testTurns.map((row) => row.latencyMs)),
    providerLatency: Object.fromEntries(
      Object.entries(provider).map(([key, value]) => [key, latencyStats(value.latencies)]),
    ),
    providerComparison: Object.fromEntries(
      Object.entries(provider).map(([key, value]) => {
        for (const evaluation of input.evaluations) {
          const interaction = byId.get(evaluation.interactionId);
          const pkey = `${interaction?.provider ?? "unknown"}/${interaction?.model ?? "unknown"}`;
          if (pkey === key) {
            value.qualitySum += evaluation.overallScore;
            value.qualityN += 1;
          }
        }
        return [key, { count: value.count, quality: value.qualityN ? Math.round(value.qualitySum / value.qualityN) : null }];
      }),
    ),
    trends: {
      quality: trend("overallQuality", metrics.overallQuality),
      tool: trend("toolSelection", metrics.toolSelection),
      exact: trend("exactTool", metrics.exactTool),
      firstAnswer: trend("firstAnswer", metrics.firstAnswer),
      followUp: trend("followUp", metrics.followUp),
    },
    lifecycle,
    chatSummaries: buildChatSummaries(customerTurns, customerEvals),
    issues: clusters,
    actionPlan,
    yesterdaysFixes: input.yesterdaysFixes,
    engineeringStart: "17:05 Europe/London",
    corrected: Boolean(input.corrected),
    sanity: { ok: true, reasons: [] },
  };
  summary.sanity = assertReportSane(summary);
  return summary;
}

function renderText(date: string, summary: DailyReportSummary, subject: string): string {
  const issues = groupIssues(summary.issues);
  return [
    subject,
    "This report is informational. Automatic engineering starts independently. No approval is required.",
    summary.corrected ? "This is a CORRECTED report for the same interaction window. Evidence was not rewritten." : "",
    "",
    "TRAFFIC",
    `Customer conversations: ${summary.customerConversations}`,
    `Customer interactions: ${summary.customerInteractions}`,
    `QA/test interactions: ${summary.testInteractions}`,
    `OpenAI shadow evaluations: ${summary.shadowInteractions}`,
    `Automations / internal / health / engineering: ${summary.automationInternalInteractions}`,
    `All captured interactions: ${summary.totalInteractions}`,
    `By traffic class: ${fmtMap(summary.byTrafficClass)}`,
    `By channel: ${fmtMap(summary.byChannel)}`,
    `By company: ${fmtMap(summary.byCompany)}`,
    "",
    "CUSTOMER QUALITY (headline)",
    `Overall quality: ${fmtTrend(summary.trends.quality)}`,
    `Tool selection: ${summary.toolSelectionLabel} ${arrow(summary.trends.tool)}`,
    `Exact tool: ${summary.exactToolLabel} ${arrow(summary.trends.exact)}`,
    `First answer: ${summary.firstAnswerLabel} ${arrow(summary.trends.firstAnswer)}`,
    `Follow-up: ${fmt(summary.followUp)} ${arrow(summary.trends.followUp)}`,
    `User-repeat rate: ${fmt(summary.userRepeatRate)}${summary.userRepeatRate != null ? "%" : ""}`,
    summary.testQuality != null ? `TEST / QA quality (not the headline): ${summary.testQuality}` : "TEST / QA quality: n/a",
    "",
    "HALLUCINATIONS",
    `Total ${summary.hallucinations} · customer ${summary.hallucinationBreakdown.customer} · test ${summary.hallucinationBreakdown.test} · shadow ${summary.hallucinationBreakdown.shadow}`,
    `Kinds: ${fmtMap(summary.hallucinationBreakdown.kinds)}`,
    "",
    "PERMISSIONS",
    `Expected RBAC denials (not defects): ${summary.expectedPermissionDenials}`,
    `False permission denials: ${summary.falsePermissionDenials}`,
    `Permission / tenant leaks: ${summary.permissionLeaks}`,
    "",
    "FAILURES",
    `Customer failures: ${summary.customerFailures}`,
    `Test failures: ${summary.testFailures}`,
    `Breakdown: ${fmtMap(summary.failureBreakdown)}`,
    "",
    "LATENCY",
    `Customer median/p95/max: ${fmtLatency(summary.customerLatency)}`,
    `Test median/p95/max: ${fmtLatency(summary.testLatency)}`,
    `All-traffic median/p95/max: ${fmtLatency(summary.latency)}`,
    "",
    "ISSUE LIFECYCLE",
    `NEW TODAY: ${summary.lifecycle.newToday.join("; ") || "None"}`,
    `STILL OPEN: ${summary.lifecycle.stillOpen.join("; ") || "None"}`,
    `FIXED TODAY: ${summary.lifecycle.fixedToday.join("; ") || "None"}`,
    `REGRESSED: ${summary.lifecycle.regressed.join("; ") || "None"}`,
    "",
    "ALL IMPROVEMENTS",
    ...(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).flatMap((severity) => [
      "",
      severity,
      ...(issues[severity].length ? issues[severity].map((item) => issueBlock(item)) : ["None."]),
    ]),
    "",
    "AUTOMATIC ACTION PLAN",
    `Planned engineering start: ${summary.engineeringStart}`,
    ...summary.actionPlan.map((item, index) => actionBlock(index + 1, item)),
    ...(summary.actionPlan.length ? [] : ["None queued."]),
    "",
    "CUSTOMER CHAT SUMMARY",
    ...(summary.chatSummaries.length
      ? summary.chatSummaries.map(
          (chat) =>
            `${chat.company} · ${chat.user} · ${chat.channel} · ${chat.turns} turns · q=${chat.qualityScore ?? "n/a"} · issue=${chat.hasIssue ? "yes" : "no"} · ${chat.outcome} · ${chat.topic}`,
        )
      : ["No genuine customer conversations in this window."]),
    "",
    "YESTERDAY'S AUTOMATIC FIXES",
    ...(summary.yesterdaysFixes.length
      ? summary.yesterdaysFixes.map((item) => yesterdayLine(item))
      : ["No automatic deployments in the previous cycle."]),
    "",
    "EL Portal Chat (PA) and WhatsApp (requests) use OpenAI as the user-visible brain with Cloudflare fallback. ChatGPT stays on direct INFRA tools. Global mode remains openai_shadow for unscoped/automation traffic. This loop does not flip openai_primary.",
    "Drill-down: Control Centre → Quality / Engineering. Full transcripts stay in the authenticated portal.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderHtml(date: string, subject: string, summary: DailyReportSummary): string {
  const issues = groupIssues(summary.issues);
  return `
    <div style="font-family:Georgia,serif;color:#1b1916;line-height:1.45">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b6258">INFRA Daily Improvement</p>
      <h1 style="margin:0 0 12px;font-size:22px">${esc(subject)}</h1>
      <p><strong>Informational only.</strong> Automatic engineering starts independently. There is no Approve, Confirm, or Deploy action in this email.</p>
      ${summary.corrected ? "<p><strong>Corrected report</strong> for the same underlying interactions. Scores were not rewritten to look healthier.</p>" : ""}
      <h2>Traffic</h2>
      <p>Customer conversations: <strong>${summary.customerConversations}</strong><br/>
      Customer interactions: ${summary.customerInteractions} · QA/test: ${summary.testInteractions} · Shadow: ${summary.shadowInteractions} · Automation/internal: ${summary.automationInternalInteractions}</p>
      <p>Channels: ${esc(fmtMap(summary.byChannel))}<br/>Companies: ${esc(fmtMap(summary.byCompany))}</p>
      <h2>Customer quality</h2>
      <p>Quality ${esc(fmtTrend(summary.trends.quality))}<br/>
      Tool ${esc(summary.toolSelectionLabel)} ${esc(arrow(summary.trends.tool))}<br/>
      Exact ${esc(summary.exactToolLabel)}<br/>
      First answer ${esc(summary.firstAnswerLabel)}<br/>
      Follow-up ${fmt(summary.followUp)} · repeats ${fmt(summary.userRepeatRate)}${summary.userRepeatRate != null ? "%" : ""}</p>
      <p>Hallucinations ${summary.hallucinations} (customer ${summary.hallucinationBreakdown.customer} / test ${summary.hallucinationBreakdown.test} / shadow ${summary.hallucinationBreakdown.shadow})<br/>
      Expected denials ${summary.expectedPermissionDenials} · false denials ${summary.falsePermissionDenials} · leaks ${summary.permissionLeaks}<br/>
      Customer failures ${summary.customerFailures} · test failures ${summary.testFailures}<br/>
      Customer latency ${esc(fmtLatency(summary.customerLatency))}</p>
      <h2>Lifecycle</h2>
      <p>NEW: ${esc(summary.lifecycle.newToday.join("; ") || "None")}<br/>
      STILL OPEN: ${esc(summary.lifecycle.stillOpen.join("; ") || "None")}<br/>
      FIXED TODAY: ${esc(summary.lifecycle.fixedToday.join("; ") || "None")}<br/>
      REGRESSED: ${esc(summary.lifecycle.regressed.join("; ") || "None")}</p>
      <h2>All improvements</h2>
      ${(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)
        .map(
          (severity) =>
            `<h3>${severity}</h3>${
              issues[severity].length
                ? `<ul>${issues[severity].map((item) => `<li>${esc(issueBlock(item))}</li>`).join("")}</ul>`
                : "<p>None.</p>"
            }`,
        )
        .join("")}
      <h2>Automatic action plan</h2>
      <p>Planned engineering start: ${esc(summary.engineeringStart)}</p>
      ${
        summary.actionPlan.length
          ? `<ol>${summary.actionPlan.map((item) => `<li>${esc(item.severity)} — ${esc(item.title)} — ${esc(item.status)}</li>`).join("")}</ol>`
          : "<p>None queued.</p>"
      }
      <h2>Customer chat summary</h2>
      ${
        summary.chatSummaries.length
          ? `<ul>${summary.chatSummaries
              .map(
                (chat) =>
                  `<li>${esc(chat.company)} · ${esc(chat.user)} · ${esc(chat.channel)} · ${chat.turns} turns · q=${chat.qualityScore ?? "n/a"} · issue=${chat.hasIssue ? "yes" : "no"} · ${esc(chat.topic)}</li>`,
              )
              .join("")}</ul>`
          : "<p>No genuine customer conversations in this window.</p>"
      }
      <h2>Yesterday's automatic fixes</h2>
      ${
        summary.yesterdaysFixes.length
          ? `<ul>${summary.yesterdaysFixes.map((item) => `<li>${esc(yesterdayLine(item))}</li>`).join("")}</ul>`
          : "<p>No automatic deployments in the previous cycle.</p>"
      }
    </div>
  `;
}

function groupIssues(items: DailyImprovementCluster[]): Record<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW", DailyImprovementCluster[]> {
  return {
    CRITICAL: items.filter((item) => item.severity === "CRITICAL"),
    HIGH: items.filter((item) => item.severity === "HIGH"),
    MEDIUM: items.filter((item) => item.severity === "MEDIUM"),
    LOW: items.filter((item) => item.severity === "LOW"),
  };
}

function issueBlock(item: DailyImprovementCluster): string {
  return [
    `ISSUE: ${item.title}`,
    `SEVERITY: ${item.severity}`,
    `AFFECTED: ${item.interactionCount}`,
    `CHANNELS: ${(item.channels ?? []).join(", ") || "n/a"}`,
    `TENANTS: ${item.companyIds.join(", ") || "n/a"}`,
    `EXAMPLES: ${(item.exampleIds ?? []).join(", ") || "n/a"}`,
    `CURRENT: ${item.currentBehaviour ?? ""}`,
    `EXPECTED: ${item.expectedBehaviour ?? ""}`,
    `ROOT CAUSE: ${item.rootCause ?? ""}`,
    `AUTOMATIC FIX: ${item.proposedFix ?? ""}`,
    `TEST PLAN: ${item.testsRequired ?? ""}`,
    `DEPLOYMENT RISK: ${item.risk ?? ""}`,
    `STATUS: ${item.lifecycle ?? item.status}`,
  ].join(" | ");
}

function actionBlock(
  index: number,
  item: DailyReportSummary["actionPlan"][number],
): string {
  return [
    `${index}. ${item.severity} — ${item.title}`,
    `Status: ${item.status}`,
    `Affected: ${item.affected}`,
    `Current: ${item.currentBehaviour}`,
    `Expected: ${item.expectedBehaviour}`,
    `Fix: ${item.proposedFix}`,
    `Tests: ${item.testsRequired}`,
  ].join("\n");
}

function yesterdayLine(item: Record<string, unknown>): string {
  return [item.title ?? item.cluster_key ?? "fix", item.severity ?? "", item.sha ?? "", item.verification_status ?? "", item.rollback_at ? "ROLLED BACK" : "KEPT"]
    .filter(Boolean)
    .join(" · ");
}

function fmt(value: number | null): string {
  return value == null ? "n/a" : String(value);
}

function fmtMap(value: Record<string, number>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, count]) => `${key} ${count}`).join(", ") : "none";
}

function fmtLatency(stats: DailyReportSummary["latency"]): string {
  return `median ${fmt(stats.median)}ms · p95 ${fmt(stats.p95)}ms · max ${fmt(stats.max)}ms`;
}

function fmtTrend(trend: DailyReportSummary["trends"][string]): string {
  if (trend.today == null) return "n/a";
  const yesterday = trend.yesterday != null ? ` ${trend.today < trend.yesterday ? "↓" : trend.today > trend.yesterday ? "↑" : "→"} from ${trend.yesterday}` : "";
  const week = trend.weekAverage != null ? ` · 7-day ${trend.weekAverage}` : "";
  return `${trend.today}${yesterday}${week}`;
}

function arrow(trend: DailyReportSummary["trends"][string]): string {
  if (trend.yesterday == null || trend.today == null) return "";
  return trend.today < trend.yesterday ? `↓ from ${trend.yesterday}` : trend.today > trend.yesterday ? `↑ from ${trend.yesterday}` : `→ ${trend.yesterday}`;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
