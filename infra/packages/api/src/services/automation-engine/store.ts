/**
 * Automation Engine persistence layer.
 */

import type {
  AutomationActionType,
  AutomationDefinitionRecord,
  AutomationRunRecord,
  AutomationRunStepRecord,
  AutomationRunTrigger,
  AutomationSchedule,
  AutomationStatus,
  AutomationTriggerType,
} from "@infra/shared";
import { normalizeAutomationRunTrigger } from "@infra/shared";
import { newId, nowIso } from "../../db/mappers";
import { parseAutomationSchedule } from "./schedule";

function mapDefinition(row: Record<string, unknown>): AutomationDefinitionRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    status: String(row.status) as AutomationStatus,
    triggerType: String(row.trigger_type) as AutomationTriggerType,
    schedule: parseAutomationSchedule(row.schedule_json ? String(row.schedule_json) : null),
    timezone: String(row.timezone ?? "UTC"),
    actionType: String(row.action_type) as AutomationActionType,
    configuration: JSON.parse(String(row.configuration_json ?? "{}")) as Record<string, unknown>,
    serviceIdentityId: row.service_identity_id ? String(row.service_identity_id) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    failureCount: Number(row.failure_count ?? 0),
    maximumRetries: Number(row.maximum_retries ?? 3),
  };
}

function mapRun(row: Record<string, unknown>): AutomationRunRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    automationId: String(row.automation_id),
    status: String(row.status) as AutomationRunRecord["status"],
    triggerType: normalizeAutomationRunTrigger(String(row.trigger_type)),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    attempt: Number(row.attempt ?? 1),
    initiatedBy: row.initiated_by ? String(row.initiated_by) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    resultSummary: row.result_summary ? String(row.result_summary) : null,
    result: row.result_json ? (JSON.parse(String(row.result_json)) as Record<string, unknown>) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapStep(row: Record<string, unknown>): AutomationRunStepRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    runId: String(row.run_id),
    stepIndex: Number(row.step_index ?? 0),
    actionType: String(row.action_type) as AutomationActionType,
    status: String(row.status) as AutomationRunStepRecord["status"],
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    result: row.result_json ? (JSON.parse(String(row.result_json)) as Record<string, unknown>) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listAutomationDefinitions(
  db: D1Database,
  companyId: string,
): Promise<AutomationDefinitionRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM automation_definitions WHERE company_id = ? ORDER BY updated_at DESC`,
    )
    .bind(companyId)
    .all();
  return (rows.results ?? []).map((row) => mapDefinition(row as Record<string, unknown>));
}

export async function getAutomationDefinition(
  db: D1Database,
  companyId: string,
  automationId: string,
): Promise<AutomationDefinitionRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM automation_definitions WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(automationId, companyId)
    .first();
  return row ? mapDefinition(row as Record<string, unknown>) : null;
}

export async function createAutomationDefinition(
  db: D1Database,
  input: {
    companyId: string;
    name: string;
    description?: string | null;
    triggerType: AutomationTriggerType;
    schedule?: AutomationSchedule | null;
    timezone?: string;
    actionType: AutomationActionType;
    configuration: Record<string, unknown>;
    createdBy: string;
    status?: AutomationStatus;
    nextRunAt?: string | null;
    serviceIdentityId?: string | null;
  },
): Promise<AutomationDefinitionRecord> {
  const id = newId("aut");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO automation_definitions (
        id, company_id, name, description, status, trigger_type, schedule_json, timezone,
        action_type, configuration_json, service_identity_id, created_by, created_at, updated_at,
        next_run_at, failure_count, maximum_retries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3)`,
    )
    .bind(
      id,
      input.companyId,
      input.name,
      input.description ?? null,
      input.status ?? "draft",
      input.triggerType,
      input.schedule ? JSON.stringify(input.schedule) : null,
      input.timezone ?? "UTC",
      input.actionType,
      JSON.stringify(input.configuration),
      input.serviceIdentityId ?? null,
      input.createdBy,
      now,
      now,
      input.nextRunAt ?? null,
    )
    .run();
  const created = await getAutomationDefinition(db, input.companyId, id);
  if (!created) throw new Error("Failed to create automation");
  return created;
}

export async function updateAutomationDefinition(
  db: D1Database,
  input: {
    companyId: string;
    automationId: string;
    patch: Partial<{
      name: string;
      description: string | null;
      status: AutomationStatus;
      triggerType: AutomationTriggerType;
      schedule: AutomationSchedule | null;
      timezone: string;
      actionType: AutomationActionType;
      configuration: Record<string, unknown>;
      serviceIdentityId: string | null;
      nextRunAt: string | null;
      lastRunAt: string | null;
      failureCount: number;
    }>;
  },
): Promise<AutomationDefinitionRecord | null> {
  const existing = await getAutomationDefinition(db, input.companyId, input.automationId);
  if (!existing) return null;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE automation_definitions SET
        name = ?, description = ?, status = ?, trigger_type = ?, schedule_json = ?, timezone = ?,
        action_type = ?, configuration_json = ?, service_identity_id = ?, next_run_at = ?,
        last_run_at = ?, failure_count = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(
      input.patch.name ?? existing.name,
      input.patch.description !== undefined ? input.patch.description : existing.description,
      input.patch.status ?? existing.status,
      input.patch.triggerType ?? existing.triggerType,
      input.patch.schedule !== undefined
        ? input.patch.schedule
          ? JSON.stringify(input.patch.schedule)
          : null
        : existing.schedule
          ? JSON.stringify(existing.schedule)
          : null,
      input.patch.timezone ?? existing.timezone,
      input.patch.actionType ?? existing.actionType,
      JSON.stringify(input.patch.configuration ?? existing.configuration),
      input.patch.serviceIdentityId !== undefined
        ? input.patch.serviceIdentityId
        : existing.serviceIdentityId,
      input.patch.nextRunAt !== undefined ? input.patch.nextRunAt : existing.nextRunAt,
      input.patch.lastRunAt !== undefined ? input.patch.lastRunAt : existing.lastRunAt,
      input.patch.failureCount ?? existing.failureCount,
      now,
      input.automationId,
      input.companyId,
    )
    .run();
  return getAutomationDefinition(db, input.companyId, input.automationId);
}

export async function listAutomationRuns(
  db: D1Database,
  companyId: string,
  automationId?: string,
  limit = 50,
): Promise<AutomationRunRecord[]> {
  const query = automationId
    ? `SELECT * FROM automation_runs WHERE company_id = ? AND automation_id = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM automation_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`;
  const binds = automationId ? [companyId, automationId, limit] : [companyId, limit];
  const rows = await db.prepare(query).bind(...binds).all();
  return (rows.results ?? []).map((row) => mapRun(row as Record<string, unknown>));
}

export async function getAutomationRun(
  db: D1Database,
  companyId: string,
  runId: string,
): Promise<AutomationRunRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM automation_runs WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(runId, companyId)
    .first();
  return row ? mapRun(row as Record<string, unknown>) : null;
}

export async function listAutomationRunSteps(
  db: D1Database,
  companyId: string,
  runId: string,
): Promise<AutomationRunStepRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM automation_run_steps WHERE company_id = ? AND run_id = ? ORDER BY step_index ASC`,
    )
    .bind(companyId, runId)
    .all();
  return (rows.results ?? []).map((row) => mapStep(row as Record<string, unknown>));
}

export async function createAutomationRun(
  db: D1Database,
  input: {
    companyId: string;
    automationId: string;
    triggerType: AutomationRunTrigger;
    idempotencyKey?: string | null;
    initiatedBy?: string | null;
    attempt?: number;
  },
): Promise<{ run: AutomationRunRecord; created: boolean }> {
  if (input.idempotencyKey) {
    const existing = await db
      .prepare(
        `SELECT id FROM automation_runs WHERE automation_id = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(input.automationId, input.idempotencyKey)
      .first<{ id: string }>();
    if (existing?.id) {
      const run = await getAutomationRun(db, input.companyId, existing.id);
      if (run) return { run, created: false };
    }
  }

  const id = newId("aur");
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO automation_runs (
          id, company_id, automation_id, status, trigger_type, idempotency_key, attempt,
          initiated_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.companyId,
        input.automationId,
        input.triggerType,
        input.idempotencyKey ?? null,
        input.attempt ?? 1,
        input.initiatedBy ?? null,
        now,
        now,
      )
      .run();
  } catch (err) {
    if (input.idempotencyKey) {
      const existing = await db
        .prepare(
          `SELECT id FROM automation_runs WHERE automation_id = ? AND idempotency_key = ? LIMIT 1`,
        )
        .bind(input.automationId, input.idempotencyKey)
        .first<{ id: string }>();
      if (existing?.id) {
        const run = await getAutomationRun(db, input.companyId, existing.id);
        if (run) return { run, created: false };
      }
    }
    throw err;
  }
  const run = await getAutomationRun(db, input.companyId, id);
  if (!run) throw new Error("Failed to create automation run");
  return { run, created: true };
}

export async function findAutomationRunByIdempotencyKey(
  db: D1Database,
  companyId: string,
  automationId: string,
  idempotencyKey: string,
): Promise<AutomationRunRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM automation_runs
       WHERE company_id = ? AND automation_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(companyId, automationId, idempotencyKey)
    .first();
  return row ? mapRun(row as Record<string, unknown>) : null;
}

export async function findActiveAutomationRun(
  db: D1Database,
  companyId: string,
  automationId: string,
): Promise<AutomationRunRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM automation_runs
       WHERE company_id = ? AND automation_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(companyId, automationId)
    .first();
  return row ? mapRun(row as Record<string, unknown>) : null;
}

export async function listLatestAutomationRuns(
  db: D1Database,
  companyId: string,
): Promise<Map<string, AutomationRunRecord>> {
  const rows = await db
    .prepare(
      `SELECT r.* FROM automation_runs r
       INNER JOIN (
         SELECT automation_id, MAX(created_at) AS max_created
         FROM automation_runs
         WHERE company_id = ?
         GROUP BY automation_id
       ) latest
         ON latest.automation_id = r.automation_id AND latest.max_created = r.created_at
       WHERE r.company_id = ?`,
    )
    .bind(companyId, companyId)
    .all();
  const map = new Map<string, AutomationRunRecord>();
  for (const row of rows.results ?? []) {
    const run = mapRun(row as Record<string, unknown>);
    map.set(run.automationId, run);
  }
  return map;
}

export async function findAutomationsByName(
  db: D1Database,
  companyId: string,
  name: string,
): Promise<AutomationDefinitionRecord[]> {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const items = await listAutomationDefinitions(db, companyId);
  return items.filter((item) => item.name.trim().toLowerCase() === needle);
}

export async function updateAutomationRun(
  db: D1Database,
  input: {
    companyId: string;
    runId: string;
    patch: Partial<{
      status: AutomationRunRecord["status"];
      startedAt: string | null;
      completedAt: string | null;
      durationMs: number | null;
      resultSummary: string | null;
      result: Record<string, unknown> | null;
      errorCode: string | null;
      errorMessage: string | null;
      attempt: number;
    }>;
  },
): Promise<void> {
  const existing = await getAutomationRun(db, input.companyId, input.runId);
  if (!existing) return;
  await db
    .prepare(
      `UPDATE automation_runs SET
        status = ?, started_at = ?, completed_at = ?, duration_ms = ?, result_summary = ?,
        result_json = ?, error_code = ?, error_message = ?, attempt = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(
      input.patch.status ?? existing.status,
      input.patch.startedAt !== undefined ? input.patch.startedAt : existing.startedAt,
      input.patch.completedAt !== undefined ? input.patch.completedAt : existing.completedAt,
      input.patch.durationMs !== undefined ? input.patch.durationMs : existing.durationMs,
      input.patch.resultSummary !== undefined ? input.patch.resultSummary : existing.resultSummary,
      input.patch.result !== undefined ? JSON.stringify(input.patch.result) : existing.result ? JSON.stringify(existing.result) : null,
      input.patch.errorCode !== undefined ? input.patch.errorCode : existing.errorCode,
      input.patch.errorMessage !== undefined ? input.patch.errorMessage : existing.errorMessage,
      input.patch.attempt ?? existing.attempt,
      nowIso(),
      input.runId,
      input.companyId,
    )
    .run();
}

export async function createAutomationRunStep(
  db: D1Database,
  input: {
    companyId: string;
    runId: string;
    stepIndex: number;
    actionType: AutomationActionType;
    status?: AutomationRunStepRecord["status"];
  },
): Promise<string> {
  const id = newId("aus");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO automation_run_steps (
        id, company_id, run_id, step_index, action_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.runId,
      input.stepIndex,
      input.actionType,
      input.status ?? "queued",
      now,
      now,
    )
    .run();
  return id;
}

export async function updateAutomationRunStep(
  db: D1Database,
  stepId: string,
  patch: Partial<{
    status: AutomationRunStepRecord["status"];
    startedAt: string | null;
    completedAt: string | null;
    result: Record<string, unknown> | null;
    errorMessage: string | null;
  }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_run_steps SET
        status = COALESCE(?, status),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        result_json = COALESCE(?, result_json),
        error_message = COALESCE(?, error_message),
        updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      patch.status ?? null,
      patch.startedAt ?? null,
      patch.completedAt ?? null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.errorMessage ?? null,
      nowIso(),
      stepId,
    )
    .run();
}

export async function listDueAutomations(db: D1Database, nowIsoValue: string) {
  const rows = await db
    .prepare(
      `SELECT * FROM automation_definitions
       WHERE status = 'active' AND trigger_type = 'schedule' AND next_run_at IS NOT NULL
         AND next_run_at <= ?`,
    )
    .bind(nowIsoValue)
    .all();
  return (rows.results ?? []).map((row) => mapDefinition(row as Record<string, unknown>));
}

export async function claimDueAutomation(
  db: D1Database,
  input: { automationId: string; companyId: string; expectedNextRunAt: string; newNextRunAt: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE automation_definitions SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ? AND status = 'active' AND next_run_at = ?`,
    )
    .bind(input.newNextRunAt, nowIso(), input.automationId, input.companyId, input.expectedNextRunAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function recordAutomationEvent(
  db: D1Database,
  input: {
    companyId: string;
    automationId?: string | null;
    runId?: string | null;
    eventType: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO automation_events (id, company_id, automation_id, run_id, event_type, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("aue"),
      input.companyId,
      input.automationId ?? null,
      input.runId ?? null,
      input.eventType,
      input.detail ? JSON.stringify(input.detail) : null,
      nowIso(),
    )
    .run();
}
