import type { Env } from "../../env";
import { recordUsageEvent } from "../usage";
import { listQualityLoopRecipients } from "../quality-loop/email";
import { backfillRecentCustomerInteractions } from "./audit";
import { clusterEvaluations, countBySeverity, issuesFromClusters, seedKnownClusters } from "./cluster";
import { startEngineeringCycle } from "./engineering";
import { evaluateInteraction } from "./evaluator";
import { buildDailyReport, sendDailyImprovementReport } from "./report";
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
  listSequence,
  listYesterdayDeployments,
  markBootstrapCompleted,
  replaceClusters,
  replaceIssues,
} from "./store";
import { QUALITY_TRAFFIC_CLASS } from "./constants";
import { londonDateOf, previousCompletedQaWindow } from "./windows";
import type { ConversationTurn } from "./types";

export async function runDailyImprovementQa(
  env: Env,
  now = new Date(),
  options?: { windowFrom?: string; windowTo?: string; runDate?: string },
): Promise<{ ran: boolean; runId: string; reason: string; evaluated: number; clusters: number }> {
  const runDate = options?.runDate ?? londonDateOf(now);
  const window = options?.windowFrom
    ? { from: options.windowFrom, to: options.windowTo ?? now.toISOString() }
    : await resolveQaWindow(env, now);
  const begun = await beginRun(env.DB, { runDate, kind: "QA", windowFrom: window.from, windowTo: window.to });
  if (!begun.created) {
    const existing = await getRun(env.DB, runDate, "QA");
    return { ran: false, runId: begun.id, reason: `QA already ${existing?.status ?? "recorded"}`, evaluated: 0, clusters: 0 };
  }

  const backfilled = await backfillRecentCustomerInteractions(env.DB, window.from, window.to);
  const interactions = await listInteractionsSince(env.DB, window.from, window.to);
  const evaluations = [];
  for (const interaction of interactions) {
    const prior = await listSequence(env.DB, interaction.companyId, interaction.conversationId, interaction.createdAt);
    const sequence: ConversationTurn[] = prior.flatMap((row) => {
      const turns: ConversationTurn[] = [];
      if (row.userMessage) turns.push({ role: "user", text: row.userMessage, toolsExecuted: row.toolsExecuted, createdAt: row.createdAt });
      if (row.assistantAnswer) turns.push({ role: "assistant", text: row.assistantAnswer, toolsExecuted: row.toolsExecuted, createdAt: row.createdAt });
      return turns;
    });
    const evaluation = await evaluateInteraction(env, { interaction, sequence, runId: begun.id });
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

  const clusters = seedKnownClusters(begun.id, clusterEvaluations(evaluations, begun.id));
  await replaceClusters(env.DB, begun.id, clusters);
  const issues = issuesFromClusters(clusters, begun.id);
  await replaceIssues(env.DB, issues);
  const counts = countBySeverity(clusters);
  await completeRun(env.DB, begun.id, {
    status: "completed",
    summary: { evaluated: evaluations.length, backfilled, clusters: clusters.length, counts },
  });
  await insertHistory(env.DB, {
    eventType: "qa.completed",
    detail: { runId: begun.id, evaluated: evaluations.length, backfilled, clusters: clusters.length, counts },
  });
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
  let qa = await getRun(env.DB, runDate, "QA");
  if (!qa || qa.status !== "completed") {
    const qaResult = await runDailyImprovementQa(env, now, { runDate });
    qa = { id: qaResult.runId, status: "completed", summary: {} };
  }
  const window = previousCompletedQaWindow(now);
  const interactions = await listInteractionsSince(env.DB, window.from, window.to);
  const evaluations = await listEvaluationsForRun(env.DB, qa.id);
  const clusters = await listClustersForRun(env.DB, qa.id);
  const yesterdaysFixes = await listYesterdayDeployments(env.DB, runDate);
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const payload = buildDailyReport({
    date: runDate,
    recipients,
    interactions,
    evaluations,
    clusters,
    yesterdaysFixes,
  });
  const sent = await sendDailyImprovementReport(env, payload, begun.id);
  await completeRun(env.DB, begun.id, {
    status: sent.sent ? "completed" : "failed",
    summary: { ...payload.summary, recipients: sent.recipients, emailError: sent.error ?? null },
    emailSentAt: sent.sent ? new Date().toISOString() : null,
  });
  return {
    sent: sent.sent,
    runId: begun.id,
    reason: sent.sent ? "sent" : sent.error ?? "send_failed",
    recipients: sent.recipients,
    subject: payload.subject,
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
  const clusters = qaId ? await listClustersForRun(env.DB, qaId) : [];
  const issues = issuesFromClusters(clusters, begun.id);
  const cycle = await startEngineeringCycle(env, { runId: begun.id, issues, clusters });
  await completeRun(env.DB, begun.id, {
    status: "completed",
    summary: { queued: cycle.queued, runner: cycle.blocker, maxDeploys: cycle.maxDeploys },
  });
  return { started: true, runId: begun.id, queued: cycle.queued, reason: "queued" };
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
