/**
 * Canonical Automation Engine run request.
 * Used by the scheduler, portal Run now, and MCP automation_run_now.
 * Never mutates schedule, enabled/paused state, or next_run_at.
 */

import type { AutomationRunTrigger } from "@infra/shared";
import {
  isManualAutomationRunTrigger,
  normalizeAutomationRunTrigger,
} from "@infra/shared";
import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import {
  createAutomationRun,
  findActiveAutomationRun,
  findAutomationRunByIdempotencyKey,
  getAutomationDefinition,
  recordAutomationEvent,
} from "./store";
import {
  enqueueAutomationRun,
  hasAutomationRunQueue,
  processAutomationRunJob,
} from "./queue";

export type AutomationEngineTrigger = AutomationRunTrigger;

export type RequestAutomationRunInput = {
  companyId: string;
  automationId: string;
  initiatedBy: string;
  triggerType: AutomationEngineTrigger;
  idempotencyKey?: string | null;
};

export type RequestAutomationRunResult = {
  runId: string;
  created: boolean;
  status: string;
  trigger: AutomationEngineTrigger;
  automationId: string;
  automationName: string;
  scheduledFor: null;
  scheduleChanged: false;
  reusedExisting: boolean;
};

export async function requestAutomationRun(
  env: Env,
  input: RequestAutomationRunInput,
): Promise<RequestAutomationRunResult> {
  const triggerType = normalizeAutomationRunTrigger(input.triggerType);
  const automation = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!automation) {
    throw new Error("Automation not found");
  }

  if (automation.status === "disabled") {
    throw new Error("Automation is disabled");
  }

  if (isManualAutomationRunTrigger(triggerType)) {
    if (!["active", "paused", "draft", "error"].includes(automation.status)) {
      throw new Error("Automation cannot be run in current status");
    }
  }

  if (input.idempotencyKey) {
    const existing = await findAutomationRunByIdempotencyKey(
      env.DB,
      input.companyId,
      input.automationId,
      input.idempotencyKey,
    );
    if (existing) {
      return present(
        existing.id,
        existing.status,
        normalizeAutomationRunTrigger(existing.triggerType),
        automation.id,
        automation.name,
        false,
        true,
      );
    }
  }

  const active = await findActiveAutomationRun(env.DB, input.companyId, input.automationId);
  if (active) {
    return present(
      active.id,
      active.status,
      normalizeAutomationRunTrigger(active.triggerType),
      automation.id,
      automation.name,
      false,
      true,
    );
  }

  const { run, created } = await createAutomationRun(env.DB, {
    companyId: input.companyId,
    automationId: input.automationId,
    triggerType,
    idempotencyKey: input.idempotencyKey ?? null,
    initiatedBy: input.initiatedBy,
  });

  if (created) {
    await afterCreate(env, {
      companyId: input.companyId,
      automationId: automation.id,
      runId: run.id,
      initiatedBy: input.initiatedBy,
      triggerType,
    });
  }

  return present(
    run.id,
    run.status,
    triggerType,
    automation.id,
    automation.name,
    created,
    !created,
  );
}

function present(
  runId: string,
  status: string,
  trigger: AutomationEngineTrigger,
  automationId: string,
  automationName: string,
  created: boolean,
  reusedExisting: boolean,
): RequestAutomationRunResult {
  return {
    runId,
    created,
    status,
    trigger,
    automationId,
    automationName,
    scheduledFor: null,
    scheduleChanged: false,
    reusedExisting,
  };
}

async function afterCreate(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    runId: string;
    initiatedBy: string;
    triggerType: AutomationEngineTrigger;
  },
) {
  const manual = isManualAutomationRunTrigger(input.triggerType);
  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: manual ? "automation.manual_run_requested" : "automation.scheduled_run_created",
    actor: input.initiatedBy,
    resourceType: "automation",
    resourceId: input.automationId,
    detail: { runId: input.runId, triggerType: input.triggerType },
  });

  await recordAutomationEvent(env.DB, {
    companyId: input.companyId,
    automationId: input.automationId,
    runId: input.runId,
    eventType: manual ? "manual_run.requested" : "schedule.run_created",
    detail: { triggerType: input.triggerType },
  });

  const message = {
    runId: input.runId,
    companyId: input.companyId,
    automationId: input.automationId,
  };

  const enqueued = hasAutomationRunQueue(env)
    ? await enqueueAutomationRun(env, message)
    : false;

  if (!enqueued) {
    // The automation-runs queue is not bound in production. Public
    // workers.dev self-fetch is blocked (Cloudflare 1042), so process
    // in-request through the same executor the queue consumer uses.
    await processAutomationRunJob(env, message);
  }
}
