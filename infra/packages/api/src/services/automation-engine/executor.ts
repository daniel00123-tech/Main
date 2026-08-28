/**
 * Automation Engine execution pipeline.
 */

import type { Env } from "../../env";
import { nowIso } from "../../db/mappers";
import { getCompanyById, recordAuditEvent } from "../control-plane";
import {
  createAutomationRunStep,
  getAutomationDefinition,
  getAutomationRun,
  recordAutomationEvent,
  updateAutomationDefinition,
  updateAutomationRun,
  updateAutomationRunStep,
} from "./store";
import { executeAutomationAction } from "./actions/index";
import { AutomationActionError } from "./actions/errors";
import { recordAutomationExecutionMetering } from "./metering";
import type { AutomationRunMessage } from "./queue";

export class AutomationExecutionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AutomationExecutionError";
  }
}

export async function executeAutomationRun(env: Env, message: AutomationRunMessage): Promise<void> {
  const run = await getAutomationRun(env.DB, message.companyId, message.runId);
  if (!run) {
    throw new AutomationExecutionError("Run not found", false, "RUN_NOT_FOUND");
  }

  if (run.status === "completed" || run.status === "cancelled") {
    return;
  }

  const automation = await getAutomationDefinition(env.DB, message.companyId, message.automationId);
  if (!automation) {
    await markRunFailed(env, message, run.id, "Automation definition not found", false, "NOT_FOUND");
    return;
  }

  if (automation.status !== "active" && run.triggerType !== "manual") {
    await markRunFailed(
      env,
      message,
      run.id,
      "Automation is not active",
      false,
      "AUTOMATION_INACTIVE",
    );
    return;
  }

  const company = await getCompanyById(env.DB, message.companyId);
  if (!company) {
    await markRunFailed(env, message, run.id, "Company not found", false, "COMPANY_NOT_FOUND");
    return;
  }

  const startedAt = nowIso();
  const startMs = Date.now();

  await updateAutomationRun(env.DB, {
    companyId: message.companyId,
    runId: run.id,
    patch: { status: "running", startedAt },
  });

  await recordAuditEvent(env.DB, {
    companyId: message.companyId,
    eventType: "automation.run_started",
    actor: run.initiatedBy ?? "system:automation-engine",
    resourceType: "automation_run",
    resourceId: run.id,
    detail: {
      automationId: automation.id,
      automationName: automation.name,
      attempt: run.attempt,
      triggerType: run.triggerType,
    },
  });

  await recordAutomationEvent(env.DB, {
    companyId: message.companyId,
    automationId: automation.id,
    runId: run.id,
    eventType: "run.started",
    detail: { attempt: run.attempt },
  });

  const stepId = await createAutomationRunStep(env.DB, {
    companyId: message.companyId,
    runId: run.id,
    stepIndex: 0,
    actionType: automation.actionType,
    status: "running",
  });

  await updateAutomationRunStep(env.DB, stepId, { status: "running", startedAt });

  try {
    const actionResult = await executeAutomationAction(env, {
      companyId: message.companyId,
      companySlug: company.slug,
      automation,
      runId: run.id,
      initiatedBy: run.initiatedBy,
      serviceIdentityId: automation.serviceIdentityId,
    });

    const completedAt = nowIso();
    const durationMs = Date.now() - startMs;

    await updateAutomationRunStep(env.DB, stepId, {
      status: "completed",
      completedAt,
      result: actionResult.result,
    });

    await updateAutomationRun(env.DB, {
      companyId: message.companyId,
      runId: run.id,
      patch: {
        status: "completed",
        completedAt,
        durationMs,
        resultSummary: actionResult.summary,
        result: actionResult.result,
      },
    });

    await updateAutomationDefinition(env.DB, {
      companyId: message.companyId,
      automationId: automation.id,
      patch: {
        lastRunAt: completedAt,
        failureCount: 0,
        status: automation.status === "error" ? "active" : automation.status,
      },
    });

    await recordAuditEvent(env.DB, {
      companyId: message.companyId,
      eventType: "automation.run_completed",
      actor: run.initiatedBy ?? "system:automation-engine",
      resourceType: "automation_run",
      resourceId: run.id,
      detail: {
        automationId: automation.id,
        durationMs,
        summary: actionResult.summary.slice(0, 500),
      },
    });

    await recordAutomationEvent(env.DB, {
      companyId: message.companyId,
      automationId: automation.id,
      runId: run.id,
      eventType: "run.completed",
      detail: { durationMs, summary: actionResult.summary.slice(0, 500) },
    });

    await recordAutomationExecutionMetering(env, {
      companyId: message.companyId,
      automationId: automation.id,
      runId: run.id,
      actionType: automation.actionType,
      success: true,
      durationMs,
      meteringRecordedByGateway:
        actionResult.result.meteringRecordedByGateway === true,
      initiatedBy: run.initiatedBy,
    });
  } catch (err) {
    const completedAt = nowIso();
    const durationMs = Date.now() - startMs;
    const messageText = err instanceof Error ? err.message : "Execution failed";
    const retryable =
      err instanceof AutomationExecutionError || err instanceof AutomationActionError
        ? err.retryable
        : false;
    const errorCode =
      err instanceof AutomationExecutionError || err instanceof AutomationActionError
        ? err.code ?? "EXECUTION_FAILED"
        : "EXECUTION_FAILED";
    const failureResult =
      err instanceof AutomationActionError ? err.result ?? null : null;

    await updateAutomationRunStep(env.DB, stepId, {
      status: "failed",
      completedAt,
      errorMessage: messageText,
      result: failureResult ?? undefined,
    });

    const newFailureCount = automation.failureCount + 1;
    const exceededRetries = run.attempt >= automation.maximumRetries;

    await updateAutomationRun(env.DB, {
      companyId: message.companyId,
      runId: run.id,
      patch: {
        status: "failed",
        completedAt,
        durationMs,
        errorCode,
        errorMessage: messageText,
        result: failureResult,
      },
    });

    await updateAutomationDefinition(env.DB, {
      companyId: message.companyId,
      automationId: automation.id,
      patch: {
        failureCount: newFailureCount,
        status: exceededRetries && !retryable ? "error" : automation.status,
      },
    });

    await recordAuditEvent(env.DB, {
      companyId: message.companyId,
      eventType: "automation.run_failed",
      actor: run.initiatedBy ?? "system:automation-engine",
      resourceType: "automation_run",
      resourceId: run.id,
      detail: {
        automationId: automation.id,
        errorCode,
        errorMessage: messageText.slice(0, 500),
        attempt: run.attempt,
        retryable,
      },
    });

    await recordAutomationEvent(env.DB, {
      companyId: message.companyId,
      automationId: automation.id,
      runId: run.id,
      eventType: "run.failed",
      detail: { errorCode, errorMessage: messageText.slice(0, 500) },
    });

    await recordAutomationExecutionMetering(env, {
      companyId: message.companyId,
      automationId: automation.id,
      runId: run.id,
      actionType: automation.actionType,
      success: false,
      durationMs,
      initiatedBy: run.initiatedBy,
    });

    if (retryable && !exceededRetries) {
      throw err;
    }
  }
}

async function markRunFailed(
  env: Env,
  message: AutomationRunMessage,
  runId: string,
  errorMessage: string,
  retryable: boolean,
  errorCode: string,
): Promise<void> {
  await updateAutomationRun(env.DB, {
    companyId: message.companyId,
    runId,
    patch: {
      status: "failed",
      completedAt: nowIso(),
      errorCode,
      errorMessage,
    },
  });
  if (retryable) {
    throw new AutomationExecutionError(errorMessage, true, errorCode);
  }
}
