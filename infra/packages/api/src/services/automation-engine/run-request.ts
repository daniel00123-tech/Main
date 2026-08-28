/**
 * Shared automation run request — used by manual run API and scheduler.
 */

import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { createAutomationRun, getAutomationDefinition, recordAutomationEvent } from "./store";
import {
  enqueueAutomationRun,
  hasAutomationRunQueue,
  kickAutomationRunProcessor,
} from "./queue";

export async function requestAutomationRun(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    initiatedBy: string;
    triggerType: "manual" | "schedule";
    idempotencyKey?: string | null;
  },
): Promise<{ runId: string; created: boolean; status: string }> {
  const automation = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!automation) {
    throw new Error("Automation not found");
  }

  if (input.triggerType === "manual" && automation.triggerType === "schedule") {
    // Manual run allowed for scheduled automations
  } else if (input.triggerType === "manual" && automation.triggerType !== "manual") {
    // Also allow manual trigger type automations
  }

  if (automation.status === "disabled") {
    throw new Error("Automation is disabled");
  }

  if (input.triggerType === "manual" && !["active", "paused", "draft", "error"].includes(automation.status)) {
    throw new Error("Automation cannot be run in current status");
  }

  const { run, created } = await createAutomationRun(env.DB, {
    companyId: input.companyId,
    automationId: input.automationId,
    triggerType: input.triggerType,
    idempotencyKey: input.idempotencyKey ?? null,
    initiatedBy: input.initiatedBy,
  });

  if (created) {
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType:
        input.triggerType === "manual"
          ? "automation.manual_run_requested"
          : "automation.scheduled_run_created",
      actor: input.initiatedBy,
      resourceType: "automation",
      resourceId: automation.id,
      detail: { runId: run.id, triggerType: input.triggerType },
    });

    await recordAutomationEvent(env.DB, {
      companyId: input.companyId,
      automationId: automation.id,
      runId: run.id,
      eventType: input.triggerType === "manual" ? "manual_run.requested" : "schedule.run_created",
    });

    const message = {
      runId: run.id,
      companyId: input.companyId,
      automationId: input.automationId,
    };

    const enqueued = hasAutomationRunQueue(env)
      ? await enqueueAutomationRun(env, message)
      : false;

    if (!enqueued) {
      await kickAutomationRunProcessor(
        env,
        run.id,
        input.companyId,
        input.automationId,
      );
    }
  }

  return { runId: run.id, created, status: run.status };
}
