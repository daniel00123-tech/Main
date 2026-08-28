/**
 * Automation Engine queue producer/consumer.
 */

import type { Env } from "../../env";
import { nowIso } from "../../db/mappers";
import { executeAutomationRun } from "./executor";

export const AUTOMATION_RUN_QUEUE = "automation-runs";
export const AUTOMATION_RUN_DLQ = "automation-runs-dlq";
export const AUTOMATION_QUEUE_MAX_RETRIES = 5;

export type AutomationRunMessage = {
  runId: string;
  companyId: string;
  automationId: string;
};

export function hasAutomationRunQueue(env: Env): boolean {
  return typeof env.AUTOMATION_RUN_QUEUE !== "undefined" && env.AUTOMATION_RUN_QUEUE !== null;
}

export async function enqueueAutomationRun(env: Env, message: AutomationRunMessage): Promise<boolean> {
  if (!hasAutomationRunQueue(env)) return false;
  await env.AUTOMATION_RUN_QUEUE!.send(message);
  return true;
}

export async function processAutomationRunJob(
  env: Env,
  message: AutomationRunMessage,
  options?: { deadLetter?: boolean },
): Promise<void> {
  if (options?.deadLetter) {
    await env.DB.prepare(
      `UPDATE automation_runs SET status = 'failed', error_code = 'DEAD_LETTER', error_message = 'Moved to dead letter queue', completed_at = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
    )
      .bind(nowIso(), nowIso(), message.runId, message.companyId)
      .run();
    return;
  }

  await executeAutomationRun(env, message);
}

export async function kickAutomationRunProcessor(env: Env, runId: string, companyId: string, automationId: string): Promise<void> {
  const base = (env.INFRA_PUBLIC_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(/\/$/, "");
  await fetch(`${base}/api/internal/automation/process-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, companyId, automationId }),
  }).catch(() => undefined);
}
