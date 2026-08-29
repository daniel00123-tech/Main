/**
 * Automation scheduler — single cron scans all due automations.
 */

import type { Env } from "../../env";
import { nowIso } from "../../db/mappers";
import {
  buildScheduleIdempotencyKey,
  computeNextRunUtcIso,
  currentScheduleSlotUtcIso,
} from "./schedule";
import { claimDueAutomation, findActiveAutomationRun, listDueAutomations } from "./store";
import { requestAutomationRun } from "./run-request";

export type AutomationSchedulerResult = {
  scanned: number;
  claimed: number;
  enqueued: number;
  skippedDuplicate: number;
  errors: string[];
};

export async function runAutomationScheduler(
  env: Env,
  options?: { now?: Date },
): Promise<AutomationSchedulerResult> {
  const now = options?.now ?? new Date();
  const nowIsoValue = now.toISOString();
  const due = await listDueAutomations(env.DB, nowIsoValue);

  const result: AutomationSchedulerResult = {
    scanned: due.length,
    claimed: 0,
    enqueued: 0,
    skippedDuplicate: 0,
    errors: [],
  };

  for (const automation of due) {
    try {
      if (!automation.schedule || automation.triggerType !== "schedule") continue;

      const slotUtc =
        automation.nextRunAt ??
        currentScheduleSlotUtcIso(automation.schedule, automation.timezone, now);
      if (!slotUtc) {
        result.errors.push(`${automation.id}: unable to determine schedule slot`);
        continue;
      }

      const idempotencyKey = buildScheduleIdempotencyKey(automation.id, slotUtc);
      const newNextRunAt = computeNextRunUtcIso(
        automation.schedule,
        automation.timezone,
        new Date(slotUtc),
      );

      const active = await findActiveAutomationRun(env.DB, automation.companyId, automation.id);
      if (active) {
        result.skippedDuplicate++;
        continue;
      }

      const claimed = await claimDueAutomation(env.DB, {
        automationId: automation.id,
        companyId: automation.companyId,
        expectedNextRunAt: automation.nextRunAt ?? slotUtc,
        newNextRunAt,
      });

      if (!claimed) {
        result.skippedDuplicate++;
        continue;
      }

      result.claimed++;

      const requested = await requestAutomationRun(env, {
        companyId: automation.companyId,
        automationId: automation.id,
        triggerType: "schedule",
        idempotencyKey,
        initiatedBy: "system:automation-scheduler",
      });

      if (!requested.created) {
        result.skippedDuplicate++;
        continue;
      }

      result.enqueued++;
    } catch (err) {
      result.errors.push(
        `${automation.id}: ${err instanceof Error ? err.message : "scheduler error"}`,
      );
    }
  }

  return result;
}

/** Test helper — force a schedule slot as due without waiting for real time. */
export async function scheduleAutomationForTestSlot(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    slotUtcIso: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE automation_definitions SET next_run_at = ?, updated_at = ?
     WHERE id = ? AND company_id = ? AND status = 'active'`,
  )
    .bind(input.slotUtcIso, nowIso(), input.automationId, input.companyId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
