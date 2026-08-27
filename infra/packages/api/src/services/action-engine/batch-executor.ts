/**
 * Bounded batch execution with resumable per-target state.
 */

import type { ActionPlanRecord } from "@infra/shared";
import { ACTION_PLAN_MAX_BATCH_ITEMS } from "@infra/shared";

export const BATCH_MAX_DRAFT_INVOICES = 10;
export const BATCH_PACE_MS = 2500;

export type BatchTargetStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

export type BatchExecutionState = {
  batchId: string;
  planId: string;
  totalTargets: number;
  completedTargets: number;
  failedTargets: number;
  targetStates: Array<{
    targetId: string;
    status: BatchTargetStatus;
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
  const blocked = new Set([
    "xero.payments.allocate",
    "xero.credit_notes.allocate",
    "xero.invoice.void",
    "xero.bill.void",
    "xero.credit_note.void",
    "xero.invoices.send",
    "xero.invoices.approve",
    "xero.bills.approve",
    "xero.credit_notes.approve",
  ]);
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

export function parseBatchState(raw: unknown): BatchExecutionState | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as BatchExecutionState;
  if (!state.planId || !Array.isArray(state.targetStates)) return null;
  return state;
}

/** Resume from first pending/failed target — never repeats succeeded targets. */
export function nextBatchTargetIndex(state: BatchExecutionState): number {
  return state.targetStates.findIndex(
    (t) => t.status === "pending" || t.status === "failed" || t.status === "stale",
  );
}

export function updateBatchTargetState(
  state: BatchExecutionState,
  targetId: string,
  update: Partial<BatchExecutionState["targetStates"][number]>,
): BatchExecutionState {
  const targetStates = state.targetStates.map((t) =>
    t.targetId === targetId ? { ...t, ...update } : t,
  );
  const completedTargets = targetStates.filter((t) => t.status === "succeeded").length;
  const failedTargets = targetStates.filter((t) => t.status === "failed").length;
  return { ...state, targetStates, completedTargets, failedTargets };
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

export function isBatchPlan(plan: ActionPlanRecord): boolean {
  return plan.targets.length > 1 && plan.requestedAction === "xero.invoices.create";
}
