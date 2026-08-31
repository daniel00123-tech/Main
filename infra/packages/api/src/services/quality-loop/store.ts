import { newId, nowIso } from "../../db/mappers";
import type { ConversationEvaluation, QualityLoopKind, QualityLoopMetrics, QualityLoopPhase, QualityProposalDraft, QualityRuntimeConfig } from "./types";
import { QUALITY_LOOP_CONFIG_ID, REVIEW_TOKEN_TTL_MS } from "./types";
import type { QualityPattern } from "./patterns";
import { DEFAULT_QUALITY_RUNTIME } from "./runtime-config";
import type { QualityLoopCadenceState } from "./cadence";

export async function ensureQualityLoopConfig(
  db: D1Database,
  now = nowIso(),
): Promise<QualityLoopCadenceState & { id: string }> {
  const existing = await db
    .prepare(`SELECT * FROM quality_loop_config WHERE id = ?`)
    .bind(QUALITY_LOOP_CONFIG_ID)
    .first<Record<string, unknown>>();
  if (existing) {
    return mapConfig(existing);
  }
  await db
    .prepare(
      `INSERT INTO quality_loop_config (
         id, activated_at, phase, timezone, daily_hour, weekly_weekday, phase1_days, updated_at
       ) VALUES (?, ?, 'daily', 'Europe/London', 8, 5, 60, ?)`,
    )
    .bind(QUALITY_LOOP_CONFIG_ID, now, now)
    .run();
  return {
    id: QUALITY_LOOP_CONFIG_ID,
    activatedAt: now,
    phase: "daily",
    lastRunAt: null,
    lastPeriodFrom: null,
    lastPeriodTo: null,
    lastCadence: null,
    baselineCompletedAt: null,
  };
}

export async function updateQualityLoopConfig(
  db: D1Database,
  patch: {
    phase?: QualityLoopPhase;
    lastRunAt?: string;
    lastPeriodFrom?: string;
    lastPeriodTo?: string;
    lastCadence?: string;
    baselineCompletedAt?: string;
  },
) {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE quality_loop_config
       SET phase = COALESCE(?, phase),
           last_run_at = COALESCE(?, last_run_at),
           last_period_from = COALESCE(?, last_period_from),
           last_period_to = COALESCE(?, last_period_to),
           last_cadence = COALESCE(?, last_cadence),
           baseline_completed_at = COALESCE(?, baseline_completed_at),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      patch.phase ?? null,
      patch.lastRunAt ?? null,
      patch.lastPeriodFrom ?? null,
      patch.lastPeriodTo ?? null,
      patch.lastCadence ?? null,
      patch.baselineCompletedAt ?? null,
      now,
      QUALITY_LOOP_CONFIG_ID,
    )
    .run();
}

export async function insertQualityRun(
  db: D1Database,
  input: { kind: QualityLoopKind; phase: QualityLoopPhase; periodFrom: string; periodTo: string },
) {
  const id = newId("qlr");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO quality_loop_runs (
         id, kind, phase, period_from, period_to, status, metrics_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)`,
    )
    .bind(id, input.kind, input.phase, input.periodFrom, input.periodTo, now)
    .run();
  return { id, createdAt: now };
}

export async function completeQualityRun(
  db: D1Database,
  id: string,
  input: { status: "completed" | "failed"; metrics: QualityLoopMetrics; emailSent: boolean; emailError?: string | null },
) {
  await db
    .prepare(
      `UPDATE quality_loop_runs
       SET status = ?, metrics_json = ?, email_sent = ?, email_error = ?, completed_at = ?
       WHERE id = ?`,
    )
    .bind(input.status, JSON.stringify(input.metrics), input.emailSent ? 1 : 0, input.emailError ?? null, nowIso(), id)
    .run();
}

export async function insertConversationScores(db: D1Database, runId: string, evaluations: ConversationEvaluation[]) {
  for (const evaluation of evaluations) {
    await db
      .prepare(
        `INSERT INTO quality_conversation_scores (
           id, run_id, company_id, interaction_id, conversation_key, channel,
           overall_score, confidence, failed, permission_denial_correct,
           dimensions_json, flags_json, evidence_json, evaluator_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("qls"),
        runId,
        evaluation.companyId,
        evaluation.interactionId ?? null,
        evaluation.conversationKey,
        evaluation.channel,
        evaluation.overallQualityScore,
        evaluation.confidence,
        evaluation.failed ? 1 : 0,
        evaluation.permissionDenialCorrect ? 1 : 0,
        JSON.stringify(evaluation.dimensions),
        JSON.stringify(evaluation.flags),
        JSON.stringify(evaluation.evidence),
        evaluation.evaluatorVersion,
        nowIso(),
      )
      .run();
  }
}

export async function insertPatterns(db: D1Database, runId: string, patterns: QualityPattern[]) {
  const ids: string[] = [];
  for (const pattern of patterns) {
    const id = newId("qlp");
    ids.push(id);
    await db
      .prepare(
        `INSERT INTO quality_patterns (
           id, run_id, company_id, category, title, root_cause, occurrence_count,
           severity, evidence_json, fingerprint, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        runId,
        pattern.companyId,
        pattern.category,
        pattern.title,
        pattern.rootCause,
        pattern.occurrenceCount,
        pattern.severity,
        JSON.stringify(pattern.evidence),
        pattern.fingerprint,
        nowIso(),
      )
      .run();
  }
  return ids;
}

export async function insertProposals(
  db: D1Database,
  runId: string,
  drafts: QualityProposalDraft[],
  pretestByFingerprint: Record<string, unknown>,
) {
  const ids: string[] = [];
  for (const draft of drafts) {
    const pretest = pretestByFingerprint[draft.fingerprint];
    const accepted = Boolean((pretest as { accepted?: boolean } | undefined)?.accepted);
    const status = draft.engineeringRequired
      ? "pending_approval"
      : accepted
        ? "pending_approval"
        : "rejected_pretest";
    const id = newId("qlpr");
    ids.push(id);
    await db
      .prepare(
        `INSERT INTO quality_proposals (
           id, run_id, company_id, pattern_id, title, summary, kind, risk,
           auto_applyable, engineering_required, patch_json, evidence_json,
           fingerprint, status, pretest_json, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        runId,
        draft.companyId,
        draft.title,
        draft.summary,
        draft.kind,
        draft.risk,
        draft.autoApplyable && accepted ? 1 : 0,
        draft.engineeringRequired ? 1 : 0,
        JSON.stringify(draft.patch),
        JSON.stringify(draft.evidence),
        draft.fingerprint,
        status,
        JSON.stringify(pretest ?? null),
        nowIso(),
        nowIso(),
      )
      .run();
    await insertHistory(db, {
      proposalId: id,
      runId,
      action: status === "rejected_pretest" ? "pretest_rejected" : "proposed",
      actor: "system:quality-loop",
      evidence: { pretest, fingerprint: draft.fingerprint },
    });
  }
  return ids;
}

export async function listBlockedProposalFingerprints(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT fingerprint, evidence_json, status FROM quality_proposals
       WHERE status IN ('rejected', 'rejected_pretest', 'failed_validation', 'rolled_back', 'canary', 'promoted')`,
    )
    .all<{ fingerprint: string; evidence_json: string; status: string }>();
  const map = new Map<string, number>();
  for (const row of rows.results ?? []) {
    const evidence = safeJson(row.evidence_json) as { occurrenceCount?: number };
    map.set(row.fingerprint, Number(evidence.occurrenceCount ?? 1));
  }
  return map;
}

export async function insertHistory(
  db: D1Database,
  input: {
    proposalId: string;
    runId?: string | null;
    action: string;
    actor?: string | null;
    runtimeVersion?: number | null;
    evidence?: Record<string, unknown>;
  },
) {
  await db
    .prepare(
      `INSERT INTO quality_improvement_history (
         id, proposal_id, run_id, action, actor, runtime_version, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("qlh"),
      input.proposalId,
      input.runId ?? null,
      input.action,
      input.actor ?? null,
      input.runtimeVersion ?? null,
      JSON.stringify(input.evidence ?? {}),
      nowIso(),
    )
    .run();
}

export async function createReviewToken(db: D1Database, runId: string): Promise<string> {
  const raw = `${runId}.${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const hash = await sha256Hex(raw);
  await db
    .prepare(
      `INSERT INTO quality_review_tokens (id, run_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(newId("qrt"), runId, hash, new Date(Date.now() + REVIEW_TOKEN_TTL_MS).toISOString(), nowIso())
    .run();
  return raw;
}

export async function resolveReviewToken(
  db: D1Database,
  token: string,
  now = new Date().toISOString(),
): Promise<{ runId: string } | { expired: true } | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT run_id, expires_at FROM quality_review_tokens WHERE token_hash = ?`)
    .bind(hash)
    .first<{ run_id: string; expires_at: string }>();
  if (!row) return null;
  if (row.expires_at <= now) return { expired: true };
  return { runId: row.run_id };
}

export async function getRunBundle(db: D1Database, runId: string) {
  const run = await db.prepare(`SELECT * FROM quality_loop_runs WHERE id = ?`).bind(runId).first<Record<string, unknown>>();
  if (!run) return null;
  const scores = await db
    .prepare(
      `SELECT * FROM quality_conversation_scores WHERE run_id = ? AND failed = 1 ORDER BY overall_score ASC LIMIT 25`,
    )
    .bind(runId)
    .all();
  const patterns = await db.prepare(`SELECT * FROM quality_patterns WHERE run_id = ?`).bind(runId).all();
  const proposals = await db.prepare(`SELECT * FROM quality_proposals WHERE run_id = ?`).bind(runId).all();
  return {
    run: mapRun(run),
    failedConversations: (scores.results ?? []).map(mapScore),
    patterns: (patterns.results ?? []).map(mapPattern),
    proposals: (proposals.results ?? []).map(mapProposal),
  };
}

export async function listQualityLoopOverview(db: D1Database) {
  const config = await ensureQualityLoopConfig(db);
  const runs = await db.prepare(`SELECT * FROM quality_loop_runs ORDER BY created_at DESC LIMIT 20`).all();
  const latest = (runs.results ?? [])[0] as Record<string, unknown> | undefined;
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM quality_proposals GROUP BY status`,
    )
    .all<{ status: string; count: number }>();
  const scoreAgg = latest
    ? await db
        .prepare(
          `SELECT COUNT(*) AS conversations, AVG(overall_score) AS quality_avg,
                  AVG(failed) AS failed_rate
           FROM quality_conversation_scores WHERE run_id = ?`,
        )
        .bind(String(latest.id))
        .first<{ conversations: number; quality_avg: number; failed_rate: number }>()
    : null;
  const history = await db
    .prepare(`SELECT * FROM quality_improvement_history ORDER BY created_at DESC LIMIT 40`)
    .all();
  const runtime = await getActiveRuntimeRow(db);
  return {
    config,
    cadence: config.phase === "weekly"
      ? "Weekly Friday 08:00 Europe/London"
      : "Daily 08:00 Europe/London, auto-changes to weekly after 60 days",
    latestRun: latest ? mapRun(latest) : null,
    runs: (runs.results ?? []).map((row) => mapRun(row as Record<string, unknown>)),
    proposalCounts: Object.fromEntries((counts.results ?? []).map((row) => [row.status, Number(row.count)])),
    kpis: {
      conversationsAnalysed: Number(scoreAgg?.conversations ?? 0),
      qualityAverage: Number(scoreAgg?.quality_avg ?? 0),
      failedRate: Number(scoreAgg?.failed_rate ?? 0),
    },
    history: (history.results ?? []).map(mapHistory),
    runtime,
  };
}

export async function getProposal(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT * FROM quality_proposals WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return row ? mapProposal(row) : null;
}

export async function listProposalsForRun(db: D1Database, runId: string) {
  const rows = await db.prepare(`SELECT * FROM quality_proposals WHERE run_id = ?`).bind(runId).all();
  return (rows.results ?? []).map((row) => mapProposal(row as Record<string, unknown>));
}

export async function listPatternsForRun(db: D1Database, runId: string): Promise<import("./patterns").QualityPattern[]> {
  const rows = await db.prepare(`SELECT * FROM quality_patterns WHERE run_id = ?`).bind(runId).all();
  return (rows.results ?? []).map((row) => {
    const mapped = mapPattern(row as Record<string, unknown>);
    return {
      fingerprint: mapped.fingerprint,
      companyId: mapped.companyId,
      category: mapped.category as import("./patterns").QualityPattern["category"],
      title: mapped.title,
      rootCause: mapped.rootCause ?? "",
      occurrenceCount: mapped.occurrenceCount,
      severity: mapped.severity as import("./patterns").QualityPattern["severity"],
      evidence: Array.isArray(mapped.evidence) ? (mapped.evidence as import("./patterns").QualityPattern["evidence"]) : [],
      platformAggregate: mapped.companyId == null,
    };
  });
}

export async function listProposalFingerprintsAcrossRuns(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare(`SELECT fingerprint, COUNT(*) AS n FROM quality_proposals GROUP BY fingerprint`)
    .all<{ fingerprint: string; n: number }>()
    .catch(() => ({ results: [] as Array<{ fingerprint: string; n: number }> }));
  return new Map((rows.results ?? []).map((row) => [row.fingerprint, Number(row.n)]));
}

export async function recoverStaleApplying(db: D1Database, staleMs: number) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = await db
    .prepare(`SELECT id, run_id FROM quality_proposals WHERE status = 'applying' AND updated_at < ?`)
    .bind(cutoff)
    .all<{ id: string; run_id: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; run_id: string }> }));
  for (const row of rows.results ?? []) {
    await updateProposalStatus(db, row.id, "failed_validation");
    await insertHistory(db, {
      proposalId: row.id,
      runId: row.run_id,
      action: "stale_applying_recovered",
      actor: "system:quality-loop",
      evidence: { reason: "APPLYING exceeded recovery window; marked failed_validation" },
    });
  }
  return (rows.results ?? []).length;
}

export async function listHistoryForProposal(db: D1Database, proposalId: string) {
  const rows = await db
    .prepare(`SELECT * FROM quality_improvement_history WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 40`)
    .bind(proposalId)
    .all();
  return (rows.results ?? []).map((row) => mapHistory(row as Record<string, unknown>));
}

export async function updateProposalStatus(db: D1Database, id: string, status: string) {
  await db
    .prepare(`UPDATE quality_proposals SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, nowIso(), id)
    .run();
}

export async function insertRuntimeVersion(
  db: D1Database,
  input: {
    config: QualityRuntimeConfig;
    status: "canary" | "promoted" | "rolled_back";
    proposalId?: string | null;
    canaryPercent?: number;
    canaryCompanyId?: string | null;
    rollbackReason?: string | null;
  },
) {
  const latest = await db
    .prepare(`SELECT MAX(version) AS version FROM quality_runtime_config`)
    .first<{ version: number | null }>();
  const version = Number(latest?.version ?? 0) + 1;
  const id = newId("qlrt");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO quality_runtime_config (
         id, version, status, config_json, proposal_id, canary_percent, canary_company_id,
         created_at, promoted_at, rolled_back_at, rollback_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      version,
      input.status,
      JSON.stringify({ ...input.config, version }),
      input.proposalId ?? null,
      input.canaryPercent ?? 10,
      input.canaryCompanyId ?? "co_caddington",
      now,
      input.status === "promoted" ? now : null,
      input.status === "rolled_back" ? now : null,
      input.rollbackReason ?? null,
    )
    .run();
  return { id, version };
}

export async function getActiveRuntimeRow(db: D1Database) {
  const canary = await db
    .prepare(`SELECT * FROM quality_runtime_config WHERE status = 'canary' ORDER BY version DESC LIMIT 1`)
    .first<Record<string, unknown>>();
  const promoted = await db
    .prepare(`SELECT * FROM quality_runtime_config WHERE status = 'promoted' ORDER BY version DESC LIMIT 1`)
    .first<Record<string, unknown>>();
  return {
    canary: canary ? mapRuntime(canary) : null,
    promoted: promoted ? mapRuntime(promoted) : null,
    default: DEFAULT_QUALITY_RUNTIME,
  };
}

export async function markRuntimeStatus(
  db: D1Database,
  version: number,
  status: "promoted" | "rolled_back",
  reason?: string,
) {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE quality_runtime_config
       SET status = ?, promoted_at = CASE WHEN ? = 'promoted' THEN ? ELSE promoted_at END,
           rolled_back_at = CASE WHEN ? = 'rolled_back' THEN ? ELSE rolled_back_at END,
           rollback_reason = COALESCE(?, rollback_reason)
       WHERE version = ?`,
    )
    .bind(status, status, now, status, now, reason ?? null, version)
    .run();
}

export async function ensureQualityOperatorJobs(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS quality_operator_jobs (
         id TEXT PRIMARY KEY,
         token_hash TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL,
         status TEXT NOT NULL,
         actor TEXT,
         payload_json TEXT NOT NULL DEFAULT '{}',
         expires_at TEXT NOT NULL,
         created_at TEXT NOT NULL,
         consumed_at TEXT
       )`,
    )
    .run();
}

export async function consumeQualityOperatorJob(
  db: D1Database,
  token: string,
): Promise<{ id: string; kind: string; payload: Record<string, unknown> } | null> {
  if (!token.trim()) return null;
  await ensureQualityOperatorJobs(db);
  const hash = await sha256Hex(token.trim());
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT id, kind, payload_json, status, expires_at
       FROM quality_operator_jobs WHERE token_hash = ? LIMIT 1`,
    )
    .bind(hash)
    .first<{ id: string; kind: string; payload_json: string; status: string; expires_at: string }>();
  if (!row || row.status !== "pending" || row.expires_at <= now) return null;
  await db
    .prepare(`UPDATE quality_operator_jobs SET status = 'consumed', consumed_at = ? WHERE id = ?`)
    .bind(now, row.id)
    .run();
  return { id: row.id, kind: row.kind, payload: (safeJson(row.payload_json) as Record<string, unknown>) ?? {} };
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapConfig(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    activatedAt: String(row.activated_at),
    phase: (row.phase === "weekly" ? "weekly" : "daily") as QualityLoopPhase,
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastPeriodFrom: row.last_period_from ? String(row.last_period_from) : null,
    lastPeriodTo: row.last_period_to ? String(row.last_period_to) : null,
    lastCadence: row.last_cadence ? String(row.last_cadence) : null,
    baselineCompletedAt: row.baseline_completed_at ? String(row.baseline_completed_at) : null,
  };
}

function mapRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    phase: String(row.phase),
    periodFrom: String(row.period_from),
    periodTo: String(row.period_to),
    status: String(row.status),
    metrics: safeJson(String(row.metrics_json ?? "{}")),
    emailSent: Boolean(row.email_sent),
    emailError: row.email_error ? String(row.email_error) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapScore(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    interactionId: row.interaction_id ? String(row.interaction_id) : null,
    conversationKey: String(row.conversation_key),
    overallScore: Number(row.overall_score),
    confidence: Number(row.confidence),
    failed: Boolean(row.failed),
    permissionDenialCorrect: Boolean(row.permission_denial_correct),
    flags: safeJson(String(row.flags_json ?? "[]")),
    dimensions: safeJson(String(row.dimensions_json ?? "{}")),
  };
}

function mapPattern(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    category: String(row.category),
    title: String(row.title),
    rootCause: row.root_cause ? String(row.root_cause) : null,
    occurrenceCount: Number(row.occurrence_count),
    severity: String(row.severity),
    evidence: safeJson(String(row.evidence_json ?? "[]")),
    fingerprint: String(row.fingerprint),
  };
}

function mapProposal(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    companyId: row.company_id ? String(row.company_id) : null,
    title: String(row.title),
    summary: String(row.summary),
    kind: String(row.kind),
    risk: String(row.risk),
    autoApplyable: Boolean(row.auto_applyable),
    engineeringRequired: Boolean(row.engineering_required),
    patch: safeJson(String(row.patch_json ?? "{}")),
    evidence: safeJson(String(row.evidence_json ?? "{}")),
    fingerprint: String(row.fingerprint),
    status: String(row.status),
    pretest: safeJson(String(row.pretest_json ?? "null")),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapHistory(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    runId: row.run_id ? String(row.run_id) : null,
    action: String(row.action),
    actor: row.actor ? String(row.actor) : null,
    runtimeVersion: row.runtime_version != null ? Number(row.runtime_version) : null,
    evidence: safeJson(String(row.evidence_json ?? "{}")),
    createdAt: String(row.created_at),
  };
}

function mapRuntime(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    version: Number(row.version),
    status: String(row.status),
    config: safeJson(String(row.config_json ?? "{}")),
    proposalId: row.proposal_id ? String(row.proposal_id) : null,
    canaryPercent: Number(row.canary_percent ?? 10),
    canaryCompanyId: row.canary_company_id ? String(row.canary_company_id) : null,
    rollbackReason: row.rollback_reason ? String(row.rollback_reason) : null,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw === "null" ? null : {};
  }
}
