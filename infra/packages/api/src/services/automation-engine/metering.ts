/**
 * Automation Engine metering — avoids double-charging when gateway already records usage.
 */

import type { Env } from "../../env";
import { recordUsageEvent } from "../usage";
import type { AutomationActionType } from "@infra/shared";

export async function recordAutomationExecutionMetering(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    runId: string;
    actionType: AutomationActionType;
    success: boolean;
    durationMs: number;
    meteringRecordedByGateway?: boolean;
    initiatedBy?: string | null;
  },
): Promise<void> {
  if (input.actionType === "mcp_tool" && input.meteringRecordedByGateway) {
    return;
  }

  await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    actorEmail: input.initiatedBy ?? "system:automation-engine",
    resourceType: "automation",
    resourceId: input.automationId,
    action: `automation.${input.actionType}`,
    quantity: 1,
    unit: "execution",
    success: input.success,
    durationMs: input.durationMs,
    sourceClient: "automation-engine",
    correlationId: input.runId,
    requestId: `automation_run_${input.runId}`,
    metadata: {
      runId: input.runId,
      actionType: input.actionType,
    },
  });
}
