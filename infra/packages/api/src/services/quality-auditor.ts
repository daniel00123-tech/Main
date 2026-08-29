import { newId, nowIso } from "../db/mappers";

export const QUALITY_STATUSES = [
  "new",
  "investigating",
  "accepted",
  "fixed",
  "dismissed",
] as const;

export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export type QualityCategory =
  | "tool_call_failed"
  | "auth_permission_failure"
  | "connector_failure"
  | "timeout"
  | "high_latency"
  | "high_cost"
  | "repeated_tool_calls"
  | "user_immediate_retry"
  | "repeated_user_rephrase";

export interface QualitySignal {
  category: QualityCategory;
  severity: "low" | "medium" | "high";
  confidence: number;
  evidence: Record<string, unknown>;
  suggestedInvestigation: string;
}

export interface QualityAuditInput {
  interactionId: string;
  companyId: string;
  userId?: string | null;
  channel?: string | null;
  usage: Array<{
    toolName?: string | null;
    action?: string | null;
    success?: boolean | number | null;
    durationMs?: number | null;
    customerChargeCents?: number | null;
    underlyingCostCents?: number | null;
    actorEmail?: string | null;
    recordedAt?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  gateway?: Array<{
    status?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    latencyMs?: number | null;
    toolName?: string | null;
  }>;
  recentSameActor?: Array<{
    interactionId: string;
    recordedAt: string;
    toolName?: string | null;
  }>;
}

export const HIGH_LATENCY_MS = 15_000;
export const HIGH_COST_CENTS = 50;
export const RETRY_WINDOW_MS = 60_000;

export function qualityFingerprint(input: {
  companyId?: string | null;
  category: string;
  toolName?: string | null;
  errorCode?: string | null;
}): string {
  const parts = [
    input.companyId ?? "platform",
    input.category,
    input.toolName ?? "any",
    input.errorCode ?? "none",
  ];
  return parts.map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, "_")).join(":");
}

export function shouldSampleAudit(interactionId: string, sampleRate: number): boolean {
  const rate = Number.isFinite(sampleRate) ? Math.min(1, Math.max(0, sampleRate)) : 1;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let hash = 0;
  for (const char of interactionId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 1000 < Math.round(rate * 1000);
}

export function detectQualitySignals(input: QualityAuditInput): QualitySignal[] {
  const signals: QualitySignal[] = [];
  const failed = input.usage.filter((row) => row.success === false || row.success === 0);
  const gatewayFailed = (input.gateway ?? []).filter(
    (row) => row.errorCode || (row.status && row.status !== "ok" && row.status !== "completed" && row.status !== "success"),
  );

  if (failed.length > 0 || gatewayFailed.some((row) => !isAuthError(row) && !isTimeout(row) && !isConnectorError(row))) {
    if (failed.length > 0 || gatewayFailed.length > 0) {
      const first = failed[0] ?? {};
      const gw = gatewayFailed[0];
      if (!isAuthError(gw) && !isTimeout(gw) && !isConnectorError(gw)) {
        signals.push({
          category: "tool_call_failed",
          severity: "high",
          confidence: 0.9,
          evidence: {
            failedOperations: failed.length,
            toolName: first.toolName ?? gw?.toolName ?? null,
            errorCode: gw?.errorCode ?? null,
          },
          suggestedInvestigation: "Inspect the failed tool result and connector health for this interaction.",
        });
      }
    }
  }

  const auth = gatewayFailed.filter(isAuthError);
  if (auth.length > 0) {
    signals.push({
      category: "auth_permission_failure",
      severity: "high",
      confidence: 0.95,
      evidence: { errorCode: auth[0]?.errorCode, errorMessage: redactError(auth[0]?.errorMessage) },
      suggestedInvestigation: "Check role grants, service identity scopes, and connector consent.",
    });
  }

  const connector = [...failed, ...gatewayFailed].filter((row) =>
    isConnectorError("errorCode" in row ? row : { errorMessage: String((row as { toolName?: string }).toolName ?? "") }),
  );
  const connectorHint = gatewayFailed.filter(isConnectorError);
  if (connectorHint.length > 0 || connector.length > 0) {
    signals.push({
      category: "connector_failure",
      severity: "high",
      confidence: 0.85,
      evidence: { errorCode: connectorHint[0]?.errorCode ?? null },
      suggestedInvestigation: "Check the source system connector (Xero, Microsoft, Drive) without changing production config automatically.",
    });
  }

  const timeout = gatewayFailed.filter(isTimeout);
  const slow = input.usage.filter((row) => Number(row.durationMs ?? 0) >= HIGH_LATENCY_MS);
  if (timeout.length > 0) {
    signals.push({
      category: "timeout",
      severity: "high",
      confidence: 0.9,
      evidence: { errorCode: timeout[0]?.errorCode ?? "timeout" },
      suggestedInvestigation: "Review downstream MCP/tool timeout and queue backlog.",
    });
  } else if (slow.length > 0) {
    signals.push({
      category: "high_latency",
      severity: "medium",
      confidence: 0.8,
      evidence: { durationMs: slow[0]?.durationMs, thresholdMs: HIGH_LATENCY_MS },
      suggestedInvestigation: "Compare this latency with typical duration for the same tool.",
    });
  }

  const highCost = input.usage.filter(
    (row) => Number(row.customerChargeCents ?? 0) >= HIGH_COST_CENTS || Number(row.underlyingCostCents ?? 0) >= HIGH_COST_CENTS,
  );
  if (highCost.length > 0) {
    signals.push({
      category: "high_cost",
      severity: "medium",
      confidence: 0.75,
      evidence: {
        customerChargeCents: highCost[0]?.customerChargeCents ?? null,
        underlyingCostCents: highCost[0]?.underlyingCostCents ?? null,
        thresholdCents: HIGH_COST_CENTS,
      },
      suggestedInvestigation: "Confirm whether the usage quantity and pricing rule are expected.",
    });
  }

  const toolCounts = new Map<string, number>();
  for (const row of input.usage) {
    const tool = row.toolName ?? row.action;
    if (!tool) continue;
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }
  for (const [toolName, count] of toolCounts) {
    if (count >= 3) {
      signals.push({
        category: "repeated_tool_calls",
        severity: "low",
        confidence: 0.7,
        evidence: { toolName, count },
        suggestedInvestigation: "Check whether the model retried the same tool because the first result was empty or failed.",
      });
    }
  }

  const recent = (input.recentSameActor ?? []).filter((row) => row.interactionId !== input.interactionId);
  if (recent.length > 0) {
    signals.push({
      category: "user_immediate_retry",
      severity: "medium",
      confidence: 0.7,
      evidence: {
        priorInteractionId: recent[0]?.interactionId,
        priorAt: recent[0]?.recordedAt,
        windowMs: RETRY_WINDOW_MS,
      },
      suggestedInvestigation: "User retried quickly — inspect whether the first answer was empty, failed, or ungrounded.",
    });
    if (looksLikeRephrase(input, recent)) {
      signals.push({
        category: "repeated_user_rephrase",
        severity: "medium",
        confidence: 0.55,
        evidence: { priorInteractionId: recent[0]?.interactionId },
        suggestedInvestigation: "Repeated prompt shortly after a prior interaction. Do not treat this as proof the answer was wrong.",
      });
    }
  }

  return dedupeSignals(signals);
}

function isAuthError(row?: { errorCode?: string | null; errorMessage?: string | null; status?: string | null }) {
  const hay = `${row?.errorCode ?? ""} ${row?.errorMessage ?? ""} ${row?.status ?? ""}`.toLowerCase();
  return /permission|forbidden|unauthorized|unauthorised|auth|denied|403|401/.test(hay);
}

function isTimeout(row?: { errorCode?: string | null; errorMessage?: string | null }) {
  const hay = `${row?.errorCode ?? ""} ${row?.errorMessage ?? ""}`.toLowerCase();
  return /timeout|timed out|deadline/.test(hay);
}

function isConnectorError(row?: { errorCode?: string | null; errorMessage?: string | null }) {
  const hay = `${row?.errorCode ?? ""} ${row?.errorMessage ?? ""}`.toLowerCase();
  return /connector|xero|microsoft|graph|sharepoint|onedrive|drive|oauth|token expired/.test(hay);
}

function redactError(value?: string | null): string | null {
  if (!value) return null;
  return value.replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]").slice(0, 240);
}

function looksLikeRephrase(
  input: QualityAuditInput,
  recent: Array<{ toolName?: string | null }>,
): boolean {
  const currentTools = new Set(input.usage.map((row) => row.toolName).filter(Boolean));
  return recent.some((row) => row.toolName && currentTools.has(row.toolName));
}

function dedupeSignals(signals: QualitySignal[]): QualitySignal[] {
  const seen = new Set<string>();
  const out: QualitySignal[] = [];
  for (const signal of signals) {
    if (seen.has(signal.category)) continue;
    seen.add(signal.category);
    out.push(signal);
  }
  return out;
}

export function qualityScore(signals: QualitySignal[]): number {
  const penalty = signals.reduce((sum, signal) => {
    if (signal.severity === "high") return sum + 25;
    if (signal.severity === "medium") return sum + 12;
    return sum + 5;
  }, 0);
  return Math.max(0, 100 - penalty);
}

export async function processQualityAudit(db: D1Database, input: QualityAuditInput): Promise<{
  sampled: boolean;
  signals: QualitySignal[];
  issueIds: string[];
}> {
  const signals = detectQualitySignals(input);
  const issueIds: string[] = [];
  const now = nowIso();

  for (const signal of signals) {
    const fingerprint = qualityFingerprint({
      companyId: input.companyId,
      category: signal.category,
      toolName: String(signal.evidence.toolName ?? input.usage[0]?.toolName ?? ""),
      errorCode: String(signal.evidence.errorCode ?? ""),
    });
    const existing = await db
      .prepare(`SELECT id, occurrence_count FROM quality_issues WHERE fingerprint = ?`)
      .bind(fingerprint)
      .first<{ id: string; occurrence_count: number }>();

    if (existing) {
      await db
        .prepare(
          `UPDATE quality_issues
           SET last_interaction_id = ?, user_id = ?, channel = ?, confidence = ?,
               evidence_json = ?, suggested_investigation = ?, occurrence_count = ?,
               last_seen_at = ?, updated_at = ?,
               status = CASE WHEN status IN ('fixed', 'dismissed') THEN 'new' ELSE status END
           WHERE id = ?`,
        )
        .bind(
          input.interactionId,
          input.userId ?? null,
          input.channel ?? null,
          signal.confidence,
          JSON.stringify([signal.evidence]),
          signal.suggestedInvestigation,
          Number(existing.occurrence_count ?? 1) + 1,
          now,
          now,
          existing.id,
        )
        .run();
      await insertIssueEvent(db, existing.id, input, signal, now);
      issueIds.push(existing.id);
      continue;
    }

    const id = newId("qi");
    await db
      .prepare(
        `INSERT INTO quality_issues (
           id, fingerprint, company_id, user_id, last_interaction_id, channel,
           category, severity, confidence, evidence_json, suggested_investigation,
           occurrence_count, first_seen_at, last_seen_at, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'new', ?, ?)`,
      )
      .bind(
        id,
        fingerprint,
        input.companyId,
        input.userId ?? null,
        input.interactionId,
        input.channel ?? null,
        signal.category,
        signal.severity,
        signal.confidence,
        JSON.stringify([signal.evidence]),
        signal.suggestedInvestigation,
        now,
        now,
        now,
        now,
      )
      .run();
    await insertIssueEvent(db, id, input, signal, now);
    issueIds.push(id);
  }

  return { sampled: true, signals, issueIds };
}

async function insertIssueEvent(
  db: D1Database,
  issueId: string,
  input: QualityAuditInput,
  signal: QualitySignal,
  now: string,
) {
  await db
    .prepare(
      `INSERT INTO quality_issue_events (
         id, quality_issue_id, interaction_id, company_id, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("qie"),
      issueId,
      input.interactionId,
      input.companyId,
      JSON.stringify(signal.evidence),
      now,
    )
    .run();
}

export async function auditInteractionById(
  db: D1Database,
  interactionId: string,
): Promise<{ sampled: boolean; signals: QualitySignal[]; issueIds: string[] } | null> {
  const interaction = await db
    .prepare(`SELECT id, company_id, actor_id, client_kind FROM interactions WHERE id = ?`)
    .bind(interactionId)
    .first<{ id: string; company_id: string; actor_id: string; client_kind: string }>();
  if (!interaction) return null;

  const usage = await db
    .prepare(
      `SELECT tool_name, action, success, duration_ms, customer_charge_cents,
              underlying_cost_cents, actor_email, recorded_at, metadata_json, user_id
       FROM usage_records WHERE interaction_id = ? ORDER BY recorded_at ASC`,
    )
    .bind(interactionId)
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
      user_id: string | null;
    }>();

  const gateway = await db
    .prepare(
      `SELECT status, error_code, error_message, latency_ms, tool_name
       FROM gateway_requests WHERE company_id = ? AND created_at >= datetime(?, '-1 hour')
       ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(interaction.company_id, usage.results?.[0]?.recorded_at ?? nowIso())
    .all<{
      status: string | null;
      error_code: string | null;
      error_message: string | null;
      latency_ms: number | null;
      tool_name: string | null;
    }>();

  const firstAt = usage.results?.[0]?.recorded_at;
  const recent = firstAt
    ? await db
        .prepare(
          `SELECT interaction_id, recorded_at, tool_name
           FROM usage_records
           WHERE company_id = ?
             AND (user_id = ? OR actor_email = ?)
             AND recorded_at >= ?
             AND recorded_at < ?
             AND interaction_id IS NOT NULL
             AND interaction_id != ?
           ORDER BY recorded_at DESC LIMIT 5`,
        )
        .bind(
          interaction.company_id,
          interaction.actor_id,
          usage.results?.[0]?.actor_email ?? "",
          new Date(new Date(firstAt).getTime() - RETRY_WINDOW_MS).toISOString(),
          firstAt,
          interactionId,
        )
        .all<{ interaction_id: string; recorded_at: string; tool_name: string | null }>()
    : { results: [] };

  return processQualityAudit(db, {
    interactionId,
    companyId: interaction.company_id,
    userId: interaction.actor_id,
    channel: mapChannel(interaction.client_kind),
    usage: (usage.results ?? []).map((row) => ({
      toolName: row.tool_name,
      action: row.action,
      success: row.success,
      durationMs: row.duration_ms,
      customerChargeCents: row.customer_charge_cents,
      underlyingCostCents: row.underlying_cost_cents,
      actorEmail: row.actor_email,
      recordedAt: row.recorded_at,
      metadata: safeJson(row.metadata_json),
    })),
    gateway: (gateway.results ?? []).map((row) => ({
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      latencyMs: row.latency_ms,
      toolName: row.tool_name,
    })),
    recentSameActor: (recent.results ?? []).map((row) => ({
      interactionId: row.interaction_id,
      recordedAt: row.recorded_at,
      toolName: row.tool_name,
    })),
  });
}

export function mapChannel(clientKind?: string | null): string {
  switch (String(clientKind ?? "").toLowerCase()) {
    case "chatgpt":
    case "chatgpt_mcp":
      return "chatgpt_mcp";
    case "claude":
    case "claude_mcp":
      return "claude_mcp";
    case "whatsapp":
      return "whatsapp";
    case "automation":
    case "service":
      return "automation";
    case "portal":
    case "infra-web":
    case "internal":
      return "portal";
    case "api":
    case "gateway":
    case "infra-gateway":
    case "infra-mcp":
      return "api";
    default:
      return clientKind?.trim() ? clientKind : "api";
  }
}

function safeJson(raw: string | null): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function listQualityIssues(
  db: D1Database,
  filters: {
    companyId?: string;
    status?: string;
    category?: string;
    limit?: number;
  } = {},
) {
  const limit = Math.min(filters.limit ?? 100, 250);
  const result = await db
    .prepare(
      `SELECT q.*, c.name AS company_name, u.email AS user_email, u.display_name AS user_name
       FROM quality_issues q
       LEFT JOIN companies c ON c.id = q.company_id
       LEFT JOIN users u ON u.id = q.user_id
       WHERE (? IS NULL OR q.company_id = ?)
         AND (? IS NULL OR q.status = ?)
         AND (? IS NULL OR q.category = ?)
       ORDER BY q.last_seen_at DESC
       LIMIT ?`,
    )
    .bind(
      filters.companyId ?? null,
      filters.companyId ?? null,
      filters.status ?? null,
      filters.status ?? null,
      filters.category ?? null,
      filters.category ?? null,
      limit,
    )
    .all();

  return (result.results ?? []).map((row) => mapIssue(row as Record<string, unknown>));
}

export async function updateQualityIssueStatus(
  db: D1Database,
  id: string,
  status: QualityStatus,
) {
  if (!QUALITY_STATUSES.includes(status)) {
    throw new Error("Invalid quality issue status");
  }
  await db
    .prepare(`UPDATE quality_issues SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, nowIso(), id)
    .run();
  return db.prepare(`SELECT * FROM quality_issues WHERE id = ?`).bind(id).first();
}

function mapIssue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    companyId: row.company_id ? String(row.company_id) : null,
    companyName: row.company_name ? String(row.company_name) : null,
    userId: row.user_id ? String(row.user_id) : null,
    userEmail: row.user_email ? String(row.user_email) : null,
    userName: row.user_name ? String(row.user_name) : null,
    interactionId: row.last_interaction_id ? String(row.last_interaction_id) : null,
    channel: row.channel ? String(row.channel) : null,
    category: String(row.category),
    severity: String(row.severity),
    confidence: Number(row.confidence),
    evidence: safeJsonArray(String(row.evidence_json ?? "[]")),
    suggestedInvestigation: row.suggested_investigation ? String(row.suggested_investigation) : null,
    occurrenceCount: Number(row.occurrence_count ?? 1),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    status: String(row.status),
  };
}

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function scheduleQualityAudit(
  env: { QUALITY_AUDIT_SAMPLE_RATE?: string; DB: D1Database },
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  interactionId: string | null | undefined,
) {
  if (!interactionId || !waitUntil) return;
  const sampleRate = Number(env.QUALITY_AUDIT_SAMPLE_RATE ?? "1");
  if (!shouldSampleAudit(interactionId, sampleRate)) return;
  waitUntil(
    auditInteractionById(env.DB, interactionId).catch(() => null),
  );
}
