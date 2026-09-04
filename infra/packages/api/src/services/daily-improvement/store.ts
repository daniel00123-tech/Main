import { newId, nowIso } from "../../db/mappers";
import { DAILY_IMPROVEMENT_CONFIG_ID } from "./constants";
import { asStringList, parseJsonArray, parseJsonObject, safeJson } from "./redact";
import type {
  DailyImprovementCluster,
  DailyImprovementEvaluation,
  DailyImprovementInteraction,
  DailyImprovementIssue,
  DailyImprovementRunKind,
  DimensionScores,
  EngineeringJobSpec,
} from "./types";
import type { DailyImprovementSeverity, FailureCategory, QualityScoreDimension } from "./constants";
import { QUALITY_SCORE_DIMENSIONS } from "./constants";

export async function ensureDailyImprovementConfig(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO daily_improvement_config (
         id, timezone, qa_hour, qa_minute, report_hour, report_minute,
         engineering_hour, engineering_minute, updated_at
       ) VALUES (?, 'Europe/London', 16, 30, 17, 0, 17, 5, ?)`,
    )
    .bind(DAILY_IMPROVEMENT_CONFIG_ID, nowIso())
    .run()
    .catch(() => undefined);
}

export async function getDailyImprovementConfig(db: D1Database) {
  await ensureDailyImprovementConfig(db);
  return db
    .prepare(`SELECT * FROM daily_improvement_config WHERE id = ?`)
    .bind(DAILY_IMPROVEMENT_CONFIG_ID)
    .first<Record<string, unknown>>();
}

export async function markBootstrapCompleted(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE daily_improvement_config SET bootstrap_completed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), nowIso(), DAILY_IMPROVEMENT_CONFIG_ID)
    .run();
}

export async function beginRun(
  db: D1Database,
  input: { runDate: string; kind: DailyImprovementRunKind; windowFrom?: string; windowTo?: string },
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .prepare(`SELECT id, status, started_at FROM daily_improvement_runs WHERE run_date = ? AND kind = ?`)
    .bind(input.runDate, input.kind)
    .first<{ id: string; status: string; started_at: string }>();
  if (existing) {
    const stale =
      existing.status === "failed" ||
      (existing.status === "running" &&
        Date.now() - new Date(existing.started_at).getTime() > 2 * 60 * 1000);
    if (!stale) return { id: existing.id, created: false };
    await db
      .prepare(`UPDATE daily_improvement_runs SET status = 'running', started_at = ?, completed_at = NULL WHERE id = ?`)
      .bind(nowIso(), existing.id)
      .run();
    return { id: existing.id, created: true };
  }
  const id = newId("dir");
  try {
    await db
      .prepare(
        `INSERT INTO daily_improvement_runs
          (id, run_date, kind, window_from, window_to, status, summary_json, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)`,
      )
      .bind(id, input.runDate, input.kind, input.windowFrom ?? null, input.windowTo ?? null, nowIso())
      .run();
    return { id, created: true };
  } catch {
    const raced = await db
      .prepare(`SELECT id FROM daily_improvement_runs WHERE run_date = ? AND kind = ?`)
      .bind(input.runDate, input.kind)
      .first<{ id: string }>();
    return { id: raced?.id ?? id, created: false };
  }
}

export async function completeRun(
  db: D1Database,
  runId: string,
  input: { status?: string; summary?: Record<string, unknown>; emailSentAt?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_improvement_runs
       SET status = ?, summary_json = ?, email_sent_at = COALESCE(?, email_sent_at), completed_at = ?
       WHERE id = ?`,
    )
    .bind(input.status ?? "completed", JSON.stringify(input.summary ?? {}), input.emailSentAt ?? null, nowIso(), runId)
    .run();
}

export async function getRun(
  db: D1Database,
  runDate: string,
  kind: DailyImprovementRunKind,
): Promise<{
  id: string;
  status: string;
  summary: Record<string, unknown>;
  windowFrom?: string | null;
  windowTo?: string | null;
} | null> {
  const row = await db
    .prepare(`SELECT id, status, summary_json, window_from, window_to FROM daily_improvement_runs WHERE run_date = ? AND kind = ?`)
    .bind(runDate, kind)
    .first<{ id: string; status: string; summary_json: string; window_from: string | null; window_to: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    summary: parseJsonObject(row.summary_json),
    windowFrom: row.window_from,
    windowTo: row.window_to,
  };
}

export async function upsertInteraction(db: D1Database, row: DailyImprovementInteraction): Promise<void> {
  const existing = await db
    .prepare(`SELECT tools_executed_json, tools_requested_json FROM daily_improvement_interactions WHERE interaction_id = ?`)
    .bind(row.interactionId)
    .first<{ tools_executed_json: string; tools_requested_json: string }>();
  const executed = unique([
    ...asStringList(parseJsonArray(existing?.tools_executed_json)),
    ...row.toolsExecuted,
  ]);
  const requested = unique([
    ...asStringList(parseJsonArray(existing?.tools_requested_json)),
    ...row.toolsRequested,
  ]);
  if (existing) {
    await db
      .prepare(
        `UPDATE daily_improvement_interactions SET
           user_message = COALESCE(?, user_message),
           assistant_answer = COALESCE(?, assistant_answer),
           terminal_state = COALESCE(?, terminal_state),
           provider = COALESCE(?, provider),
           model = COALESCE(?, model),
           provider_mode = COALESCE(?, provider_mode),
           tools_requested_json = ?,
           tools_executed_json = ?,
           evidence_refs_json = ?,
           latency_ms = COALESCE(?, latency_ms),
           customer_charge_cents = CASE WHEN ? > customer_charge_cents THEN ? ELSE customer_charge_cents END,
           provider_cost_cents = COALESCE(?, provider_cost_cents),
           quality_result = COALESCE(?, quality_result),
           correlation_id = COALESCE(?, correlation_id),
           conversation_id = COALESCE(?, conversation_id),
           role = COALESCE(?, role),
           traffic_class = COALESCE(?, traffic_class)
         WHERE interaction_id = ?`,
      )
      .bind(
        row.userMessage,
        row.assistantAnswer,
        row.terminalState,
        row.provider,
        row.model,
        row.providerMode,
        JSON.stringify(requested),
        JSON.stringify(executed),
        safeJson(row.evidenceRefs),
        row.latencyMs,
        row.customerChargeCents,
        row.customerChargeCents,
        row.providerCostCents,
        row.qualityResult,
        row.correlationId,
        row.conversationId,
        row.role,
        row.trafficClass,
        row.interactionId,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO daily_improvement_interactions (
         id, interaction_id, customer_request_id, company_id, user_id, role, channel,
         conversation_id, created_at, user_message, provider, model, provider_mode,
         available_capabilities_json, tools_requested_json, tools_executed_json,
         evidence_refs_json, assistant_answer, terminal_state, latency_ms,
         customer_charge_cents, provider_cost_cents, quality_result, correlation_id,
         traffic_class, source_client
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.interactionId,
      row.customerRequestId,
      row.companyId,
      row.userId,
      row.role,
      row.channel,
      row.conversationId,
      row.createdAt,
      row.userMessage,
      row.provider,
      row.model,
      row.providerMode,
      JSON.stringify(row.availableCapabilities),
      JSON.stringify(requested),
      JSON.stringify(executed),
      safeJson(row.evidenceRefs),
      row.assistantAnswer,
      row.terminalState,
      row.latencyMs,
      row.customerChargeCents,
      row.providerCostCents,
      row.qualityResult,
      row.correlationId,
      row.trafficClass,
      row.sourceClient,
    )
    .run();
}

export async function listInteractionsSince(
  db: D1Database,
  fromIso: string,
  toIso: string,
  options?: { customerOnly?: boolean },
): Promise<DailyImprovementInteraction[]> {
  const sql = options?.customerOnly
    ? `SELECT * FROM daily_improvement_interactions
       WHERE created_at >= ? AND created_at < ? AND traffic_class = 'CUSTOMER_REQUEST'
       ORDER BY created_at ASC`
    : `SELECT * FROM daily_improvement_interactions
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`;
  const rows = await db.prepare(sql).bind(fromIso, toIso).all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapInteraction);
}

export async function listSequence(
  db: D1Database,
  companyId: string,
  conversationId: string | null,
  before: string,
  limit = 8,
): Promise<DailyImprovementInteraction[]> {
  if (!conversationId) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM daily_improvement_interactions
       WHERE company_id = ? AND conversation_id = ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(companyId, conversationId, before, limit)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapInteraction).reverse();
}

export async function insertEvaluation(db: D1Database, evaluation: DailyImprovementEvaluation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_improvement_evaluations (
         id, interaction_id, conversation_id, run_id, company_id, channel, overall_score,
         intent, tool_selection, exact_tool, rbac, grounding, first_answer, completeness,
         memory, follow_up, naturalness, efficiency, hallucination, reliability, user_effort,
         failure_categories_json, severity, notes, evaluator_model, evaluator_kind,
         traffic_class, customer_charge_cents, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUALITY', 0, ?)`,
    )
    .bind(
      evaluation.id,
      evaluation.interactionId,
      evaluation.conversationId,
      evaluation.runId,
      evaluation.companyId,
      evaluation.channel,
      evaluation.overallScore,
      evaluation.scores.INTENT,
      evaluation.scores.TOOL_SELECTION,
      evaluation.scores.EXACT_TOOL,
      evaluation.scores.RBAC,
      evaluation.scores.GROUNDING,
      evaluation.scores.FIRST_ANSWER,
      evaluation.scores.COMPLETENESS,
      evaluation.scores.MEMORY,
      evaluation.scores.FOLLOW_UP,
      evaluation.scores.NATURALNESS,
      evaluation.scores.EFFICIENCY,
      evaluation.scores.HALLUCINATION,
      evaluation.scores.RELIABILITY,
      evaluation.scores.USER_EFFORT,
      JSON.stringify(evaluation.failureCategories),
      evaluation.severity,
      persistNotes(evaluation),
      evaluation.evaluatorModel,
      evaluation.evaluatorKind,
      evaluation.createdAt,
    )
    .run();
}

export async function listEvaluationsForRun(db: D1Database, runId: string): Promise<DailyImprovementEvaluation[]> {
  const rows = await db
    .prepare(`SELECT * FROM daily_improvement_evaluations WHERE run_id = ?`)
    .bind(runId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapEvaluation);
}

export async function replaceClusters(
  db: D1Database,
  runId: string,
  clusters: DailyImprovementCluster[],
): Promise<void> {
  await db.prepare(`DELETE FROM daily_improvement_clusters WHERE run_id = ?`).bind(runId).run().catch(() => undefined);
  for (const cluster of clusters) {
    await db
      .prepare(
        `INSERT INTO daily_improvement_clusters (
           id, run_id, cluster_key, category, title, severity, interaction_count, tenant_count,
           company_ids_json, current_behaviour, expected_behaviour, root_cause, proposed_fix,
           risk, tests_required, expected_benefit, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        cluster.id,
        runId,
        cluster.clusterKey,
        cluster.category,
        cluster.title,
        cluster.severity,
        cluster.interactionCount,
        cluster.tenantCount,
        JSON.stringify({
          companyIds: cluster.companyIds,
          channels: cluster.channels ?? [],
          exampleIds: cluster.exampleIds ?? [],
          lifecycle: cluster.lifecycle ?? "NEW",
        }),
        cluster.currentBehaviour,
        cluster.expectedBehaviour,
        cluster.rootCause,
        cluster.proposedFix,
        cluster.risk,
        cluster.testsRequired,
        cluster.expectedBenefit,
        cluster.status,
        nowIso(),
        nowIso(),
      )
      .run();
  }
}

export async function replaceIssues(db: D1Database, issues: DailyImprovementIssue[]): Promise<void> {
  const runId = issues[0]?.runId;
  if (runId) {
    await db.prepare(`DELETE FROM daily_improvement_issues WHERE run_id = ?`).bind(runId).run().catch(() => undefined);
  }
  for (const issue of issues) {
    await db
      .prepare(
        `INSERT INTO daily_improvement_issues (
           id, cluster_id, run_id, title, category, severity, status, priority_score,
           affected_interactions, affected_tenants, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        issue.id,
        issue.clusterId,
        issue.runId,
        issue.title,
        issue.category,
        issue.severity,
        issue.status,
        issue.priorityScore,
        issue.affectedInteractions,
        issue.affectedTenants,
        nowIso(),
        nowIso(),
      )
      .run();
  }
}

export async function listClustersForRun(db: D1Database, runId: string): Promise<DailyImprovementCluster[]> {
  const rows = await db
    .prepare(`SELECT * FROM daily_improvement_clusters WHERE run_id = ? ORDER BY severity, interaction_count DESC`)
    .bind(runId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapCluster);
}

export async function enqueueEngineeringJobs(
  db: D1Database,
  runId: string,
  jobs: Array<{ issue: DailyImprovementIssue; cluster: DailyImprovementCluster; spec: EngineeringJobSpec }>,
): Promise<number> {
  let inserted = 0;
  for (const job of jobs) {
    const existing = await db
      .prepare(
        `SELECT id, severity FROM daily_improvement_engineering_jobs
         WHERE cluster_key = ? AND status IN ('QUEUED','CLAIMED','REPRODUCING','FIXING','TESTING','READY_TO_DEPLOY')
         LIMIT 1`,
      )
      .bind(job.cluster.clusterKey)
      .first<{ id: string; severity: string }>();
    if (existing) {
      await db
        .prepare(
          `UPDATE daily_improvement_engineering_jobs
           SET title = ?, severity = ?, job_spec_json = ?, updated_at = ?, issue_id = COALESCE(issue_id, ?)
           WHERE id = ?`,
        )
        .bind(
          job.cluster.title,
          worseSeverity(existing.severity, job.cluster.severity),
          JSON.stringify({
            ...job.spec,
            affectedCount: job.cluster.interactionCount,
            lastSeen: nowIso(),
            qualityClusterId: job.cluster.id,
          }),
          nowIso(),
          job.issue.id,
          existing.id,
        )
        .run();
      continue;
    }
    await db
      .prepare(
        `INSERT INTO daily_improvement_engineering_jobs (
           id, run_id, issue_id, cluster_key, title, severity, status, job_spec_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
      )
      .bind(
        newId("dij"),
        runId,
        job.issue.id,
        job.cluster.clusterKey,
        job.cluster.title,
        job.cluster.severity,
        JSON.stringify(job.spec),
        nowIso(),
        nowIso(),
      )
      .run();
    inserted += 1;
  }
  return inserted;
}

export async function claimNextEngineeringJob(db: D1Database, claimedBy: string) {
  const row = await db
    .prepare(
      `SELECT * FROM daily_improvement_engineering_jobs
       WHERE status = 'QUEUED'
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at
       LIMIT 1`,
    )
    .first<Record<string, unknown>>();
  if (!row) return null;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE daily_improvement_engineering_jobs
       SET status = 'CLAIMED', claimed_by = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'QUEUED'`,
    )
    .bind(claimedBy, now, now, String(row.id))
    .run();
  return { ...row, status: "CLAIMED", claimed_by: claimedBy, claimed_at: now };
}

export async function completeEngineeringJob(
  db: D1Database,
  jobId: string,
  input: { status: string; result: Record<string, unknown> },
): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_improvement_engineering_jobs
       SET status = ?, result_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(input.status, JSON.stringify(input.result), nowIso(), jobId)
    .run();
}

export async function listEngineeringJobs(db: D1Database, limit = 50) {
  const rows = await db
    .prepare(
      `SELECT * FROM daily_improvement_engineering_jobs ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function insertDeployment(
  db: D1Database,
  input: {
    runId?: string | null;
    jobId?: string | null;
    branch?: string | null;
    sha?: string | null;
    previousSha?: string | null;
    verificationStatus: string;
    qualityBefore?: number | null;
    qualityAfter?: number | null;
    rollbackReason?: string | null;
  },
): Promise<string> {
  const id = newId("did");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO daily_improvement_deployments (
         id, run_id, job_id, branch, sha, previous_sha, deployed_at, verification_status,
         rollback_reason, quality_before, quality_after, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.runId ?? null,
      input.jobId ?? null,
      input.branch ?? null,
      input.sha ?? null,
      input.previousSha ?? null,
      now,
      input.verificationStatus,
      input.rollbackReason ?? null,
      input.qualityBefore ?? null,
      input.qualityAfter ?? null,
      now,
    )
    .run();
  return id;
}

export async function listYesterdayDeployments(db: D1Database, beforeDate: string) {
  const rows = await db
    .prepare(
      `SELECT d.*, j.title, j.severity, j.cluster_key
       FROM daily_improvement_deployments d
       LEFT JOIN daily_improvement_engineering_jobs j ON j.id = d.job_id
       WHERE d.created_at < ? AND d.created_at >= ?
       ORDER BY d.created_at DESC`,
    )
    .bind(`${beforeDate}T23:59:59.999Z`, `${previousIsoDate(beforeDate)}T00:00:00.000Z`)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function insertHistory(
  db: D1Database,
  input: {
    eventType: string;
    interactionId?: string | null;
    clusterId?: string | null;
    issueId?: string | null;
    jobId?: string | null;
    deploymentId?: string | null;
    companyId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_improvement_history (
         id, created_at, event_type, interaction_id, cluster_id, issue_id, job_id, deployment_id, company_id, detail_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("dih"),
      nowIso(),
      input.eventType,
      input.interactionId ?? null,
      input.clusterId ?? null,
      input.issueId ?? null,
      input.jobId ?? null,
      input.deploymentId ?? null,
      input.companyId ?? null,
      JSON.stringify(input.detail ?? {}),
    )
    .run();
}

export async function loadDashboard(
  db: D1Database,
  filters: {
    tenant?: string;
    channel?: string;
    provider?: string;
    model?: string;
    severity?: string;
    capability?: string;
  },
) {
  const interactions = await db
    .prepare(
      `SELECT company_id, channel, provider, model, created_at FROM daily_improvement_interactions
       WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500`,
    )
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .all<Record<string, unknown>>();
  const evaluations = await db
    .prepare(
      `SELECT company_id, channel, overall_score, tool_selection, exact_tool, severity, failure_categories_json
       FROM daily_improvement_evaluations WHERE created_at >= ? LIMIT 500`,
    )
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .all<Record<string, unknown>>();
  const clusters = await db
    .prepare(`SELECT * FROM daily_improvement_clusters ORDER BY created_at DESC LIMIT 50`)
    .all<Record<string, unknown>>();
  const jobs = await listEngineeringJobs(db, 40);
  const deployments = await db
    .prepare(`SELECT * FROM daily_improvement_deployments ORDER BY created_at DESC LIMIT 20`)
    .all<Record<string, unknown>>();

  const filteredInteractions = (interactions.results ?? []).filter((row) => {
    if (filters.tenant && row.company_id !== filters.tenant) return false;
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.provider && row.provider !== filters.provider) return false;
    if (filters.model && row.model !== filters.model) return false;
    return true;
  });
  const filteredEvals = (evaluations.results ?? []).filter((row) => {
    if (filters.tenant && row.company_id !== filters.tenant) return false;
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.severity && row.severity !== filters.severity) return false;
    if (filters.capability) {
      const cats = asStringList(parseJsonArray(String(row.failure_categories_json ?? "[]")));
      if (!cats.includes(filters.capability)) return false;
    }
    return true;
  });
  const scores = filteredEvals.map((row) => Number(row.overall_score ?? 0)).filter((n) => Number.isFinite(n));
  return {
    todayInteractions: filteredInteractions.length,
    qualityScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    clusters: (clusters.results ?? []).map(mapCluster),
    engineeringQueue: jobs,
    deployments: deployments.results ?? [],
    filters,
  };
}

function mapInteraction(row: Record<string, unknown>): DailyImprovementInteraction {
  return {
    id: String(row.id),
    interactionId: String(row.interaction_id),
    customerRequestId: row.customer_request_id ? String(row.customer_request_id) : null,
    companyId: String(row.company_id),
    userId: row.user_id ? String(row.user_id) : null,
    role: row.role ? String(row.role) : null,
    channel: String(row.channel),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    createdAt: String(row.created_at),
    userMessage: row.user_message ? String(row.user_message) : null,
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    providerMode: row.provider_mode ? String(row.provider_mode) : null,
    availableCapabilities: asStringList(parseJsonArray(String(row.available_capabilities_json ?? "[]"))),
    toolsRequested: asStringList(parseJsonArray(String(row.tools_requested_json ?? "[]"))),
    toolsExecuted: asStringList(parseJsonArray(String(row.tools_executed_json ?? "[]"))),
    evidenceRefs: parseJsonArray(String(row.evidence_refs_json ?? "[]")) as Array<Record<string, unknown>>,
    assistantAnswer: row.assistant_answer ? String(row.assistant_answer) : null,
    terminalState: row.terminal_state ? String(row.terminal_state) : null,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    customerChargeCents: Number(row.customer_charge_cents ?? 0),
    providerCostCents: row.provider_cost_cents != null ? Number(row.provider_cost_cents) : null,
    qualityResult: row.quality_result ? String(row.quality_result) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    trafficClass: String(row.traffic_class ?? "CUSTOMER_REQUEST"),
    sourceClient: row.source_client ? String(row.source_client) : null,
  };
}

function mapEvaluation(row: Record<string, unknown>): DailyImprovementEvaluation {
  const scores = {} as DimensionScores;
  const keys: Array<[QualityScoreDimension, string]> = QUALITY_SCORE_DIMENSIONS.map((key) => [
    key,
    key.toLowerCase(),
  ]);
  for (const [dim, col] of keys) {
    scores[dim] = Number(row[col] ?? 100);
  }
  return {
    id: String(row.id),
    interactionId: String(row.interaction_id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    companyId: String(row.company_id),
    channel: row.channel ? String(row.channel) : null,
    overallScore: Number(row.overall_score ?? 0),
    scores,
    failureCategories: asStringList(parseJsonArray(String(row.failure_categories_json ?? "[]"))) as FailureCategory[],
    severity: (row.severity ? String(row.severity) : null) as DailyImprovementSeverity | null,
    notes: notesFromStored(row.notes),
    evaluatorModel: row.evaluator_model ? String(row.evaluator_model) : null,
    evaluatorKind: (row.evaluator_kind as DailyImprovementEvaluation["evaluatorKind"]) ?? "heuristic",
    trafficClass: "QUALITY",
    customerChargeCents: 0,
    createdAt: String(row.created_at),
    findings: findingsFromStored(row.notes),
  };
}

function mapCluster(row: Record<string, unknown>): DailyImprovementCluster {
  const packed = parseJsonObject(String(row.company_ids_json ?? "{}"));
  const companyIds = Array.isArray(packed.companyIds)
    ? asStringList(packed.companyIds)
    : asStringList(parseJsonArray(String(row.company_ids_json ?? "[]")));
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    clusterKey: String(row.cluster_key),
    category: String(row.category),
    title: String(row.title),
    severity: String(row.severity) as DailyImprovementSeverity,
    interactionCount: Number(row.interaction_count ?? 0),
    tenantCount: Number(row.tenant_count ?? 0),
    companyIds,
    channels: asStringList(packed.channels),
    exampleIds: asStringList(packed.exampleIds),
    lifecycle: (typeof packed.lifecycle === "string" ? packed.lifecycle : "NEW") as DailyImprovementCluster["lifecycle"],
    currentBehaviour: row.current_behaviour ? String(row.current_behaviour) : null,
    expectedBehaviour: row.expected_behaviour ? String(row.expected_behaviour) : null,
    rootCause: row.root_cause ? String(row.root_cause) : null,
    proposedFix: row.proposed_fix ? String(row.proposed_fix) : null,
    risk: row.risk ? String(row.risk) : null,
    testsRequired: row.tests_required ? String(row.tests_required) : null,
    expectedBenefit: row.expected_benefit ? String(row.expected_benefit) : null,
    status: String(row.status ?? "OPEN"),
  };
}

function persistNotes(evaluation: DailyImprovementEvaluation): string {
  return JSON.stringify({
    notes: evaluation.notes,
    findings: evaluation.findings ?? [],
    interactionTrafficClass: evaluation.interactionTrafficClass ?? null,
  });
}

function notesFromStored(raw: unknown): string | null {
  const text = raw ? String(raw) : "";
  if (!text) return null;
  if (text.startsWith("{")) {
    const parsed = parseJsonObject(text);
    return typeof parsed.notes === "string" ? parsed.notes : text;
  }
  return text;
}

function findingsFromStored(raw: unknown): DailyImprovementEvaluation["findings"] {
  const text = raw ? String(raw) : "";
  if (!text.startsWith("{")) return [];
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.findings)) return [];
  return parsed.findings.filter((item): item is DailyImprovementEvaluation["findings"][number] => {
    return Boolean(item && typeof item === "object" && "category" in (item as object));
  }) as DailyImprovementEvaluation["findings"];
}

function worseSeverity(current: string, next: string): string {
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;
  return (rank[next] ?? 9) < (rank[current] ?? 9) ? next : current;
}

export async function listRecentReportSummaries(db: D1Database, beforeDate: string, limit = 7) {
  const rows = await db
    .prepare(
      `SELECT run_date, summary_json FROM daily_improvement_runs
       WHERE kind IN ('REPORT','CORRECTED_REPORT') AND run_date < ? AND status = 'completed'
       ORDER BY run_date DESC LIMIT ?`,
    )
    .bind(beforeDate, limit)
    .all<{ run_date: string; summary_json: string }>();
  return (rows.results ?? []).map((row) => ({
    runDate: row.run_date,
    summary: parseJsonObject(row.summary_json),
  }));
}

export async function listOpenEngineeringKeys(db: D1Database): Promise<{
  openKeys: Set<string>;
  deployedTodayKeys: Set<string>;
}> {
  const open = await db
    .prepare(
      `SELECT cluster_key FROM daily_improvement_engineering_jobs
       WHERE status IN ('QUEUED','CLAIMED','REPRODUCING','FIXING','TESTING','READY_TO_DEPLOY','CARRIED')`,
    )
    .all<{ cluster_key: string }>()
    .catch(() => ({ results: [] as Array<{ cluster_key: string }> }));
  const deployed = await db
    .prepare(
      `SELECT cluster_key FROM daily_improvement_engineering_jobs
       WHERE status = 'DEPLOYED' AND updated_at >= date('now')`,
    )
    .all<{ cluster_key: string }>()
    .catch(() => ({ results: [] as Array<{ cluster_key: string }> }));
  return {
    openKeys: new Set((open.results ?? []).map((row) => row.cluster_key).filter(Boolean)),
    deployedTodayKeys: new Set((deployed.results ?? []).map((row) => row.cluster_key).filter(Boolean)),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function previousIsoDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day - 1));
  return utc.toISOString().slice(0, 10);
}
