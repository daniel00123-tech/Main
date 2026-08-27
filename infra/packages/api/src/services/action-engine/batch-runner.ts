/**
 * Resumable batch execution loop for draft invoice creation.
 */

import type { ActionPlanRecord } from "@infra/shared";
import type { Env } from "../../env";
import type { ExecutionOutcome } from "./action-executor";
import {
  BATCH_PACE_MS,
  initBatchState,
  nextBatchTargetIndex,
  updateBatchTargetState,
  validateBatchPlan,
  type BatchExecutionState,
} from "./batch-executor";
import { executeXeroActionPlan } from "./xero-write-executors";
import { updateActionPlanStatus } from "./action-engine";
import { finalizeExecution } from "./execution-store";
import { recordAuditEvent } from "../control-plane";

function pauseMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeBatchActionPlan(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const validation = validateBatchPlan(input.plan);
  if (!validation.ok) {
    return {
      ok: false,
      status: "failed",
      error: validation.message,
      code: validation.code,
    };
  }

  const existingBatch = (input.plan.metadata as { batchState?: BatchExecutionState } | undefined)?.batchState;
  let batchState = existingBatch ?? initBatchState(input.plan);
  const results: Array<{ targetId: string; ok: boolean; xeroResourceId?: string | null; error?: string }> = [];

  while (true) {
    const idx = nextBatchTargetIndex(batchState);
    if (idx < 0) break;
    if (batchState.cancelled) break;

    const target = input.plan.targets[idx]!;
    batchState = updateBatchTargetState(batchState, target.targetId, { status: "executing" });

    const singleTargetPlan: ActionPlanRecord = {
      ...input.plan,
      targets: [target],
      metadata: { ...(input.plan.metadata ?? {}), batchState },
    };

    const outcome = await executeXeroActionPlan(env, {
      plan: singleTargetPlan,
      actor: input.actor,
      executionId: `${input.executionId}_${target.targetId}`,
    });

    if (outcome.ok && "xeroResourceId" in outcome) {
      batchState = updateBatchTargetState(batchState, target.targetId, {
        status: "succeeded",
        executionId: outcome.executionId,
      });
      results.push({ targetId: target.targetId, ok: true, xeroResourceId: outcome.xeroResourceId });
    } else {
      batchState = updateBatchTargetState(batchState, target.targetId, {
        status: "failed",
        error: outcome.error,
      });
      results.push({ targetId: target.targetId, ok: false, error: outcome.error });
      break;
    }

    if (idx < input.plan.targets.length - 1) {
      await pauseMs(BATCH_PACE_MS);
    }
  }

  const allSucceeded = batchState.completedTargets === input.plan.targets.length;
  const partial = batchState.completedTargets > 0 && !allSucceeded;

  await finalizeExecution(env.DB, {
    executionId: input.executionId,
    companyId: input.plan.companyId,
    status: allSucceeded ? "succeeded" : partial ? "partial_failure" : "failed",
    verificationStatus: allSucceeded ? "verified" : "verification_failed",
    resultJson: { batchState, results },
  });

  await updateActionPlanStatus(env.DB, {
    planId: input.plan.id,
    companyId: input.plan.companyId,
    status: allSucceeded ? "completed" : partial ? "partial_failure" : "failed",
    actor: input.actor,
    detail: { batchState },
  });

  await recordAuditEvent(env.DB, {
    companyId: input.plan.companyId,
    eventType: allSucceeded ? "action_plan.completed" : "action_plan.execution_failed",
    actor: input.actor,
    resourceType: "action_execution",
    resourceId: input.executionId,
    detail: { planId: input.plan.id, batchState },
  });

  if (allSucceeded) {
    return {
      ok: true,
      status: "completed",
      executionId: input.executionId,
      xeroResourceId: results[0]?.xeroResourceId ?? null,
      humanReference: null,
      verificationStatus: "verified",
      results: { batchState, results },
    };
  }

  return {
    ok: false,
    status: partial ? "partial_failure" : "failed",
    executionId: input.executionId,
    error: partial
      ? `Batch partially completed: ${batchState.completedTargets}/${input.plan.targets.length} succeeded.`
      : "Batch execution failed.",
    code: partial ? "BATCH_PARTIAL" : "BATCH_FAILED",
    results: { batchState, results },
  };
}
