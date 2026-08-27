/**
 * Bounded batch execution foundation for Action Engine.
 * Max 10 draft invoices per batch initially; money/destructive excluded.
 */

import type { ActionPlanRecord } from "@infra/shared";
import { ACTION_PLAN_MAX_BATCH_ITEMS } from "@infra/shared";

export const BATCH_MAX_DRAFT_INVOICES = 10;
export const BATCH_PACE_MS = 2500;

export type BatchExecutionState = {
  batchId: string;
  planId: string;
  totalTargets: number;
  completedTargets: number;
  failedTargets: number;
  targetStates: Array<{
    targetId: string;
    status: "pending" | "completed" | "failed" | "skipped" | "cancelled";
    executionId?: string;
    error?: string;
  }>;
  cancelled: boolean;
};

export function validateBatchPlan(plan: ActionPlanRecord): { ok: true } | { ok: false; code: string; message: string } {
  if (plan.targets.length > ACTION_PLAN_MAX_BATCH_ITEMS) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      message: `Batch exceeds maximum of ${ACTION_PLAN_MAX_BATCH_ITEMS} items.`,
    };
  }
  if (plan.requestedAction === "xero.invoices.create" && plan.targets.length > BATCH_MAX_DRAFT_INVOICES) {
    return {
      ok: false,
      code: "BATCH_LIMIT_EXCEEDED",
      message: `Draft invoice batches are limited to ${BATCH_MAX_DRAFT_INVOICES} items.`,
    };
  }
  const blocked = new Set(["xero.payments.allocate", "xero.invoice.void", "xero.bill.void", "xero.invoices.send"]);
  if (blocked.has(plan.requestedAction)) {
    return { ok: false, code: "BATCH_NOT_ALLOWED", message: "This action type cannot be executed in bulk." };
  }
  return { ok: true };
}

export function initBatchState(plan: ActionPlanRecord): BatchExecutionState {
  return {
    batchId: `batch_${plan.id}`,
    planId: plan.id,
    totalTargets: plan.targets.length,
    completedTargets: 0,
    failedTargets: 0,
    targetStates: plan.targets.map((t) => ({ targetId: t.targetId, status: "pending" as const })),
    cancelled: false,
  };
}

export function aggregateBatchFinancialImpact(plan: ActionPlanRecord): {
  itemCount: number;
  totalAmount: number | null;
  currencyCode: string | null;
} {
  let total = 0;
  let hasAmount = false;
  for (const t of plan.targets) {
    if (t.amount != null) {
      total += t.amount;
      hasAmount = true;
    }
  }
  return {
    itemCount: plan.targets.length,
    totalAmount: hasAmount ? total : null,
    currencyCode: plan.financialImpact?.currencyCode ?? plan.targets[0]?.currencyCode ?? null,
  };
}
