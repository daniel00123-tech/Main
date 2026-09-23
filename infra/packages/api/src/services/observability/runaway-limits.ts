/**
 * Per-tenant runaway protection for queues, schedulers, and connector jobs.
 * Limits are company-scoped. They never inspect another tenant's rows.
 */

export const MAX_AUTOMATION_RUNS_PER_COMPANY_PER_TICK = 2;
export const MAX_MICROSOFT_JOBS_PER_COMPANY_PER_DAY = 2500;
export const MAX_QUEUE_RETRIES = 5;

export function shouldSkipCompanyAutomationTick(
  alreadyClaimedForCompany: number,
  limit = MAX_AUTOMATION_RUNS_PER_COMPANY_PER_TICK,
): boolean {
  return alreadyClaimedForCompany >= limit;
}

export async function countMicrosoftJobsCreatedToday(
  db: D1Database,
  companyId: string,
  now = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM microsoft_file_jobs
       WHERE company_id = ? AND created_at >= ?`,
    )
    .bind(companyId, since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function isMicrosoftDailyJobBudgetExceeded(
  db: D1Database,
  companyId: string,
  limit = MAX_MICROSOFT_JOBS_PER_COMPANY_PER_DAY,
): Promise<boolean> {
  return (await countMicrosoftJobsCreatedToday(db, companyId)) >= limit;
}

export function shouldDeadLetterAfterRetries(attempts: number, max = MAX_QUEUE_RETRIES): boolean {
  return attempts >= max;
}
