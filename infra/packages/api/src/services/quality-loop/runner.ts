import type { Env } from "../../env";
import { recordUsageEvent } from "../usage";
import { recordPlatformHeartbeat } from "../platform-ops-heartbeats";
import type { QualityAuditInput } from "../quality-auditor";
import {
  cadenceDescription,
  previousCompleteLondonDay,
  resolvePhase,
  shouldRunCadence,
} from "./cadence";
import { qualityConfirmationEmail, qualityReviewEmail, qualityRollbackEmail, listQualityLoopRecipients, sendQualityLoopEmail } from "./email";
import { assertTenantIsolation, evaluateWhatsAppConversation, threadFromAudit } from "./evaluator";
import { groupQualityPatterns } from "./patterns";
import { proposeImprovements } from "./proposals";
import { replayProposal } from "./replay";
import { applyApprovedProposal, canaryShouldRollback, promoteOrRollbackCanary } from "./apply";
import {
  completeQualityRun,
  createReviewToken,
  ensureQualityLoopConfig,
  getActiveRuntimeRow,
  insertConversationScores,
  insertPatterns,
  insertProposals,
  insertQualityRun,
  listBlockedProposalFingerprints,
  listProposalsForRun,
  updateQualityLoopConfig,
  updateProposalStatus,
  insertHistory,
} from "./store";
import type { ConversationThread, QualityLoopKind, QualityLoopMetrics, QualityProposalDraft } from "./types";

export async function maybeRunQualityLoop(
  env: Env,
  now = new Date(),
  options?: { force?: QualityLoopKind | "cadence" },
): Promise<{ ran: boolean; runId?: string; kind?: string; reason: string }> {
  const config = await ensureQualityLoopConfig(env.DB, now.toISOString());
  const phase = resolvePhase(config.activatedAt, now);
  if (phase !== config.phase) {
    await updateQualityLoopConfig(env.DB, { phase });
  }

  await maybeCloseCanary(env);

  if (!config.baselineCompletedAt || options?.force === "baseline") {
    return runQualityLoop(env, {
      kind: "baseline",
      phase,
      period: { from: "1970-01-01T00:00:00.000Z", to: now.toISOString() },
      now,
    });
  }

  if (options?.force && options.force !== "cadence" && options.force !== "baseline") {
    const period = options.force === "weekly" ? { from: new Date(now.getTime() - 7 * 86400000).toISOString(), to: now.toISOString() } : previousCompleteLondonDay(now);
    return runQualityLoop(env, { kind: options.force, phase, period, now });
  }

  const decision = shouldRunCadence({ ...config, phase }, now);
  if (!decision.run) {
    return { ran: false, reason: `Cadence window closed (${decision.phase})` };
  }
  return runQualityLoop(env, { kind: decision.kind, phase: decision.phase, period: decision.period, now });
}

export async function runQualityLoop(
  env: Env,
  input: { kind: QualityLoopKind; phase: "daily" | "weekly"; period: { from: string; to: string }; now: Date },
): Promise<{ ran: boolean; runId?: string; kind?: string; reason: string }> {
  const started = Date.now();
  const run = await insertQualityRun(env.DB, {
    kind: input.kind,
    phase: input.phase,
    periodFrom: input.period.from,
    periodTo: input.period.to,
  });

  try {
    const threads = await loadWhatsAppThreads(env.DB, input.period.from, input.period.to);
    const evaluations = [];
    for (const thread of threads) {
      const evaluation = evaluateWhatsAppConversation(thread);
      if (evaluation.evidence) {
        evaluation.evidence.companyId = thread.companyId;
      }
      evaluations.push(evaluation);
    }
    const isolation = assertTenantIsolation(evaluations);
    if (!isolation.ok) {
      throw new Error(`Tenant isolation failed: ${isolation.violations.join("; ")}`);
    }

    await insertConversationScores(env.DB, run.id, evaluations);
    const patterns = groupQualityPatterns(evaluations);
    await insertPatterns(env.DB, run.id, patterns);

    const blocked = await listBlockedProposalFingerprints(env.DB);
    const blockedSet = new Set<string>();
    for (const draft of proposeImprovements(patterns)) {
      const prior = blocked.get(draft.fingerprint);
      const occurrence = Number((draft.evidence as { occurrenceCount?: number }).occurrenceCount ?? 1);
      if (prior != null && occurrence <= prior) blockedSet.add(draft.fingerprint);
    }
    const drafts = proposeImprovements(patterns, blockedSet);
    const pretestByFingerprint: Record<string, unknown> = {};
    for (const draft of drafts) {
      const failedThreads = threads.filter((thread) =>
        evaluations.some((row) => row.conversationKey === thread.conversationKey && row.failed && row.companyId === thread.companyId),
      );
      pretestByFingerprint[draft.fingerprint] = replayProposal({
        proposal: draft,
        failedThreads: failedThreads.filter((thread) => !draft.companyId || thread.companyId === draft.companyId),
        similarThreads: threads.filter((thread) => thread.companyId === draft.companyId).slice(0, 8),
      });
    }
    await insertProposals(env.DB, run.id, drafts, pretestByFingerprint);

    const failed = evaluations.filter((row) => row.failed);
    const rephrase = evaluations.filter((row) => row.flags.some((flag) => flag.category === "rephrase"));
    const ackSamples = threads.map((row) => row.acknowledgementMs).filter((value): value is number => value != null);
    const finalSamples = threads.map((row) => row.totalMs).filter((value): value is number => value != null);
    const proposals = drafts.map((draft) => ({
      ...draft,
      pretest: pretestByFingerprint[draft.fingerprint] as { accepted?: boolean },
    }));
    const pending = proposals.filter((draft) => (draft.engineeringRequired || draft.pretest?.accepted) && !blockedSet.has(draft.fingerprint));

    const metrics: QualityLoopMetrics = {
      messagesAnalysed: threads.reduce((sum, row) => sum + row.userMessages.length + row.assistantMessages.length, 0),
      conversationsAnalysed: evaluations.length,
      qualityAverage: evaluations.length
        ? evaluations.reduce((sum, row) => sum + row.overallQualityScore, 0) / evaluations.length
        : 100,
      failedRate: evaluations.length ? failed.length / evaluations.length : 0,
      rephraseRate: evaluations.length ? rephrase.length / evaluations.length : 0,
      ackLatencyMs: average(ackSamples),
      finalLatencyMs: average(finalSamples),
      openProposals: pending.length,
      approvedProposals: 0,
      deployedProposals: 0,
      rolledBackProposals: 0,
      evaluatorCostCents: 0,
    };

    await meterQualityLoop(env, metrics, run.id, threads[0]?.companyId ?? "co_caddington");

    await createReviewToken(env.DB, run.id);
    const origin = (env.PORTAL_PUBLIC_ORIGIN || "https://app.infrastack.app").replace(/\/$/, "");
    const reviewUrl = `${origin}/quality/improvements?run=${encodeURIComponent(run.id)}`;
    const date = input.now.toISOString().slice(0, 10);
    const email = qualityReviewEmail({
      date,
      kind: input.kind,
      cadence: cadenceDescription(input.phase),
      periodFrom: input.period.from,
      periodTo: input.period.to,
      metrics,
      failures: failed.slice(0, 8).map((row) => ({
        companyLabel: row.companyId === "co_caddington" ? "Caddington" : "Company",
        category: row.flags.find((flag) => flag.polarity === "negative")?.category ?? "quality",
        snippet: row.flags.find((flag) => flag.polarity === "negative")?.evidence ?? "See interaction detail",
        interactionId: row.interactionId,
      })),
      patterns: patterns.filter((pattern) => !pattern.platformAggregate).map((pattern) => ({
        title: pattern.title,
        count: pattern.occurrenceCount,
        rootCause: pattern.rootCause,
      })),
      proposals: drafts.map((draft) => ({
        title: draft.title,
        risk: draft.risk,
        autoApplyable: Boolean((pretestByFingerprint[draft.fingerprint] as { accepted?: boolean })?.accepted) && draft.autoApplyable,
        engineeringRequired: draft.engineeringRequired,
      })),
      reviewUrl,
    });
    const recipients = await listQualityLoopRecipients(env.DB, env);
    const delivered = await sendQualityLoopEmail(env, env.DB, {
      ...email,
      recipients,
      eventType: input.kind === "weekly" ? "quality_loop.weekly_review" : "quality_loop.daily_review",
      resourceId: run.id,
    });

    await completeQualityRun(env.DB, run.id, {
      status: "completed",
      metrics,
      emailSent: delivered.sent,
      emailError: delivered.error,
    });
    await updateQualityLoopConfig(env.DB, {
      phase: input.phase,
      lastRunAt: input.now.toISOString(),
      lastPeriodFrom: input.period.from,
      lastPeriodTo: input.period.to,
      lastCadence: input.kind,
      baselineCompletedAt: input.kind === "baseline" ? input.now.toISOString() : undefined,
    });
    await recordPlatformHeartbeat(env.DB, {
      key: "quality_loop",
      label: "Quality loop",
      success: true,
      detail: { runId: run.id, kind: input.kind, conversations: evaluations.length, durationMs: Date.now() - started },
    });
    return { ran: true, runId: run.id, kind: input.kind, reason: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Quality loop failed";
    await completeQualityRun(env.DB, run.id, {
      status: "failed",
      metrics: emptyMetrics(),
      emailSent: false,
      emailError: message,
    });
    await recordPlatformHeartbeat(env.DB, {
      key: "quality_loop",
      label: "Quality loop",
      success: false,
      error: message,
    });
    return { ran: true, runId: run.id, kind: input.kind, reason: message };
  }
}

export async function decideProposal(
  env: Env,
  input: { proposalId: string; decision: "approve" | "reject" | "defer"; actor: string; runId?: string },
) {
  const status = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "deferred";
  await updateProposalStatus(env.DB, input.proposalId, status);
  await insertHistory(env.DB, {
    proposalId: input.proposalId,
    runId: input.runId ?? null,
    action: status,
    actor: input.actor,
  });
  if (input.decision !== "approve") {
    return { status, apply: null };
  }
  const apply = await applyApprovedProposal(env, {
    proposalId: input.proposalId,
    actor: input.actor,
    runId: input.runId,
  });
  return { status: apply.status, apply };
}

export async function approveRecommended(env: Env, input: { runId: string; actor: string }) {
  const proposals = await listProposalsForRun(env.DB, input.runId);
  const recommended = proposals.filter(
    (row) => row.status === "pending_approval" && row.autoApplyable && row.risk !== "high" && !row.engineeringRequired,
  );
  const results = [];
  for (const proposal of recommended) {
    results.push(await decideProposal(env, { proposalId: proposal.id, decision: "approve", actor: input.actor, runId: input.runId }));
  }
  if (results.length > 0) {
    const recipients = await listQualityLoopRecipients(env.DB, env);
    const email = qualityConfirmationEmail({
      date: new Date().toISOString().slice(0, 10),
      titles: recommended.map((row) => row.title),
      applied: results.some((row) => row.status === "canary" || row.status === "promoted"),
    });
    await sendQualityLoopEmail(env, env.DB, {
      ...email,
      recipients,
      eventType: "quality_loop.approval_confirmed",
      resourceId: input.runId,
    });
  }
  return results;
}

async function maybeCloseCanary(env: Env) {
  const runtime = await getActiveRuntimeRow(env.DB);
  if (!runtime.canary) return;
  const scores = await env.DB.prepare(
    `SELECT COUNT(*) AS n, AVG(overall_score) AS quality, AVG(failed) AS failed_rate
     FROM quality_conversation_scores
     WHERE created_at >= datetime('now', '-2 days')`,
  )
    .first<{ n: number; quality: number; failed_rate: number }>()
    .catch(() => null);
  if (!runtime.canary.proposalId) return;
  if (!scores || Number(scores.n ?? 0) < 3) return;
  const decision = canaryShouldRollback({
    baselineQuality: 80,
    canaryQuality: Number(scores.quality ?? 80),
    baselineErrorRate: 0.15,
    canaryErrorRate: Number(scores.failed_rate ?? 0),
    baselineLatencyMs: 20_000,
    canaryLatencyMs: 20_000,
    permissionSafetyWorsened: false,
  });
  if (!decision.rollback && Number(scores.n) < 8) return;
  const result = await promoteOrRollbackCanary(env, {
    version: runtime.canary.version,
    proposalId: runtime.canary.proposalId,
    decision,
  });
  if (result.status === "rolled_back") {
    const recipients = await listQualityLoopRecipients(env.DB, env);
    const email = qualityRollbackEmail({
      date: new Date().toISOString().slice(0, 10),
      reason: result.reason,
      version: runtime.canary.version,
    });
    await sendQualityLoopEmail(env, env.DB, {
      ...email,
      recipients,
      eventType: "quality_loop.rollback",
      resourceId: runtime.canary.proposalId,
    });
  }
}

export async function loadWhatsAppThreads(
  db: D1Database,
  from: string,
  to: string,
): Promise<ConversationThread[]> {
  const interactions = await db
    .prepare(
      `SELECT id, company_id, actor_id, label, created_at
       FROM interactions
       WHERE client_kind = 'whatsapp' AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC LIMIT 400`,
    )
    .bind(from, to)
    .all<{ id: string; company_id: string; actor_id: string; label: string; created_at: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; company_id: string; actor_id: string; label: string; created_at: string }> }));

  const threads: ConversationThread[] = [];
  for (const interaction of interactions.results ?? []) {
    const usage = await db
      .prepare(
        `SELECT tool_name, action, success, duration_ms, customer_charge_cents, underlying_cost_cents,
                actor_email, recorded_at, metadata_json
         FROM usage_records WHERE interaction_id = ? ORDER BY recorded_at ASC`,
      )
      .bind(interaction.id)
      .all<{
        tool_name: string | null;
        action: string | null;
        success: number;
        duration_ms: number | null;
        customer_charge_cents: number | null;
        underlying_cost_cents: number | null;
        actor_email: string | null;
        recorded_at: string;
        metadata_json: string | null;
      }>()
      .catch(() => ({ results: [] }));

    const audit: QualityAuditInput = {
      interactionId: interaction.id,
      companyId: interaction.company_id,
      userId: interaction.actor_id,
      channel: "whatsapp",
      usage: (usage.results ?? []).map((row) => ({
        toolName: row.tool_name,
        action: row.action,
        success: row.success,
        durationMs: row.duration_ms,
        customerChargeCents: row.customer_charge_cents,
        underlyingCostCents: row.underlying_cost_cents,
        actorEmail: row.actor_email,
        recordedAt: row.recorded_at,
        metadata: parseMeta(row.metadata_json),
      })),
    };
    const meta = mergeWhatsAppMeta(audit.usage.map((row) => row.metadata ?? {}));
    const issues = await db
      .prepare(`SELECT category FROM quality_issues WHERE last_interaction_id = ?`)
      .bind(interaction.id)
      .all<{ category: string }>()
      .catch(() => ({ results: [] as Array<{ category: string }> }));
    audit.usage.forEach((row) => {
      row.metadata = { ...meta, ...(row.metadata ?? {}) };
    });
    threads.push(
      threadFromAudit({
        companyId: interaction.company_id,
        conversationKey: interaction.id,
        interactionId: interaction.id,
        userId: interaction.actor_id,
        userMessages: typeof meta.userText === "string" ? [meta.userText] : interaction.label ? [interaction.label] : [],
        assistantMessages: typeof meta.reply === "string"
          ? [meta.reply]
          : typeof meta.publicReply === "string"
            ? [meta.publicReply]
            : [],
        sourceUrls: typeof meta.sourceUrl === "string" ? [meta.sourceUrl] : [],
        audit: {
          ...audit,
          usage: audit.usage.map((row) => ({
            ...row,
            metadata: {
              ...meta,
              qualitySignals: (issues.results ?? []).map((item) => item.category),
              ...(row.metadata ?? {}),
            },
          })),
        },
      }),
    );
    const last = threads[threads.length - 1]!;
    last.qualitySignals = [...new Set([...last.qualitySignals, ...(issues.results ?? []).map((item) => item.category)])];
    if (meta.finalSent === true || meta.success === true) last.finalSent = true;
  }
  return threads;
}

export function buildThreadFromFixture(partial: Partial<ConversationThread> & { companyId: string; conversationKey: string }): ConversationThread {
  return {
    channel: "whatsapp",
    userMessages: [],
    assistantMessages: [],
    acks: 0,
    progressUpdates: 0,
    buttonSelections: [],
    toolNames: [],
    connectorErrors: [],
    sourceUrls: [],
    askedForSource: false,
    followUp: false,
    contextLost: false,
    rawLeak: false,
    permissionDenied: false,
    permissionDenialCorrect: false,
    acknowledgementMs: 400,
    firstVisibleMs: 400,
    totalMs: 1200,
    finalSent: true,
    acknowledgementSent: true,
    usageCostCents: 0,
    qualitySignals: [],
    ...partial,
  };
}

async function meterQualityLoop(env: Env, metrics: QualityLoopMetrics, runId: string, companyId: string) {
  try {
    await recordUsageEvent(env.DB, {
      companyId,
      resourceType: "platform_quality_loop",
      resourceId: runId,
      toolName: "quality_evaluator",
      action: "evaluate_whatsapp",
      success: true,
      customerChargeCents: 0,
      underlyingCostCents: metrics.evaluatorCostCents,
      sourceClient: "quality_loop",
      metadata: {
        platformOverhead: true,
        allocatedToCustomer: false,
        category: "ai_quality_operations",
        conversations: metrics.conversationsAnalysed,
      },
    });
  } catch {
    // Metering must never fail the loop.
  }
}

function emptyMetrics(): QualityLoopMetrics {
  return {
    messagesAnalysed: 0,
    conversationsAnalysed: 0,
    qualityAverage: 0,
    failedRate: 0,
    rephraseRate: 0,
    ackLatencyMs: null,
    finalLatencyMs: null,
    openProposals: 0,
    approvedProposals: 0,
    deployedProposals: 0,
    rolledBackProposals: 0,
    evaluatorCostCents: 0,
  };
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeWhatsAppMeta(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.channel && row.channel !== "whatsapp") continue;
    Object.assign(merged, row);
  }
  const whatsapp = rows.find((row) => row.channel === "whatsapp");
  return { ...merged, ...(whatsapp ?? {}) };
}

export type { QualityProposalDraft };
