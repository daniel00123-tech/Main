import type { ActionExecutionRecord, ActionExecutionStatus, ActionVerificationStatus } from "@infra/shared";
import { newId, nowIso } from "../../db/mappers";

export function executionKeyForPlan(planId: string): string {
  return `plan:${planId}`;
}

function parseResultJson(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function rowToActionExecution(row: Record<string, unknown>): ActionExecutionRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    companyId: String(row.company_id),
    executionKey: String(row.execution_key),
    provider: String(row.provider ?? "xero"),
    requestedAction: String(row.requested_action),
    status: String(row.status) as ActionExecutionStatus,
    verificationStatus: row.verification_status
      ? (String(row.verification_status) as ActionVerificationStatus)
      : null,
    xeroResourceId: row.xero_resource_id ? String(row.xero_resource_id) : null,
    humanReference: row.human_reference ? String(row.human_reference) : null,
    amount: row.amount != null ? Number(row.amount) : null,
    currencyCode: row.currency_code ? String(row.currency_code) : null,
    resultJson: parseResultJson(row.result_json),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getExecutionByPlanId(
  db: D1Database,
  companyId: string,
  planId: string,
): Promise<ActionExecutionRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM action_executions WHERE plan_id = ? AND company_id = ?`)
    .bind(planId, companyId)
    .first();
  return row ? rowToActionExecution(row as Record<string, unknown>) : null;
}

export type ClaimExecutionResult =
  | { ok: true; claimed: true; execution: ActionExecutionRecord }
  | { ok: true; claimed: false; execution: ActionExecutionRecord; reason: string }
  | { ok: false; code: string; message: string };

/**
 * Atomically claim execution for a plan. Only one financial mutation attempt per plan.
 * Parallel confirmations receive the existing record — never a second Xero write.
 */
export async function claimExecution(
  db: D1Database,
  input: {
    planId: string;
    companyId: string;
    requestedAction: string;
    provider?: string;
  },
): Promise<ClaimExecutionResult> {
  const existing = await getExecutionByPlanId(db, input.companyId, input.planId);
  if (existing) {
    if (existing.status === "executing") {
      return { ok: true, claimed: false, execution: existing, reason: "EXECUTION_IN_PROGRESS" };
    }
    if (existing.status === "succeeded") {
      return { ok: true, claimed: false, execution: existing, reason: "ALREADY_SUCCEEDED" };
    }
    if (existing.status === "uncertain") {
      return { ok: true, claimed: false, execution: existing, reason: "EXECUTION_UNCERTAIN" };
    }
    if (existing.status === "failed") {
      return { ok: true, claimed: false, execution: existing, reason: "ALREADY_FAILED" };
    }
  }

  const id = newId("aex");
  const now = nowIso();
  const executionKey = executionKeyForPlan(input.planId);

  try {
    await db
      .prepare(
        `INSERT INTO action_executions (
          id, plan_id, company_id, execution_key, provider, requested_action,
          status, verification_status, created_at, updated_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'executing', 'pending', ?, ?, ?)`,
      )
      .bind(
        id,
        input.planId,
        input.companyId,
        executionKey,
        input.provider ?? "xero",
        input.requestedAction,
        now,
        now,
        now,
      )
      .run();
  } catch {
    const raced = await getExecutionByPlanId(db, input.companyId, input.planId);
    if (raced) {
      return {
        ok: true,
        claimed: false,
        execution: raced,
        reason: raced.status === "executing" ? "EXECUTION_IN_PROGRESS" : "ALREADY_CLAIMED",
      };
    }
    return { ok: false, code: "EXECUTION_CLAIM_FAILED", message: "Unable to claim execution." };
  }

  const execution = await getExecutionByPlanId(db, input.companyId, input.planId);
  if (!execution) {
    return { ok: false, code: "EXECUTION_CLAIM_FAILED", message: "Execution record missing after claim." };
  }
  return { ok: true, claimed: true, execution };
}

export async function finalizeExecution(
  db: D1Database,
  input: {
    executionId: string;
    companyId: string;
    status: ActionExecutionStatus;
    verificationStatus?: ActionVerificationStatus;
    xeroResourceId?: string | null;
    humanReference?: string | null;
    amount?: number | null;
    currencyCode?: string | null;
    resultJson?: Record<string, unknown> | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE action_executions
       SET status = ?, verification_status = ?, xero_resource_id = ?, human_reference = ?,
           amount = ?, currency_code = ?, result_json = ?, error_code = ?, error_message = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(
      input.status,
      input.verificationStatus ?? null,
      input.xeroResourceId ?? null,
      input.humanReference ?? null,
      input.amount ?? null,
      input.currencyCode ?? null,
      input.resultJson ? JSON.stringify(input.resultJson) : null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      now,
      now,
      input.executionId,
      input.companyId,
    )
    .run();
}
