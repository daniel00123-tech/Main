import type {
  ExecutionPlanCreateInput,
  ExecutionPlanRecord,
  ExecutionPlanStatus,
} from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";

export async function findExecutionPlanByIdempotency(
  db: D1Database,
  companyId: string,
  idempotencyKey: string,
): Promise<ExecutionPlanRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM execution_plans
       WHERE company_id = ? AND idempotency_key = ?`,
    )
    .bind(companyId, idempotencyKey)
    .first();
  return row ? rowToExecutionPlan(row) : null;
}

export async function createExecutionPlan(
  db: D1Database,
  input: ExecutionPlanCreateInput,
): Promise<ExecutionPlanRecord> {
  if (input.idempotencyKey) {
    const existing = await findExecutionPlanByIdempotency(
      db,
      input.companyId,
      input.idempotencyKey,
    );
    if (existing) return existing;
  }

  const id = newId("xplan");
  const now = nowIso();
  const items = input.items.map((item) => ({
    ...item,
    status: "pending" as const,
  }));
  const payload = {
    items,
    summary: input.summary ?? null,
  };

  await db
    .prepare(
      `INSERT INTO execution_plans (
        id, company_id, connector_instance_id, provider, requested_action,
        status, idempotency_key, actor, correlation_id, interaction_id,
        payload_json, proposed_changes_json, required_approval, approval_status,
        summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId ?? null,
      input.provider ?? "xero",
      input.requestedAction,
      input.idempotencyKey ?? null,
      input.actor,
      input.correlationId ?? null,
      input.interactionId ?? null,
      JSON.stringify(payload),
      JSON.stringify({ items: input.items }),
      input.requiredApproval ? 1 : 0,
      input.requiredApproval ? "pending" : "not_required",
      input.summary ?? null,
      now,
      now,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "execution_plan.created",
    actor: input.actor,
    resourceType: "execution_plan",
    resourceId: id,
    detail: {
      provider: input.provider ?? "xero",
      action: input.requestedAction,
      itemCount: input.items.length,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  return {
    id,
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId ?? null,
    provider: input.provider ?? "xero",
    requestedAction: input.requestedAction,
    status: "draft",
    idempotencyKey: input.idempotencyKey ?? null,
    actor: input.actor,
    correlationId: input.correlationId ?? null,
    interactionId: input.interactionId ?? null,
    items,
    summary: input.summary,
    requiredApproval: Boolean(input.requiredApproval),
    approvalStatus: input.requiredApproval ? "pending" : "not_required",
    createdAt: now,
    updatedAt: now,
    executedAt: null,
  };
}

export async function updateExecutionPlanStatus(
  db: D1Database,
  input: {
    planId: string;
    companyId: string;
    status: ExecutionPlanStatus;
    result?: Record<string, unknown>;
    actor: string;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_plans
       SET status = ?, result_json = ?, updated_at = ?,
           executed_at = CASE WHEN ? IN ('completed','partial_failure','failed') THEN ? ELSE executed_at END
       WHERE id = ? AND company_id = ?`,
    )
    .bind(
      input.status,
      input.result ? JSON.stringify(input.result) : null,
      now,
      input.status,
      now,
      input.planId,
      input.companyId,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "execution_plan.updated",
    actor: input.actor,
    resourceType: "execution_plan",
    resourceId: input.planId,
    detail: { status: input.status },
  });
}

function rowToExecutionPlan(row: Record<string, unknown>): ExecutionPlanRecord {
  let payload: { items?: ExecutionPlanRecord["items"]; summary?: string } = {};
  try {
    payload = JSON.parse(String(row.payload_json ?? "{}")) as typeof payload;
  } catch {
    payload = {};
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    connectorInstanceId: row.connector_instance_id
      ? String(row.connector_instance_id)
      : null,
    provider: String(row.provider ?? "xero"),
    requestedAction: String(row.requested_action),
    status: String(row.status) as ExecutionPlanStatus,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    actor: String(row.actor),
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    interactionId: row.interaction_id ? String(row.interaction_id) : null,
    items: Array.isArray(payload.items) ? payload.items : [],
    summary: row.summary ? String(row.summary) : payload.summary,
    requiredApproval: Boolean(row.required_approval),
    approvalStatus: row.approval_status
      ? (String(row.approval_status) as ExecutionPlanRecord["approvalStatus"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    executedAt: row.executed_at ? String(row.executed_at) : null,
  };
}

export { rowToExecutionPlan };
