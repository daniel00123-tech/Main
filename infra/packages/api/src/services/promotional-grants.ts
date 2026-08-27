import { newId, nowIso } from "../db/mappers";
import { appendLedgerEntry } from "./ledger";
import { recordAuditEvent } from "./control-plane";

/** Prospective promotional-first consumption (cutover: Command 6). Historic ledger unchanged. */
export async function grantPromotionalCredit(
  db: D1Database,
  input: {
    companyId: string;
    amountCents: number;
    reason: string;
    internalNote?: string | null;
    expiresAt?: string | null;
    grantedBy: string;
    description?: string;
  },
) {
  const ledger = await appendLedgerEntry(db, {
    companyId: input.companyId,
    entryType: "promotional_credit",
    amountCents: input.amountCents,
    description: input.description ?? input.reason,
    referenceType: "promotional_grant",
    referenceId: newId("promo"),
    createdBy: input.grantedBy,
    metadata: {
      creditClass: "test",
      reason: input.reason,
      internalNote: input.internalNote ?? null,
      grantedBy: input.grantedBy,
      expiresAt: input.expiresAt ?? null,
    },
  });

  const grantId = newId("pgrant");
  await db
    .prepare(
      `INSERT INTO promotional_credit_grants (
        id, company_id, ledger_entry_id, amount_cents, remaining_cents,
        reason, internal_note, granted_by, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      grantId,
      input.companyId,
      ledger.entry.id,
      input.amountCents,
      input.amountCents,
      input.reason,
      input.internalNote ?? null,
      input.grantedBy,
      input.expiresAt ?? null,
      nowIso(),
    )
    .run();

  return { grantId, ledgerEntryId: ledger.entry.id };
}

export async function getAvailablePromotionalCents(db: D1Database, companyId: string) {
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(remaining_cents), 0) AS total
       FROM promotional_credit_grants
       WHERE company_id = ? AND remaining_cents > 0
         AND (expires_at IS NULL OR expires_at > ?)
         AND expired_at IS NULL`,
    )
    .bind(companyId, now)
    .first();
  return Number(row?.total ?? 0);
}

/** Allocate debit: promotional first, then paid. Returns metadata for usage_debit entry. */
export async function allocateDebitCreditClasses(
  db: D1Database,
  companyId: string,
  amountCents: number,
): Promise<{ promotionalCents: number; paidCents: number }> {
  const promoAvailable = await getAvailablePromotionalCents(db, companyId);
  const promotionalCents = Math.min(promoAvailable, amountCents);
  const paidCents = amountCents - promotionalCents;
  return { promotionalCents, paidCents };
}

export async function consumePromotionalGrants(
  db: D1Database,
  companyId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents <= 0) return;
  const now = nowIso();
  const grants = await db
    .prepare(
      `SELECT id, remaining_cents FROM promotional_credit_grants
       WHERE company_id = ? AND remaining_cents > 0
         AND (expires_at IS NULL OR expires_at > ?)
         AND expired_at IS NULL
       ORDER BY created_at ASC`,
    )
    .bind(companyId, now)
    .all();

  let remaining = amountCents;
  for (const grant of grants.results ?? []) {
    if (remaining <= 0) break;
    const available = Number(grant.remaining_cents);
    const used = Math.min(available, remaining);
    await db
      .prepare(`UPDATE promotional_credit_grants SET remaining_cents = remaining_cents - ? WHERE id = ?`)
      .bind(used, grant.id)
      .run();
    remaining -= used;
  }
}

export async function listPromotionalGrants(db: D1Database, companyId: string) {
  const rows = await db
    .prepare(
      `SELECT id, amount_cents, remaining_cents, reason, granted_by, expires_at, created_at
       FROM promotional_credit_grants
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(companyId)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    amountCents: Number(row.amount_cents),
    remainingCents: Number(row.remaining_cents),
    reason: String(row.reason),
    grantedBy: String(row.granted_by),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
  }));
}

export async function expirePromotionalGrants(db: D1Database, companyId: string) {
  const now = nowIso();
  const expired = await db
    .prepare(
      `SELECT id, remaining_cents, ledger_entry_id FROM promotional_credit_grants
       WHERE company_id = ? AND remaining_cents > 0 AND expires_at IS NOT NULL AND expires_at <= ?
         AND expired_at IS NULL`,
    )
    .bind(companyId, now)
    .all();

  for (const grant of expired.results ?? []) {
    const remaining = Number(grant.remaining_cents);
    if (remaining <= 0) continue;
    await appendLedgerEntry(db, {
      companyId,
      entryType: "adjustment",
      amountCents: -remaining,
      description: "Promotional credit expired",
      referenceType: "promotional_grant",
      referenceId: String(grant.id),
      createdBy: "system",
      metadata: { creditClass: "test", reason: "expiry", originalLedgerEntryId: grant.ledger_entry_id },
    });
    await db
      .prepare(`UPDATE promotional_credit_grants SET remaining_cents = 0, expired_at = ? WHERE id = ?`)
      .bind(now, grant.id)
      .run();
    await recordAuditEvent(db, {
      companyId,
      eventType: "wallet.promotional_expired",
      actor: "system",
      resourceType: "promotional_credit_grant",
      resourceId: String(grant.id),
      detail: { amountCents: remaining },
    });
  }
}
