import type { Env } from "../../env";
import { recordUsageEvent } from "../usage";
import { listQualityLoopRecipients } from "../quality-loop/email";
import { backfillRecentCustomerInteractions, reclassifyStoredInteractions } from "./audit";
import {
  applyLifecycle,
  clusterEvaluations,
  clustersFromMetrics,
  countBySeverity,
  issuesFromClusters,
  mergeClusters,
} from "./cluster";
import { startEngineeringCycle } from "./engineering";
import { evaluateInteraction } from "./evaluator";
import { buildMetricSnapshot } from "./metrics";
import { buildDailyReport, ensureReportClusters, sendDailyImprovementReport } from "./report";
import {
  beginRun,
  completeRun,
  getDailyImprovementConfig,
  getRun,
  insertEvaluation,
  insertHistory,
  listClustersForRun,
  listEvaluationsForRun,
  listInteractionsSince,
  listOpenEngineeringKeys,
  listRecentReportSummaries,
  listSequence,
  listYesterdayDeployments,
  markBootstrapCompleted,
  replaceClusters,
  replaceIssues,
} from "./store";
import { assertReportSane, metricsRequireFindings } from "./thresholds";
import { isGenuineCustomerTraffic } from "./traffic";
import { MAX_EVALUATIONS_PER_WINDOW, MAX_OPENAI_EVALUATIONS_PER_WINDOW, QUALITY_TRAFFIC_CLASS } from "./constants";
import { londonDateOf, previousCompletedQaWindow } from "./windows";
import type { ConversationTurn, DailyImprovementCluster, DailyImprovementEvaluation } from "./types";

export async function runDailyImprovementQa(
  env: Env,
  now = new Date(),
  options?: { windowFrom?: string; windowTo?: string; runDate?: string; forceCluster?: boolean },
): Promise<{ ran: boolean; runId: string; reason: string; evaluated: number; clusters: number }> {
  const runDate = options?.runDate ?? londonDateOf(now);
  const window = options?.windowFrom
    ? { from: options.windowFrom, to: options.windowTo ?? now.toISOString() }
    : await resolveQaWindow(env, now);
  const begun = await beginRun(env.DB, { runDate, kind: "QA", windowFrom: window.from, windowTo: window.to });
  if (!begun.created) {
    const existing = await getRun(env.DB, runDate, "QA");
    if (existing && (options?.forceCluster || existing.status === "completed")) {
      const repaired = await persistClustersForRun(env, existing.id, window.from, window.to);
      return {
        ran: repaired.wrote,
        runId: existing.id,
        reason: repaired.wrote ? "clusters_repaired" : `QA already ${existing.status}`,
        evaluated: repaired.evaluated,
        clusters: repaired.clusters,
      };
    }
    return { ran: false, runId: begun.id, reason: `QA already ${existing?.status ?? "recorded"}`, evaluated: 0, clusters: 0 };
  }

  const backfilled = await backfillRecentCustomerInteractions(env.DB, window.from, window.to);
  await reclassifyStoredInteractions(env.DB, window.from, window.to);
  const interactions = await listInteractionsSince(env.DB, window.from, window.to);
  const evaluations = [];
  const customers = interactions.filter((row) => isGenuineCustomerTraffic(row.trafficClass));
  const others = interactions.filter((row) => !isGenuineCustomerTraffic(row.trafficClass));
  const slice = [...customers.slice(-Math.max(8, MAX_EVALUATIONS_PER_WINDOW - 20)), ...others.slice(-20)].slice(
    -MAX_EVALUATIONS_PER_WINDOW,
  );
  let openaiBudget = MAX_OPENAI_EVALUATIONS_PER_WINDOW;
  for (const interaction of slice) {
    const prior = await listSequence(env.DB, interaction.companyId, interaction.conversationId, interaction.createdAt);
    const sequence: ConversationTurn[] = prior.flatMap((row) => {
      const turns: ConversationTurn[] = [];
      if (row.userMessage) turns.push({ role: "user", text: row.userMessage, toolsExecuted: row.toolsExecuted, createdAt: row.createdAt });
      if (row.assistantAnswer) turns.push({ role: "assistant", text: row.assistantAnswer, toolsExecuted: row.toolsExecuted, createdAt: row.createdAt });
      return turns;
    });
    const useOpenAi = openaiBudget > 0;
    if (useOpenAi) openaiBudget -= 1;
    const evaluation = await evaluateInteraction(env, {
      interaction,
      sequence,
      runId: begun.id,
      allowOpenAi: useOpenAi,
    });
    await insertEvaluation(env.DB, evaluation);
    evaluations.push(evaluation);
  }
  await recordUsageEvent(env.DB, {
    companyId: interactions[0]?.companyId ?? "co_el",
    resourceType: "daily_improvement_qa",
    action: "quality.evaluate",
    success: true,
    quantity: evaluations.length,
    unit: "evaluation",
    customerChargeCents: 0,
    settlementStatus: "zero_charge",
    metadata: { trafficClass: QUALITY_TRAFFIC_CLASS, runId: begun.id, customerChargeCents: 0 },
  }).catch(() => undefined);

  const clusters = await buildAndStoreClusters(env, begun.id, evaluations, interactions);
  const counts = countBySeverity(clusters);
  await completeRun(env.DB, begun.id, {
    status: "completed",
    summary: { evaluated: evaluations.length, backfilled, clusters: clusters.length, counts },
  });
  await insertHistory(env.DB, {
    eventType: "qa.completed",
    detail: { runId: begun.id, evaluated: evaluations.length, backfilled, clusters: clusters.length, counts },
  });
  await markConfigTimestamp(env, "last_qa_at");
  return { ran: true, runId: begun.id, reason: "completed", evaluated: evaluations.length, clusters: clusters.length };
}

export async function runDailyImprovementReport(
  env: Env,
  now = new Date(),
  options?: { runDate?: string },
): Promise<{ sent: boolean; runId: string; reason: string; recipients: string[]; subject?: string }> {
  const runDate = options?.runDate ?? londonDateOf(now);
  const begun = await beginRun(env.DB, { runDate, kind: "REPORT" });
  if (!begun.created) {
    return { sent: false, runId: begun.id, reason: "report already sent or in progress", recipients: [] };
  }
  const built = await composeReportPayload(env, now, { runDate, corrected: false });
  if (!built.ok || !built.payload) {
    await completeRun(env.DB, begun.id, {
      status: "failed",
      summary: { error: built.reason, sanity: built.payload?.summary.sanity ?? null },
    });
    return { sent: false, runId: begun.id, reason: built.reason, recipients: [] };
  }
  const payload = built.payload;
  const sent = await sendDailyImprovementReport(env, payload, begun.id);
  await completeRun(env.DB, begun.id, {
    status: sent.sent ? "completed" : "failed",
    summary: { ...payload.summary, recipients: sent.recipients, emailError: sent.error ?? null },
    emailSentAt: sent.sent ? new Date().toISOString() : null,
  });
  if (sent.sent) await markConfigTimestamp(env, "last_report_at");
  return {
    sent: sent.sent,
    runId: begun.id,
    reason: sent.sent ? "sent" : sent.error ?? "send_failed",
    recipients: sent.recipients,
    subject: payload.subject,
  };
}

export async function runCorrectedDailyImprovementReport(
  env: Env,
  now = new Date(),
  options?: { runDate?: string },
): Promise<{ sent: boolean; runId: string; reason: string; recipients: string[]; subject?: string; clusters: number }> {
  const runDate = options?.runDate ?? londonDateOf(now);
  const existing = await getRun(env.DB, runDate, "CORRECTED_REPORT");
  if (existing?.status === "completed") {
    return {
      sent: false,
      runId: existing.id,
      reason: "corrected report already sent — refusing duplicate",
      recipients: [],
      clusters: 0,
    };
  }
  const begun = await beginRun(env.DB, { runDate, kind: "CORRECTED_REPORT" });
  if (!begun.created && existing) {
    return { sent: false, runId: begun.id, reason: "corrected report already in progress", recipients: [], clusters: 0 };
  }
  const qa = await getRun(env.DB, runDate, "QA");
  const window = qaWindowOrDefault(qa, now);
  await reclassifyStoredInteractions(env.DB, window.from, window.to);
  if (qa) {
    await persistClustersForRun(env, qa.id, window.from, window.to);
  } else {
    await runDailyImprovementQa(env, now, { runDate, windowFrom: window.from, windowTo: window.to, forceCluster: true });
  }
  const built = await composeReportPayload(env, now, { runDate, corrected: true });
  if (!built.ok || !built.payload) {
    await completeRun(env.DB, begun.id, { status: "failed", summary: { error: built.reason } });
    return { sent: false, runId: begun.id, reason: built.reason, recipients: [], clusters: 0 };
  }
  const sent = await sendDailyImprovementReport(env, built.payload, begun.id);
  await completeRun(env.DB, begun.id, {
    status: sent.sent ? "completed" : "failed",
    summary: { ...built.payload.summary, recipients: sent.recipients, emailError: sent.error ?? null },
    emailSentAt: sent.sent ? new Date().toISOString() : null,
  });
  const qaId = (await getRun(env.DB, runDate, "QA"))?.id;
  const clusters = qaId ? await listClustersForRun(env.DB, qaId) : built.payload.summary.issues;
  const issues = issuesFromClusters(clusters, begun.id);
  await startEngineeringCycle(env, { runId: begun.id, issues, clusters });
  return {
    sent: sent.sent,
    runId: begun.id,
    reason: sent.sent ? "corrected_sent" : sent.error ?? "send_failed",
    recipients: sent.recipients,
    subject: built.payload.subject,
    clusters: clusters.length,
  };
}

export async function runDailyImprovementEngineering(
  env: Env,
  now = new Date(),
  options?: { runDate?: string },
): Promise<{ started: boolean; runId: string; queued: number; reason: string }> {
  const runDate = options?.runDate ?? londonDateOf(now);
  const begun = await beginRun(env.DB, { runDate, kind: "ENGINEERING" });
  if (!begun.created) {
    return { started: false, runId: begun.id, queued: 0, reason: "engineering cycle already started" };
  }
  const qa = await getRun(env.DB, runDate, "QA");
  if (!qa) {
    await runDailyImprovementQa(env, now, { runDate });
  }
  const qaId = (await getRun(env.DB, runDate, "QA"))?.id;
  let clusters = qaId ? await listClustersForRun(env.DB, qaId) : [];
  if (qaId && clusters.length === 0) {
    const window = previousCompletedQaWindow(now);
    const repaired = await persistClustersForRun(env, qaId, window.from, window.to);
    clusters = repaired.clusterRows;
  }
  const issues = issuesFromClusters(clusters, begun.id);
  const cycle = await startEngineeringCycle(env, { runId: begun.id, issues, clusters });
  await completeRun(env.DB, begun.id, {
    status: "completed",
    summary: { queued: cycle.queued, runner: cycle.blocker, maxDeploys: cycle.maxDeploys },
  });
  await markConfigTimestamp(env, "last_engineering_at");
  return { started: true, runId: begun.id, queued: cycle.queued, reason: "queued" };
}

async function composeReportPayload(
  env: Env,
  now: Date,
  options: { runDate: string; corrected: boolean },
): Promise<{ ok: boolean; reason: string; payload?: ReturnType<typeof buildDailyReport> }> {
  let qa = await getRun(env.DB, options.runDate, "QA");
  const window = qaWindowOrDefault(qa, now);
  if (!qa || qa.status !== "completed") {
    const qaResult = await runDailyImprovementQa(env, now, {
      runDate: options.runDate,
      windowFrom: window.from,
      windowTo: window.to,
      forceCluster: true,
    });
    qa = { id: qaResult.runId, status: "completed", summary: {} };
  }
  await persistClustersForRun(env, qa.id, window.from, window.to);
  const interactions = await listInteractionsSince(env.DB, window.from, window.to);
  const evaluations = await listEvaluationsForRun(env.DB, qa.id);
  let clusters = await listClustersForRun(env.DB, qa.id);
  clusters = ensureReportClusters({ runId: qa.id, interactions, evaluations, clusters });
  const sanityProbe = buildDailyReport({
    date: options.runDate,
    recipients: [],
    interactions,
    evaluations,
    clusters,
    yesterdaysFixes: [],
    corrected: options.corrected,
  });
  if (!sanityProbe.summary.sanity.ok) {
    clusters = ensureReportClusters({ runId: qa.id, interactions, evaluations, clusters: [] });
    await replaceClusters(env.DB, qa.id, clusters);
    await replaceIssues(env.DB, issuesFromClusters(clusters, qa.id));
  }
  const lifecycle = await listOpenEngineeringKeys(env.DB);
  const previousSummaries = await listRecentReportSummaries(env.DB, options.runDate, 7);
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const payload = buildDailyReport({
    date: options.runDate,
    recipients,
    interactions,
    evaluations,
    clusters,
    yesterdaysFixes: await listYesterdayDeployments(env.DB, options.runDate),
    previousSummaries,
    openKeys: lifecycle.openKeys,
    deployedTodayKeys: lifecycle.deployedTodayKeys,
    corrected: options.corrected,
  });
  const sane = assertReportSane(payload.summary);
  payload.summary.sanity = sane;
  if (!sane.ok) {
    return { ok: false, reason: `report sanity failed: ${sane.reasons.join("; ")}`, payload };
  }
  return { ok: true, reason: "ready", payload };
}

async function persistClustersForRun(
  env: Env,
  runId: string,
  fromIso: string,
  toIso: string,
): Promise<{ wrote: boolean; evaluated: number; clusters: number; clusterRows: DailyImprovementCluster[] }> {
  const interactions = await listInteractionsSince(env.DB, fromIso, toIso);
  const evaluations = await listEvaluationsForRun(env.DB, runId);
  const existing = await listClustersForRun(env.DB, runId);
  const clusterRows = await buildAndStoreClusters(env, runId, evaluations, interactions, existing);
  return { wrote: clusterRows.length > 0, evaluated: evaluations.length, clusters: clusterRows.length, clusterRows };
}

async function buildAndStoreClusters(
  env: Env,
  runId: string,
  evaluations: DailyImprovementEvaluation[],
  interactions: Awaited<ReturnType<typeof listInteractionsSince>>,
  existing: DailyImprovementCluster[] = [],
): Promise<DailyImprovementCluster[]> {
  const metrics = buildMetricSnapshot(evaluations, interactions);
  const lifecycle = await listOpenEngineeringKeys(env.DB).catch(() => ({
    openKeys: new Set<string>(),
    deployedTodayKeys: new Set<string>(),
  }));
  const merged = applyLifecycle(
    mergeClusters(runId, [
      existing,
      clusterEvaluations(evaluations, runId),
      metricsRequireFindings(metrics) ? clustersFromMetrics(runId, metrics) : [],
    ]),
    { ...lifecycle, previousKeys: new Set() },
  );
  await replaceClusters(env.DB, runId, merged);
  await replaceIssues(env.DB, issuesFromClusters(merged, runId));
  return merged;
}

function qaWindowOrDefault(
  qa: { windowFrom?: string | null; windowTo?: string | null; summary?: Record<string, unknown> } | null,
  now: Date,
): { from: string; to: string } {
  if (qa?.windowFrom && qa?.windowTo) return { from: qa.windowFrom, to: qa.windowTo };
  return previousCompletedQaWindow(now);
}

async function resolveQaWindow(env: Env, now: Date): Promise<{ from: string; to: string }> {
  const config = await getDailyImprovementConfig(env.DB);
  const lastQa = config?.last_qa_at ? String(config.last_qa_at) : null;
  if (lastQa) return { from: lastQa, to: now.toISOString() };
  return previousCompletedQaWindow(now);
}

export async function markConfigTimestamp(env: Env, field: "last_qa_at" | "last_report_at" | "last_engineering_at"): Promise<void> {
  await env.DB.prepare(`UPDATE daily_improvement_config SET ${field} = ?, updated_at = ? WHERE id = 'platform'`)
    .bind(new Date().toISOString(), new Date().toISOString())
    .run()
    .catch(() => undefined);
}

export { markBootstrapCompleted };
