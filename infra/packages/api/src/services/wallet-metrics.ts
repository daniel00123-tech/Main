import { nowIso } from "../db/mappers";

export type WalletHealthState = "healthy" | "low" | "critical" | "empty";

/** UTC start of the current calendar month (billing month). */
export function getMonthStartUtcIso(reference = new Date()): string {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1),
  ).toISOString();
}

/**
 * Authoritative monthly spend from ledger usage debits — not a paginated slice.
 * Matches platform billing accounting (billing-admin).
 */
export async function getSpendThisMonthCents(
  db: D1Database,
  companyId: string,
  monthStartIso = getMonthStartUtcIso(),
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_cents)), 0) AS spend
       FROM ledger_entries
       WHERE company_id = ?
         AND entry_type = 'usage_debit'
         AND amount_cents < 0
         AND created_at >= ?`,
    )
    .bind(companyId, monthStartIso)
    .first();
  return Number(row?.spend ?? 0);
}

export async function getCreditsAddedThisMonthCents(
  db: D1Database,
  companyId: string,
  monthStartIso = getMonthStartUtcIso(),
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS credits
       FROM ledger_entries
       WHERE company_id = ?
         AND amount_cents > 0
         AND created_at >= ?`,
    )
    .bind(companyId, monthStartIso)
    .first();
  return Number(row?.credits ?? 0);
}

export function deriveWalletHealthState(
  balanceCents: number,
  lowBalanceThresholdCents: number,
): WalletHealthState {
  if (balanceCents <= 0) return "empty";
  if (balanceCents < Math.max(100, Math.floor(lowBalanceThresholdCents / 2))) {
    return "critical";
  }
  if (balanceCents < lowBalanceThresholdCents) return "low";
  return "healthy";
}

export async function syncLowBalanceThreshold(
  db: D1Database,
  companyId: string,
  thresholdCents: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE credit_balances
       SET low_balance_threshold_cents = ?, updated_at = ?
       WHERE company_id = ?`,
    )
    .bind(thresholdCents, nowIso(), companyId)
    .run();
  await db
    .prepare(
      `UPDATE company_commercial_settings
       SET low_balance_threshold_cents = ?, updated_at = ?
       WHERE company_id = ?`,
    )
    .bind(thresholdCents, nowIso(), companyId)
    .run();
}
