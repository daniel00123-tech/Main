import type { ActionPlanRecord } from "@infra/shared";
import { xeroActionDefinition } from "@infra/shared";
import type { Env } from "../../env";
import { settleActionExecutionUsage } from "./action-settlement";

/** Record commercial usage once per successful execution — idempotent via requestId. */
export async function recordActionExecutionUsage(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    executionId: string;
    actor: string;
    success: boolean;
    amount?: number | null;
    currencyCode?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const def = xeroActionDefinition(input.plan.requestedAction);
  const billingAction = def?.billingOperation ?? input.plan.requestedAction;
  if (!billingAction) return;

  await settleActionExecutionUsage(env, {
    companyId: input.plan.companyId,
    action: billingAction,
    actor: input.actor,
    executionId: input.executionId,
    planId: input.plan.id,
    connectorInstanceId: input.plan.connectorInstanceId,
    riskClass: input.plan.riskClass,
    success: input.success,
    correlationId: input.plan.correlationId ?? null,
    interactionId: input.plan.interactionId ?? null,
    sourceClient: input.plan.sourceClient ?? "action-engine",
    metadata: {
      requestedAction: input.plan.requestedAction,
      amount: input.amount ?? null,
      currencyCode: input.currencyCode ?? null,
      ...(input.metadata ?? {}),
    },
  });
}
