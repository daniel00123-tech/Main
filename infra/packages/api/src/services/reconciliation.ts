import { newId, nowIso } from "../db/mappers";

export type IntegrityExceptionType =
  | "usage_without_ledger"
  | "ledger_without_usage"
  | "duplicate_ledger_debit"
  | "charge_mismatch"
  | "wallet_cache_drift";

/**
 * Safe heal: link usage → existing ledger when reference already matches.
 * NEVER creates new debits. Only repairs missing settlement pointers.
 */
export async function healUsageLedgerLinks(db: D1Database) {
  const orphaned = await db
    .prepare(
      `SELECT u.id AS usage_id, l.id AS ledger_id
       FROM usage_records u
       JOIN ledger_entries l
         ON l.reference_type = 'usage' AND l.reference_id = u.id
       WHERE u.ledger_entry_id IS NULL
          OR (u.settlement_status IN ('unsettled', 'failed') AND u.ledger_entry_id IS NULL)`,
    )
    .all();

  const healed: Array<{ usageId: string; ledgerId: string }> = [];
  for (const row of orphaned.results ?? []) {
    const usageId = String(row.usage_id);
    const ledgerId = String(row.ledger_id);
    await db
      .prepare(
        `UPDATE usage_records
         SET ledger_entry_id = ?, settlement_status = 'settled'
         WHERE id = ? AND (ledger_entry_id IS NULL OR settlement_status != 'settled')`,
      )
      .bind(ledgerId, usageId)
      .run();
    healed.push({ usageId, ledgerId });
  }
  return healed;
}

/**
 * Detect financial integrity exceptions.
 * NEVER auto-debits historic usage — only records exceptions for admin review.
 * First heals link-only settlement gaps where a ledger debit already exists.
 */
export async function runFinancialReconciliation(db: D1Database) {
  const detectedAt = nowIso();
  const created: string[] = [];
  const healedLinks = await healUsageLedgerLinks(db);

  // Successful billable usage without ledger settlement (after link heal)
  const unpaid = await db
    .prepare(
      `SELECT u.id, u.company_id, u.customer_charge_cents, u.correlation_id, u.request_id, u.settlement_status
       FROM usage_records u
       WHERE u.success = 1
         AND u.customer_charge_cents IS NOT NULL
         AND u.customer_charge_cents > 0
         AND (u.ledger_entry_id IS NULL OR u.settlement_status IN ('unsettled', 'failed'))
         AND NOT EXISTS (
           SELECT 1 FROM ledger_entries l
           WHERE l.reference_type = 'usage' AND l.reference_id = u.id
         )`,
    )
    .all();

  for (const row of unpaid.results ?? []) {
    const usageId = String(row.id);
    const existing = await db
      .prepare(
        `SELECT id FROM financial_integrity_exceptions
         WHERE usage_record_id = ? AND exception_type = 'usage_without_ledger' AND status = 'open'
         LIMIT 1`,
      )
      .bind(usageId)
      .first();
    if (existing) continue;

    const id = newId("fie");
    await db
      .prepare(
        `INSERT INTO financial_integrity_exceptions (
          id, company_id, exception_type, severity, status, usage_record_id,
          ledger_entry_id, gateway_request_id, detail_json, detected_at
        ) VALUES (?, ?, 'usage_without_ledger', 'warning', 'open', ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        id,
        String(row.company_id),
        usageId,
        JSON.stringify({
          customerChargeCents: row.customer_charge_cents,
          correlationId: row.correlation_id,
          requestId: row.request_id,
          settlementStatus: row.settlement_status,
          policy: "Do not auto-debit. Review before any compensating entry.",
        }),
        detectedAt,
      )
      .run();
    created.push(id);
  }

  // Ledger usage_debit without matching usage row
  const orphanLedger = await db
    .prepare(
      `SELECT l.id, l.company_id, l.reference_id, l.amount_cents
       FROM ledger_entries l
       WHERE l.entry_type = 'usage_debit'
         AND l.reference_type = 'usage'
         AND (l.reference_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM usage_records u WHERE u.id = l.reference_id
         ))`,
    )
    .all();

  for (const row of orphanLedger.results ?? []) {
    const ledgerId = String(row.id);
    const existing = await db
      .prepare(
        `SELECT id FROM financial_integrity_exceptions
         WHERE ledger_entry_id = ? AND exception_type = 'ledger_without_usage' AND status = 'open'
         LIMIT 1`,
      )
      .bind(ledgerId)
      .first();
    if (existing) continue;

    const id = newId("fie");
    await db
      .prepare(
        `INSERT INTO financial_integrity_exceptions (
          id, company_id, exception_type, severity, status, usage_record_id,
          ledger_entry_id, gateway_request_id, detail_json, detected_at
        ) VALUES (?, ?, 'ledger_without_usage', 'error', 'open', NULL, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        String(row.company_id),
        ledgerId,
        JSON.stringify({
          referenceId: row.reference_id,
          amountCents: row.amount_cents,
        }),
        detectedAt,
      )
      .run();
    created.push(id);
  }

  // Charge mismatch: usage.customer_charge != abs(ledger.amount)
  const mismatches = await db
    .prepare(
      `SELECT u.id AS usage_id, u.company_id, u.customer_charge_cents, l.id AS ledger_id, l.amount_cents
       FROM usage_records u
       JOIN ledger_entries l ON l.id = u.ledger_entry_id
       WHERE u.customer_charge_cents IS NOT NULL
         AND ABS(l.amount_cents) != u.customer_charge_cents`,
    )
    .all();

  for (const row of mismatches.results ?? []) {
    const usageId = String(row.usage_id);
    const existing = await db
      .prepare(
        `SELECT id FROM financial_integrity_exceptions
         WHERE usage_record_id = ? AND exception_type = 'charge_mismatch' AND status = 'open'
         LIMIT 1`,
      )
      .bind(usageId)
      .first();
    if (existing) continue;

    const id = newId("fie");
    await db
      .prepare(
        `INSERT INTO financial_integrity_exceptions (
          id, company_id, exception_type, severity, status, usage_record_id,
          ledger_entry_id, gateway_request_id, detail_json, detected_at
        ) VALUES (?, ?, 'charge_mismatch', 'error', 'open', ?, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        String(row.company_id),
        usageId,
        String(row.ledger_id),
        JSON.stringify({
          usageChargeCents: row.customer_charge_cents,
          ledgerAmountCents: row.amount_cents,
        }),
        detectedAt,
      )
      .run();
    created.push(id);
  }

  // Wallet cache drift vs ledger sum
  const companies = await db.prepare(`SELECT company_id, balance_cents FROM credit_balances`).all();
  for (const row of companies.results ?? []) {
    const companyId = String(row.company_id);
    const cached = Number(row.balance_cents ?? 0);
    const sum = await db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE company_id = ?`,
      )
      .bind(companyId)
      .first();
    const derived = Number(sum?.total ?? 0);
    if (cached === derived) continue;

    const existing = await db
      .prepare(
        `SELECT id FROM financial_integrity_exceptions
         WHERE company_id = ? AND exception_type = 'wallet_cache_drift' AND status = 'open'
         LIMIT 1`,
      )
      .bind(companyId)
      .first();
    if (existing) continue;

    const id = newId("fie");
    await db
      .prepare(
        `INSERT INTO financial_integrity_exceptions (
          id, company_id, exception_type, severity, status, usage_record_id,
          ledger_entry_id, gateway_request_id, detail_json, detected_at
        ) VALUES (?, ?, 'wallet_cache_drift', 'warning', 'open', NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        id,
        companyId,
        JSON.stringify({
          cachedBalanceCents: cached,
          ledgerDerivedCents: derived,
          note: "Ledger is source of truth; cache can be healed via getWalletBalance.",
        }),
        detectedAt,
      )
      .run();
    created.push(id);
  }

  // Duplicate ledger debits for the same usage reference
  const dupes = await db
    .prepare(
      `SELECT company_id, reference_id, COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids
       FROM ledger_entries
       WHERE entry_type = 'usage_debit' AND reference_type = 'usage' AND reference_id IS NOT NULL
       GROUP BY company_id, reference_id
       HAVING COUNT(*) > 1`,
    )
    .all();

  for (const row of dupes.results ?? []) {
    const usageId = String(row.reference_id);
    const existing = await db
      .prepare(
        `SELECT id FROM financial_integrity_exceptions
         WHERE usage_record_id = ? AND exception_type = 'duplicate_ledger_debit' AND status = 'open'
         LIMIT 1`,
      )
      .bind(usageId)
      .first();
    if (existing) continue;

    const id = newId("fie");
    await db
      .prepare(
        `INSERT INTO financial_integrity_exceptions (
          id, company_id, exception_type, severity, status, usage_record_id,
          ledger_entry_id, gateway_request_id, detail_json, detected_at
        ) VALUES (?, ?, 'duplicate_ledger_debit', 'error', 'open', ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        id,
        String(row.company_id),
        usageId,
        JSON.stringify({
          count: row.cnt,
          ledgerIds: String(row.ids ?? "").split(","),
          policy: "Do not delete historic ledger rows. Use compensating credit with audit trail.",
        }),
        detectedAt,
      )
      .run();
    created.push(id);
  }

  return {
    detectedAt,
    healedLinks: healedLinks.length,
    healed: healedLinks,
    exceptionsCreated: created.length,
    exceptionIds: created,
    note: "Ledger remains source of truth. Healed links only repair pointers — no new debits were created.",
  };
}

export async function listFinancialExceptions(
  db: D1Database,
  status: string = "open",
) {
  const result = await db
    .prepare(
      `SELECT * FROM financial_integrity_exceptions
       WHERE status = ?
       ORDER BY detected_at DESC
       LIMIT 100`,
    )
    .bind(status)
    .all();

  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    exceptionType: String(row.exception_type),
    severity: String(row.severity),
    status: String(row.status),
    usageRecordId: row.usage_record_id ? String(row.usage_record_id) : null,
    ledgerEntryId: row.ledger_entry_id ? String(row.ledger_entry_id) : null,
    gatewayRequestId: row.gateway_request_id
      ? String(row.gateway_request_id)
      : null,
    detail: (() => {
      try {
        return JSON.parse(String(row.detail_json ?? "{}"));
      } catch {
        return {};
      }
    })(),
    detectedAt: String(row.detected_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
  }));
}
