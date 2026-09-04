import type { Env } from "../../env";
import { listQualityLoopRecipients, sendQualityLoopEmail } from "../quality-loop/email";
import { COMPANY_LABELS } from "./constants";
import type { DailyImprovementCluster, DailyImprovementEvaluation, DailyImprovementInteraction, DailyReportPayload, DailyReportSummary } from "./types";
import { reportSubject } from "./windows";

export function buildDailyReport(input: {
  date: string;
  recipients: string[];
  interactions: DailyImprovementInteraction[];
  evaluations: DailyImprovementEvaluation[];
  clusters: DailyImprovementCluster[];
  yesterdaysFixes: Array<Record<string, unknown>>;
}): DailyReportPayload {
  const summary = summarise(input);
  const subject = reportSubject(input.date);
  const bodyText = renderText(input.date, summary);
  const bodyHtml = renderHtml(input.date, subject, summary);
  return { date: input.date, subject, bodyText, bodyHtml, recipients: input.recipients, summary };
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
    eventType: "daily_improvement.report_sent",
    resourceId,
  });
  return { ...result, recipients };
}

function summarise(input: {
  interactions: DailyImprovementInteraction[];
  evaluations: DailyImprovementEvaluation[];
  clusters: DailyImprovementCluster[];
  yesterdaysFixes: Array<Record<string, unknown>>;
}): DailyReportSummary {
  const byChannel: Record<string, number> = {};
  const byCompany: Record<string, number> = {};
  const provider: Record<string, { count: number; qualitySum: number; qualityN: number }> = {};
  for (const row of input.interactions) {
    byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1;
    const label = COMPANY_LABELS[row.companyId] ?? row.companyId;
    byCompany[label] = (byCompany[label] ?? 0) + 1;
    const key = `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`;
    provider[key] ??= { count: 0, qualitySum: 0, qualityN: 0 };
    provider[key].count += 1;
  }
  const avg = (select: (row: DailyImprovementEvaluation) => number) => {
    if (!input.evaluations.length) return null;
    return Math.round(input.evaluations.reduce((sum, row) => sum + select(row), 0) / input.evaluations.length);
  };
  const hallucinations = input.evaluations.filter((row) => row.failureCategories.includes("HALLUCINATION")).length;
  const permissionIssues = input.evaluations.filter((row) =>
    row.failureCategories.some((cat) => cat === "PERMISSION_LEAK" || cat === "FALSE_PERMISSION_DENIAL" || cat === "CROSS_TENANT_RISK"),
  ).length;
  const repeats = input.evaluations.filter((row) => row.failureCategories.includes("USER_HAD_TO_REPEAT")).length;
  const latencies = input.interactions.map((row) => row.latencyMs).filter((n): n is number => n != null);
  for (const evaluation of input.evaluations) {
    const interaction = input.interactions.find((row) => row.interactionId === evaluation.interactionId);
    const key = `${interaction?.provider ?? "unknown"}/${interaction?.model ?? "unknown"}`;
    provider[key] ??= { count: 0, qualitySum: 0, qualityN: 0 };
    provider[key].qualitySum += evaluation.overallScore;
    provider[key].qualityN += 1;
  }
  return {
    totalChats: input.interactions.length,
    byChannel,
    byCompany,
    overallQuality: avg((row) => row.overallScore),
    correctAnswerRate: avg((row) => (row.overallScore >= 80 ? 100 : 0)),
    toolSelection: avg((row) => row.scores.TOOL_SELECTION),
    exactTool: avg((row) => row.scores.EXACT_TOOL),
    firstAnswer: avg((row) => row.scores.FIRST_ANSWER),
    followUp: avg((row) => row.scores.FOLLOW_UP),
    userRepeatRate: input.evaluations.length ? Math.round((repeats / input.evaluations.length) * 100) : null,
    hallucinations,
    permissionIssues,
    failures: input.evaluations.filter((row) => (row.failureCategories.length ?? 0) > 0).length,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    providerComparison: Object.fromEntries(
      Object.entries(provider).map(([key, value]) => [
        key,
        { count: value.count, quality: value.qualityN ? Math.round(value.qualitySum / value.qualityN) : null },
      ]),
    ),
    issues: input.clusters,
    actionPlan: input.clusters.map((cluster) => ({
      title: cluster.title,
      status: "QUEUED FOR AUTOMATIC ENGINEERING",
      severity: cluster.severity,
    })),
    yesterdaysFixes: input.yesterdaysFixes,
  };
}

function renderText(date: string, summary: DailyReportSummary): string {
  const issues = groupIssues(summary.issues);
  return [
    `INFRA — Daily AI Quality & Improvement Report — ${date}`,
    "This report is informational. Automatic engineering starts independently. No approval is required.",
    "",
    "EXECUTIVE SUMMARY",
    `TOTAL CHATS TODAY: ${summary.totalChats}`,
    `By channel: ${fmtMap(summary.byChannel)}`,
    `By company: ${fmtMap(summary.byCompany)}`,
    `Overall quality score: ${fmt(summary.overallQuality)}`,
    `Correct-answer rate: ${fmt(summary.correctAnswerRate)}`,
    `Tool-selection accuracy: ${fmt(summary.toolSelection)}`,
    `Exact-tool accuracy: ${fmt(summary.exactTool)}`,
    `First-answer score: ${fmt(summary.firstAnswer)}`,
    `Follow-up score: ${fmt(summary.followUp)}`,
    `User-repeat rate: ${fmt(summary.userRepeatRate)}${summary.userRepeatRate != null ? "%" : ""}`,
    `Hallucinations: ${summary.hallucinations}`,
    `Permission/security issues: ${summary.permissionIssues}`,
    `Failures: ${summary.failures}`,
    `Average latency: ${summary.averageLatencyMs != null ? `${summary.averageLatencyMs}ms` : "n/a"}`,
    `Provider/model comparison: ${fmtProvider(summary.providerComparison)}`,
    "",
    "ALL IMPROVEMENTS",
    ...(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).flatMap((severity) => [
      "",
      severity,
      ...(issues[severity].length
        ? issues[severity].map((item) => issueBlock(item))
        : ["None."]),
    ]),
    "",
    "ACTION PLAN — AUTOMATIC ACTIONS STARTING AFTER THIS REPORT",
    ...summary.actionPlan.map((item, index) => `${index + 1}. ${item.title} [${item.severity}] — ${item.status}`),
    ...(summary.actionPlan.length ? [] : ["None queued."]),
    "",
    "YESTERDAY'S AUTOMATIC FIXES",
    ...(summary.yesterdaysFixes.length
      ? summary.yesterdaysFixes.map((item) => yesterdayLine(item))
      : ["No automatic deployments in the previous cycle."]),
    "",
    "OpenAI canary is not promoted by this loop. EL remains openai_shadow unless a separate provider-promotion policy says otherwise.",
  ].join("\n");
}

function renderHtml(date: string, subject: string, summary: DailyReportSummary): string {
  const issues = groupIssues(summary.issues);
  return `
    <div style="font-family:Georgia,serif;color:#1b1916;line-height:1.45">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b6258">INFRA Daily Improvement</p>
      <h1 style="margin:0 0 12px;font-size:22px">${esc(subject)}</h1>
      <p><strong>Informational only.</strong> Automatic engineering starts independently. There is no Approve, Confirm, or Deploy action in this email.</p>
      <h2>Executive summary</h2>
      <p>Total chats today: <strong>${summary.totalChats}</strong></p>
      <p>Channels: ${esc(fmtMap(summary.byChannel))}<br/>Companies: ${esc(fmtMap(summary.byCompany))}</p>
      <p>Quality ${fmt(summary.overallQuality)} · tool ${fmt(summary.toolSelection)} · exact ${fmt(summary.exactTool)} · first answer ${fmt(summary.firstAnswer)} · follow-up ${fmt(summary.followUp)}</p>
      <p>Repeats ${fmt(summary.userRepeatRate)}${summary.userRepeatRate != null ? "%" : ""} · hallucinations ${summary.hallucinations} · permission ${summary.permissionIssues} · failures ${summary.failures} · latency ${summary.averageLatencyMs ?? "n/a"}ms</p>
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
      ${
        summary.actionPlan.length
          ? `<ol>${summary.actionPlan.map((item) => `<li>${esc(item.title)} — ${esc(item.status)}</li>`).join("")}</ol>`
          : "<p>None queued.</p>"
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
    `Issue: ${item.title}`,
    `Affected interactions: ${item.interactionCount}`,
    `Affected tenants: ${item.tenantCount} (${item.companyIds.join(", ") || "n/a"})`,
    `Current: ${item.currentBehaviour ?? ""}`,
    `Expected: ${item.expectedBehaviour ?? ""}`,
    `Root cause: ${item.rootCause ?? ""}`,
    `Proposed fix: ${item.proposedFix ?? ""}`,
    `Risk: ${item.risk ?? ""}`,
    `Tests: ${item.testsRequired ?? ""}`,
    `Benefit: ${item.expectedBenefit ?? ""}`,
  ].join(" | ");
}

function yesterdayLine(item: Record<string, unknown>): string {
  return [
    item.title ?? item.cluster_key ?? "fix",
    item.severity ?? "",
    item.sha ?? "",
    item.verification_status ?? "",
    item.rollback_at ? "ROLLED BACK" : "KEPT",
  ]
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

function fmtProvider(value: DailyReportSummary["providerComparison"]): string {
  const entries = Object.entries(value);
  return entries.length
    ? entries.map(([key, row]) => `${key} n=${row.count} q=${row.quality ?? "n/a"}`).join("; ")
    : "n/a";
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
