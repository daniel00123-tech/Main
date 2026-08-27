import type { ActionPlanRecord } from "@infra/shared";
import { xeroActionDefinition } from "@infra/shared";
import type { Env } from "../../env";
import { recordUsageEvent } from "../usage";

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

  await recordUsageEvent(env.DB, {
    companyId: input.plan.companyId,
    action: billingAction,
    actorEmail: input.actor,
    resourceType: "action_execution",
    resourceId: input.executionId,
    connectorInstanceId: input.plan.connectorInstanceId,
    riskClass: input.plan.riskClass,
    success: input.success,
    correlationId: input.plan.correlationId ?? null,
    interactionId: input.plan.interactionId ?? null,
    requestId: `aex_${input.executionId}`,
    sourceClient: input.plan.sourceClient ?? "action-engine",
    metadata: {
      planId: input.plan.id,
      executionId: input.executionId,
      requestedAction: input.plan.requestedAction,
      amount: input.amount ?? null,
      currencyCode: input.currencyCode ?? null,
      ...(input.metadata ?? {}),
    },
  });
}
