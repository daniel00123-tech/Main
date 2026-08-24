import { newId, nowIso } from "../db/mappers";

export type LedgerEntryType =
  | "top_up"
  | "usage_debit"
  | "manual_credit"
  | "refund"
  | "adjustment"
  | "promotional_credit";

export interface LedgerEntry {
  id: string;
  companyId: string;
  entryType: LedgerEntryType;
  amountCents: number;
  currency: string;
  balanceAfterCents: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}

function rowToLedger(row: Record<string, unknown>): LedgerEntry {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    entryType: String(row.entry_type) as LedgerEntryType,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    balanceAfterCents: Number(row.balance_after_cents),
    referenceType: row.reference_type ? String(row.reference_type) : null,
    referenceId: row.reference_id ? String(row.reference_id) : null,
    description: row.description ? String(row.description) : null,
    metadata: (() => {
      try {
        return JSON.parse(String(row.metadata_json ?? "{}")) as Record<
          string,
          unknown
        >;
      } catch {
        return {};
      }
    })(),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
  };
}

export async function ensureCreditBalanceRow(
  db: D1Database,
  companyId: string,
  currency = "GBP",
) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO credit_balances
        (company_id, balance_cents, currency, updated_at, low_balance_threshold_cents)
       VALUES (?, 0, ?, ?, 500)`,
    )
    .bind(companyId, currency, nowIso())
    .run();
}

export async function getWalletBalance(db: D1Database, companyId: string) {
  await ensureCreditBalanceRow(db, companyId);
  const row = await db
    .prepare("SELECT * FROM credit_balances WHERE company_id = ?")
    .bind(companyId)
    .first();

  const ledgerSum = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM ledger_entries WHERE company_id = ?`,
    )
    .bind(companyId)
    .first();

  const derived = Number(ledgerSum?.total ?? 0);
  const cached = Number(row?.balance_cents ?? 0);
  const threshold = Number(row?.low_balance_threshold_cents ?? 500);
  const stripeCustomerId = row?.stripe_customer_id
    ? String(row.stripe_customer_id)
    : null;

  // Prefer ledger-derived balance; heal cache if drifted
  if (derived !== cached) {
    await db
      .prepare(
        `UPDATE credit_balances SET balance_cents = ?, updated_at = ? WHERE company_id = ?`,
      )
      .bind(derived, nowIso(), companyId)
      .run();
  }

  return {
    companyId,
    balanceCents: derived,
    currency: String(row?.currency ?? "GBP"),
    lowBalanceThresholdCents: threshold,
    lowBalance: derived < threshold,
    stripeCustomerId,
    updatedAt: String(row?.updated_at ?? nowIso()),
  };
}

export async function listLedgerEntries(
  db: D1Database,
  companyId: string,
  limit = 50,
) {
  const result = await db
    .prepare(
      `SELECT * FROM ledger_entries
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(companyId, limit)
    .all();
  return (result.results ?? []).map((row) => rowToLedger(row));
}

export async function appendLedgerEntry(
  db: D1Database,
  input: {
    companyId: string;
    entryType: LedgerEntryType;
    amountCents: number;
    currency?: string;
    referenceType?: string | null;
    referenceId?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown>;
    createdBy?: string | null;
  },
): Promise<{ entry: LedgerEntry; alreadyExists: boolean }> {
  await ensureCreditBalanceRow(db, input.companyId, input.currency ?? "GBP");

  if (input.referenceType && input.referenceId) {
    const existing = await db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE company_id = ? AND reference_type = ? AND reference_id = ?`,
      )
      .bind(input.companyId, input.referenceType, input.referenceId)
      .first();
    if (existing) {
      return { entry: rowToLedger(existing), alreadyExists: true };
    }
  }

  const current = await getWalletBalance(db, input.companyId);
  const balanceAfter = current.balanceCents + input.amountCents;
  if (input.entryType === "usage_debit" && balanceAfter < 0) {
    throw new Error("INSUFFICIENT_CREDIT");
  }
  const id = newId("ledger");
  const createdAt = nowIso();

  await db
    .prepare(
      `INSERT INTO ledger_entries (
        id, company_id, entry_type, amount_cents, currency, balance_after_cents,
        reference_type, reference_id, description, metadata_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.entryType,
      input.amountCents,
      input.currency ?? "GBP",
      balanceAfter,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.description ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdBy ?? null,
      createdAt,
    )
    .run();

  await db
    .prepare(
      `UPDATE credit_balances SET balance_cents = ?, updated_at = ? WHERE company_id = ?`,
    )
    .bind(balanceAfter, createdAt, input.companyId)
    .run();

  return {
    entry: {
      id,
      companyId: input.companyId,
      entryType: input.entryType,
      amountCents: input.amountCents,
      currency: input.currency ?? "GBP",
      balanceAfterCents: balanceAfter,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      createdBy: input.createdBy ?? null,
      createdAt,
    },
    alreadyExists: false,
  };
}

export async function listPlatformBalances(db: D1Database) {
  const companies = await db
    .prepare("SELECT id, name, slug FROM companies ORDER BY name ASC")
    .all();

  const balances = [];
  for (const company of companies.results ?? []) {
    const wallet = await getWalletBalance(db, String(company.id));
    balances.push({
      companyName: String(company.name),
      companySlug: String(company.slug),
      ...wallet,
    });
  }
  return balances;
}
