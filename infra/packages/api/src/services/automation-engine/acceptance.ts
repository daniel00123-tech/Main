/**
 * Automation Engine V1 acceptance — co_caddington pilot + scheduler idempotency.
 */

import type { Env } from "../../env";
import { nowIso } from "../../db/mappers";
import {
  createAutomationDefinition,
  getAutomationDefinition,
  getAutomationRun,
  listAutomationRuns,
  updateAutomationDefinition,
} from "./store";
import { requestAutomationRun } from "./run-request";
import { runAutomationScheduler, scheduleAutomationForTestSlot } from "./scheduler";
import { buildScheduleIdempotencyKey } from "./schedule";
import { executeAutomationRun } from "./executor";

const CADDINGTON_COMPANY_ID = "co_caddington";
const ACCEPTANCE_AUTOMATION_NAME = "INFRA Automation Engine Test";

export type AutomationAcceptanceResult = {
  ok: boolean;
  classification: string;
  manualTest: Record<string, unknown>;
  schedulerTest: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  errors: string[];
};

export async function runAutomationAcceptance(env: Env): Promise<AutomationAcceptanceResult> {
  const errors: string[] = [];
  const manualTest: Record<string, unknown> = {};
  const schedulerTest: Record<string, unknown> = {};
  const cleanup: Record<string, unknown> = {};

  const companyRow = await env.DB.prepare(
    `SELECT id, slug FROM companies WHERE id = ? OR slug = 'caddington' LIMIT 1`,
  )
    .bind(CADDINGTON_COMPANY_ID)
    .first<{ id: string; slug: string }>();

  if (!companyRow) {
    return {
      ok: false,
      classification: "AUTOMATION ENGINE ACCEPTANCE — COMPANY NOT FOUND",
      manualTest,
      schedulerTest,
      cleanup,
      errors: [`Company ${CADDINGTON_COMPANY_ID} not found`],
    };
  }

  const companyId = companyRow.id;

  // --- Manual AI prompt acceptance ---
  let manualAutomationId: string | null = null;
  try {
    const prompt =
      "Return a short confirmation that the INFRA automation engine executed successfully, including the execution timestamp and company context.";

    const existing = await env.DB.prepare(
      `SELECT id FROM automation_definitions WHERE company_id = ? AND name = ? LIMIT 1`,
    )
      .bind(companyId, ACCEPTANCE_AUTOMATION_NAME)
      .first<{ id: string }>();

    let automationId = existing?.id ?? null;
    if (!automationId) {
      const created = await createAutomationDefinition(env.DB, {
        companyId,
        name: ACCEPTANCE_AUTOMATION_NAME,
        description: "Non-destructive automation engine acceptance test",
        triggerType: "manual",
        actionType: "ai_prompt",
        configuration: { prompt },
        createdBy: "system:automation-acceptance",
        status: "active",
      });
      automationId = created.id;
    } else {
      await updateAutomationDefinition(env.DB, {
        companyId,
        automationId,
        patch: {
          status: "active",
          configuration: { prompt },
          triggerType: "manual",
          actionType: "ai_prompt",
        },
      });
    }
    manualAutomationId = automationId;

    const { runId } = await requestAutomationRun(env, {
      companyId,
      automationId,
      initiatedBy: "system:automation-acceptance",
      triggerType: "manual",
      idempotencyKey: `acceptance-manual|${nowIso()}`,
    });

    await executeAutomationRun(env, {
      runId,
      companyId,
      automationId,
    });

    const run = await getAutomationRun(env.DB, companyId, runId);
    manualTest.runId = runId;
    manualTest.status = run?.status;
    manualTest.resultSummary = run?.resultSummary;
    manualTest.companyId = run?.companyId;

    const audit = await env.DB.prepare(
      `SELECT event_type FROM audit_events WHERE company_id = ? AND resource_id = ? AND event_type LIKE 'automation.%' ORDER BY created_at DESC LIMIT 5`,
    )
      .bind(companyId, runId)
      .all<{ event_type: string }>();

    manualTest.auditEvents = (audit.results ?? []).map((r) => r.event_type);

    if (run?.status !== "completed") {
      errors.push(`Manual run did not complete: ${run?.status}`);
    }
    if (run?.companyId !== companyId) {
      errors.push("Manual run company context mismatch");
    }
  } catch (err) {
    errors.push(`Manual test: ${err instanceof Error ? err.message : "failed"}`);
  }

  // --- Scheduler idempotency acceptance ---
  let scheduleAutomationId: string | null = null;
  try {
    const schedule = { frequency: "hourly" as const, minute: 0 };
    const timezone = "UTC";
    const slotUtc = new Date(Date.now() - 60_000).toISOString().slice(0, 13) + ":00:00.000Z";

    const scheduleName = "INFRA Automation Scheduler Test";
    const existingSchedule = await env.DB.prepare(
      `SELECT id FROM automation_definitions WHERE company_id = ? AND name = ? LIMIT 1`,
    )
      .bind(companyId, scheduleName)
      .first<{ id: string }>();

    let automationId = existingSchedule?.id ?? null;
    if (!automationId) {
      const created = await createAutomationDefinition(env.DB, {
        companyId,
        name: scheduleName,
        triggerType: "schedule",
        schedule,
        timezone,
        actionType: "internal",
        configuration: { handler: "noop" },
        createdBy: "system:automation-acceptance",
        status: "active",
        nextRunAt: slotUtc,
      });
      automationId = created.id;
    } else {
      await updateAutomationDefinition(env.DB, {
        companyId,
        automationId,
        patch: {
          status: "active",
          schedule,
          timezone,
          actionType: "internal",
          configuration: { handler: "noop" },
          nextRunAt: slotUtc,
        },
      });
    }
    scheduleAutomationId = automationId;

    await scheduleAutomationForTestSlot(env, {
      companyId,
      automationId,
      slotUtcIso: slotUtc,
    });

    const idempotencyKey = buildScheduleIdempotencyKey(automationId, slotUtc);
    schedulerTest.slotUtc = slotUtc;
    schedulerTest.idempotencyKey = idempotencyKey;

    const first = await runAutomationScheduler(env, { now: new Date(Date.now() + 1000) });
    schedulerTest.firstScheduler = first;

    const firstRuns = await listAutomationRuns(env.DB, companyId, automationId, 10);
    const matchingRuns = firstRuns.filter((r) => r.idempotencyKey === idempotencyKey);
    schedulerTest.runsAfterFirst = matchingRuns.length;

    if (matchingRuns.length !== 1) {
      errors.push(`Expected 1 run after first scheduler pass, got ${matchingRuns.length}`);
    }

    const runId = matchingRuns[0]?.id;
    if (runId) {
      await executeAutomationRun(env, {
        runId,
        companyId,
        automationId,
      });
      const run = await getAutomationRun(env.DB, companyId, runId);
      schedulerTest.runStatus = run?.status;
    }

    const second = await runAutomationScheduler(env, { now: new Date(Date.now() + 1000) });
    schedulerTest.secondScheduler = second;

    const secondRuns = await listAutomationRuns(env.DB, companyId, automationId, 10);
    const matchingAfterSecond = secondRuns.filter((r) => r.idempotencyKey === idempotencyKey);
    schedulerTest.runsAfterSecond = matchingAfterSecond.length;

    if (matchingAfterSecond.length !== 1) {
      errors.push(
        `Duplicate scheduler created extra runs: ${matchingAfterSecond.length}`,
      );
    }

    const def = await getAutomationDefinition(env.DB, companyId, automationId);
    schedulerTest.nextRunAt = def?.nextRunAt;
    if (def?.nextRunAt && def.nextRunAt <= slotUtc) {
      errors.push("next_run_at was not advanced after claim");
    }
  } catch (err) {
    errors.push(`Scheduler test: ${err instanceof Error ? err.message : "failed"}`);
  }

  // --- Cleanup: pause test automations ---
  try {
    for (const id of [manualAutomationId, scheduleAutomationId]) {
      if (!id) continue;
      await updateAutomationDefinition(env.DB, {
        companyId,
        automationId: id,
        patch: { status: "paused" },
      });
    }
    cleanup.paused = [manualAutomationId, scheduleAutomationId].filter(Boolean);
  } catch (err) {
    cleanup.error = err instanceof Error ? err.message : "cleanup failed";
  }

  const ok = errors.length === 0;
  return {
    ok,
    classification: ok
      ? "AUTOMATION ENGINE ACCEPTANCE — PASS"
      : "AUTOMATION ENGINE ACCEPTANCE — FAIL",
    manualTest,
    schedulerTest,
    cleanup,
    errors,
  };
}
