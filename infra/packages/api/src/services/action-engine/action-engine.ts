import type {
  ActionPlanCreateInput,
  ActionPlanRecord,
  ActionPlanStatus,
  ActionTarget,
  ApprovalStatus,
  ConfirmationStatus,
  FinancialImpact,
  PermissionDecision,
} from "@infra/shared";
import { ACTION_PLAN_DEFAULT_TTL_MINUTES } from "@infra/shared";
import { newId, nowIso } from "../../db/mappers";
import { recordAuditEvent } from "../control-plane";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprintTargets(targets: ActionTarget[]): Promise<string> {
  const payload = targets.map((target) => ({
    targetId: target.targetId,
    targetType: target.targetType,
    humanRef: target.humanRef,
    amount: target.amount ?? null,
    validation: target.validation,
    proposed: target.proposedState,
  }));
  return sha256Hex(JSON.stringify(payload));
}

async function hashConfirmationToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function generateConfirmationToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function findActionPlanByIdempotency(
  db: D1Database,
  companyId: string,
  idempotencyKey: string,
): Promise<ActionPlanRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM execution_plans
       WHERE company_id = ? AND idempotency_key = ?`,
    )
    .bind(companyId, idempotencyKey)
    .first();
  return row ? rowToActionPlan(row) : null;
}

export async function getActionPlan(
  db: D1Database,
  companyId: string,
  planId: string,
): Promise<ActionPlanRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM execution_plans WHERE id = ? AND company_id = ?`)
    .bind(planId, companyId)
    .first();
  return row ? rowToActionPlan(row) : null;
}

export async function listActionPlans(
  db: D1Database,
  companyId: string,
  input?: { status?: ActionPlanStatus[]; limit?: number },
): Promise<ActionPlanRecord[]> {
  const limit = Math.min(Math.max(1, input?.limit ?? 50), 100);
  const rows = await db
    .prepare(
      `SELECT * FROM execution_plans
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(companyId, limit)
    .all();
  const plans = (rows.results ?? []).map((row) => rowToActionPlan(row as Record<string, unknown>));
  if (!input?.status?.length) return plans;
  const allowed = new Set(input.status);
  return plans.filter((plan) => allowed.has(plan.status));
}

export async function createActionPlan(
  db: D1Database,
  input: ActionPlanCreateInput,
): Promise<{ plan: ActionPlanRecord; confirmationToken: string | null }> {
  if (input.idempotencyKey) {
    const existing = await findActionPlanByIdempotency(db, input.companyId, input.idempotencyKey);
    if (existing) return { plan: existing, confirmationToken: null };
  }

  const id = newId("act");
  const now = nowIso();
  const expiresAt = new Date(
    Date.now() + (input.expiresInMinutes ?? ACTION_PLAN_DEFAULT_TTL_MINUTES) * 60_000,
  ).toISOString();
  const planFingerprint = await fingerprintTargets(input.targets);
  const confirmationToken = input.permissionDecision.requiresConfirmation
    ? generateConfirmationToken()
    : null;
  const confirmationStatus: ConfirmationStatus = input.permissionDecision.requiresConfirmation
    ? "awaiting"
    : "not_required";
  const approvalStatus: ApprovalStatus = input.permissionDecision.requiresApproval
    ? "pending"
    : "not_required";
  const initialStatus: ActionPlanStatus = input.permissionDecision.requiresConfirmation
    ? "awaiting_confirmation"
    : input.permissionDecision.requiresApproval
      ? "awaiting_approval"
      : "validated";

  const payload = {
    targets: input.targets,
    summary: input.summary ?? null,
  };

  await db
    .prepare(
      `INSERT INTO execution_plans (
        id, company_id, connector_instance_id, provider, requested_action,
        status, idempotency_key, actor, correlation_id, interaction_id,
        payload_json, proposed_changes_json, required_approval, approval_status,
        summary, created_at, updated_at,
        risk_class, source_client, permission_decision_json, financial_impact_json,
        confirmation_status, confirmation_token_hash, plan_fingerprint, state_version, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId ?? null,
      input.provider ?? "xero",
      input.requestedAction,
      initialStatus,
      input.idempotencyKey ?? null,
      input.actor,
      input.correlationId ?? null,
      input.interactionId ?? null,
      JSON.stringify(payload),
      JSON.stringify({ targets: input.targets }),
      input.permissionDecision.requiresApproval ? 1 : 0,
      approvalStatus,
      input.summary ?? null,
      now,
      now,
      input.riskClass,
      input.sourceClient ?? null,
      JSON.stringify(input.permissionDecision),
      input.financialImpact ? JSON.stringify(input.financialImpact) : null,
      confirmationStatus,
      confirmationToken ? await hashConfirmationToken(confirmationToken) : null,
      planFingerprint,
      expiresAt,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "action_plan.created",
    actor: input.actor,
    resourceType: "action_plan",
    resourceId: id,
    detail: {
      action: input.requestedAction,
      provider: input.provider ?? "xero",
      targetCount: input.targets.length,
      status: initialStatus,
      permission: input.permissionDecision.reasonCode,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  const plan = await getActionPlan(db, input.companyId, id);
  if (!plan) throw new Error("Failed to load created action plan");
  return { plan, confirmationToken };
}

export async function confirmActionPlan(
  db: D1Database,
  input: {
    companyId: string;
    planId: string;
    actor: string;
    confirmationToken?: string | null;
  },
): Promise<
  | { ok: true; plan: ActionPlanRecord; executionBlocked: boolean; blockReason?: string }
  | { ok: false; code: string; message: string }
> {
  const plan = await getActionPlan(db, input.companyId, input.planId);
  if (!plan) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };
  if (plan.status === "cancelled") {
    return { ok: false, code: "PLAN_CANCELLED", message: "Action plan was cancelled." };
  }
  if (plan.status === "expired" || isExpired(plan)) {
    await updateActionPlanStatus(db, {
      planId: plan.id,
      companyId: plan.companyId,
      status: "expired",
      actor: input.actor,
    });
    return { ok: false, code: "PLAN_EXPIRED", message: "Action plan has expired." };
  }
  if (plan.confirmationStatus === "confirmed") {
    return {
      ok: true,
      plan,
      executionBlocked: !FINANCIAL_WRITES_ENABLED,
      blockReason: FINANCIAL_WRITES_ENABLED ? undefined : "FINANCIAL_WRITES_DISABLED",
    };
  }

  const row = await db
    .prepare(`SELECT confirmation_token_hash FROM execution_plans WHERE id = ? AND company_id = ?`)
    .bind(input.planId, input.companyId)
    .first();
  const expectedHash = row?.confirmation_token_hash ? String(row.confirmation_token_hash) : null;
  if (expectedHash) {
    const provided = input.confirmationToken?.trim();
    if (!provided || (await hashConfirmationToken(provided)) !== expectedHash) {
      return { ok: false, code: "CONFIRMATION_INVALID", message: "Invalid confirmation token." };
    }
  }

  const now = nowIso();
  let nextStatus: ActionPlanStatus = plan.approvalStatus === "pending" ? "awaiting_approval" : "approved";
  await db
    .prepare(
      `UPDATE execution_plans
       SET confirmation_status = 'confirmed', confirmed_at = ?, confirmed_by = ?,
           status = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(now, input.actor, nextStatus, now, input.planId, input.companyId)
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "action_plan.confirmed",
    actor: input.actor,
    resourceType: "action_plan",
    resourceId: input.planId,
    detail: { nextStatus },
  });

  const updated = await getActionPlan(db, input.companyId, input.planId);
  if (!updated) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };

  if (!FINANCIAL_WRITES_ENABLED) {
    return {
      ok: true,
      plan: updated,
      executionBlocked: true,
      blockReason: "FINANCIAL_WRITES_DISABLED",
    };
  }

  return { ok: true, plan: updated, executionBlocked: false };
}

export async function cancelActionPlan(
  db: D1Database,
  input: { companyId: string; planId: string; actor: string; reason?: string },
): Promise<ActionPlanRecord | null> {
  const plan = await getActionPlan(db, input.companyId, input.planId);
  if (!plan) return null;
  await updateActionPlanStatus(db, {
    planId: input.planId,
    companyId: input.companyId,
    status: "cancelled",
    actor: input.actor,
    detail: { reason: input.reason ?? null },
  });
  return getActionPlan(db, input.companyId, input.planId);
}

export async function approveActionPlan(
  db: D1Database,
  input: { companyId: string; planId: string; actor: string; approverRole?: string },
): Promise<
  | { ok: true; plan: ActionPlanRecord }
  | { ok: false; code: string; message: string }
> {
  const plan = await getActionPlan(db, input.companyId, input.planId);
  if (!plan) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };
  if (plan.approvalStatus !== "pending" && plan.status !== "awaiting_approval") {
    return { ok: false, code: "APPROVAL_NOT_REQUIRED", message: "Plan does not require approval." };
  }
  if (plan.actor === input.actor) {
    return { ok: false, code: "SELF_APPROVAL_DENIED", message: "Requester cannot approve their own action." };
  }
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_plans
       SET approval_status = 'approved', status = 'approved', updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(now, input.planId, input.companyId)
    .run();
  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "action_plan.approved",
    actor: input.actor,
    resourceType: "action_plan",
    resourceId: input.planId,
    detail: { approverRole: input.approverRole ?? null },
  });
  const updated = await getActionPlan(db, input.companyId, input.planId);
  if (!updated) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };
  return { ok: true, plan: updated };
}

export async function rejectActionPlan(
  db: D1Database,
  input: { companyId: string; planId: string; actor: string; reason?: string },
): Promise<
  | { ok: true; plan: ActionPlanRecord }
  | { ok: false; code: string; message: string }
> {
  const plan = await getActionPlan(db, input.companyId, input.planId);
  if (!plan) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };
  await updateActionPlanStatus(db, {
    planId: input.planId,
    companyId: input.companyId,
    status: "rejected",
    actor: input.actor,
    detail: { reason: input.reason ?? null },
  });
  await db
    .prepare(
      `UPDATE execution_plans SET approval_status = 'denied', updated_at = ? WHERE id = ? AND company_id = ?`,
    )
    .bind(nowIso(), input.planId, input.companyId)
    .run();
  const updated = await getActionPlan(db, input.companyId, input.planId);
  if (!updated) return { ok: false, code: "PLAN_NOT_FOUND", message: "Action plan not found." };
  return { ok: true, plan: updated };
}

export function isPlanStale(
  plan: ActionPlanRecord,
  liveFingerprint: string,
): boolean {
  return Boolean(plan.planFingerprint && plan.planFingerprint !== liveFingerprint);
}

export async function markPlanStale(
  db: D1Database,
  input: { companyId: string; planId: string; actor: string },
): Promise<void> {
  await updateActionPlanStatus(db, {
    planId: input.planId,
    companyId: input.companyId,
    status: "plan_stale",
    actor: input.actor,
  });
}

export async function updateActionPlanStatus(
  db: D1Database,
  input: {
    planId: string;
    companyId: string;
    status: ActionPlanStatus;
    actor: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_plans
       SET status = ?, updated_at = ?,
           executed_at = CASE WHEN ? IN ('completed','partial_failure','failed','execution_uncertain') THEN ? ELSE executed_at END
       WHERE id = ? AND company_id = ?`,
    )
    .bind(input.status, now, input.status, now, input.planId, input.companyId)
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "action_plan.updated",
    actor: input.actor,
    resourceType: "action_plan",
    resourceId: input.planId,
    detail: { status: input.status, ...(input.detail ?? {}) },
  });
}

function isExpired(plan: ActionPlanRecord): boolean {
  if (!plan.expiresAt) return false;
  return Date.parse(plan.expiresAt) <= Date.now();
}

function rowToActionPlan(row: Record<string, unknown>): ActionPlanRecord {
  let payload: { targets?: ActionTarget[]; summary?: string } = {};
  try {
    payload = JSON.parse(String(row.payload_json ?? "{}")) as typeof payload;
  } catch {
    payload = {};
  }
  let permissionDecision: PermissionDecision | null = null;
  try {
    permissionDecision = row.permission_decision_json
      ? (JSON.parse(String(row.permission_decision_json)) as PermissionDecision)
      : null;
  } catch {
    permissionDecision = null;
  }
  let financialImpact: FinancialImpact | null = null;
  try {
    financialImpact = row.financial_impact_json
      ? (JSON.parse(String(row.financial_impact_json)) as FinancialImpact)
      : null;
  } catch {
    financialImpact = null;
  }

  const legacyItems = Array.isArray(payload.targets)
    ? payload.targets
    : (() => {
        try {
          const proposed = JSON.parse(String(row.proposed_changes_json ?? "{}")) as {
            items?: ActionTarget[];
            targets?: ActionTarget[];
          };
          return proposed.targets ?? proposed.items ?? [];
        } catch {
          return [];
        }
      })();

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    connectorInstanceId: row.connector_instance_id ? String(row.connector_instance_id) : null,
    provider: String(row.provider ?? "xero"),
    requestedAction: String(row.requested_action),
    status: String(row.status) as ActionPlanStatus,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    actor: String(row.actor),
    sourceClient: row.source_client ? String(row.source_client) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    interactionId: row.interaction_id ? String(row.interaction_id) : null,
    targets: legacyItems,
    summary: row.summary ? String(row.summary) : payload.summary ?? null,
    financialImpact,
    permissionDecision,
    riskClass: (row.risk_class ? String(row.risk_class) : "financial_action") as ActionPlanRecord["riskClass"],
    confirmationStatus: (row.confirmation_status
      ? String(row.confirmation_status)
      : "not_required") as ConfirmationStatus,
    approvalStatus: (row.approval_status
      ? String(row.approval_status)
      : "not_required") as ApprovalStatus,
    planFingerprint: row.plan_fingerprint ? String(row.plan_fingerprint) : null,
    stateVersion: Number(row.state_version ?? 1),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    executedAt: row.executed_at ? String(row.executed_at) : null,
  };
}

export { rowToActionPlan, fingerprintTargets };
