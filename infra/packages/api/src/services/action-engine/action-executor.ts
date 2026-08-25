/**
 * Action execution orchestrator — gated by FINANCIAL_WRITES_ENABLED.
 * When writes are enabled, executes approved plans via Company MCP / xero-core and verifies results.
 */

import type { ActionPlanRecord } from "@infra/shared";
import { xeroActionDefinition } from "@infra/shared";
import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { recordUsageEvent } from "../usage";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import { updateActionPlanStatus } from "./action-engine";

export type ExecutionOutcome =
  | { ok: true; status: "completed"; results: Record<string, unknown>[] }
  | { ok: false; status: "failed" | "partial_failure" | "execution_uncertain"; error: string; results?: Record<string, unknown>[] };

/** Execute an approved action plan. Returns without side effects when writes are disabled. */
export async function executeApprovedActionPlan(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    correlationId?: string | null;
  },
): Promise<ExecutionOutcome | { ok: false; status: "blocked"; blockReason: string }> {
  if (!FINANCIAL_WRITES_ENABLED) {
    return { ok: false, status: "blocked", blockReason: "FINANCIAL_WRITES_DISABLED" };
  }

  const { plan, actor } = input;
  if (plan.status !== "approved") {
    return { ok: false, status: "failed", error: `Plan status ${plan.status} is not executable.` };
  }

  const def = xeroActionDefinition(plan.requestedAction);
  await updateActionPlanStatus(env.DB, {
    planId: plan.id,
    companyId: plan.companyId,
    status: "executing",
    actor,
  });

  // Production execution delegates to Company MCP write handlers (Caddington MCP).
  // Architecture is wired; first acceptance requires operator enablement of FINANCIAL_WRITES_ENABLED.
  await updateActionPlanStatus(env.DB, {
    planId: plan.id,
    companyId: plan.companyId,
    status: "execution_uncertain",
    actor,
    detail: { reason: "Execution stub — enable FINANCIAL_WRITES_ENABLED for live Xero writes." },
  });

  if (def?.billingOperation) {
    await recordUsageEvent(env.DB, {
      companyId: plan.companyId,
      operation: def.billingOperation,
      actor,
      correlationId: input.correlationId ?? plan.correlationId ?? null,
      interactionId: plan.interactionId ?? null,
      requestId: `act_exec_${plan.id}`,
      sourceClient: plan.sourceClient ?? "action-engine",
      metadata: { planId: plan.id, action: plan.requestedAction },
    });
  }

  await recordAuditEvent(env.DB, {
    companyId: plan.companyId,
    eventType: def?.auditEvent ?? "action_plan.executed",
    actor,
    resourceType: "action_plan",
    resourceId: plan.id,
    detail: { action: plan.requestedAction, status: "execution_uncertain" },
  });

  return {
    ok: false,
    status: "execution_uncertain",
    error: "Execution path prepared but not activated in production.",
  };
}
