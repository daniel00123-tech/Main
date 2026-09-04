/**
 * Tenant mailbox attachment-ingestion policy.
 * Default INCLUDE/EXCLUDE plus explicit overrides. Not EL-only architecture.
 */

import { ELVEX_COMPANY_ID, isElvexCompany } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";

export type MailboxIngestionDefault = "INCLUDE" | "EXCLUDE";
export type MailboxIngestionOverridePolicy = "INHERIT_DEFAULT" | "INCLUDE" | "EXCLUDE";

export type MailboxPolicyDecision = {
  policy: MailboxIngestionOverridePolicy;
  effective: "INCLUDE" | "EXCLUDE";
  reason: string;
  defaultPolicy: MailboxIngestionDefault;
};

export type MailboxPolicySubject = {
  mailboxId?: string | null;
  mailboxAddress?: string | null;
  displayName?: string | null;
  userId?: string | null;
};

export type MailboxIngestionOverrideRow = {
  id: string;
  company_id: string;
  mailbox_id: string | null;
  mailbox_address: string | null;
  display_name: string | null;
  policy: MailboxIngestionOverridePolicy;
  reason: string | null;
  updated_at: string;
  created_at: string;
};

/** Explicit EL exclusions by person identity — not a static include-list of everyone else. */
const ELVEX_EXCLUDED_PEOPLE = [
  { name: "William", localPart: "william", reason: "director exclusion: attachment knowledge ingest off" },
  { name: "Ella", localPart: "ella", reason: "director exclusion: attachment knowledge ingest off" },
] as const;

export async function ensureMailboxIngestionPolicySchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_mailbox_ingestion_policies (
        company_id TEXT PRIMARY KEY,
        default_policy TEXT NOT NULL DEFAULT 'EXCLUDE',
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_mailbox_ingestion_overrides (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        mailbox_id TEXT,
        mailbox_address TEXT,
        display_name TEXT,
        policy TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    )
    .run();
}

export function defaultIngestionPolicyForCompany(companyId: string): MailboxIngestionDefault {
  if (isElvexCompany({ id: companyId }) || companyId === ELVEX_COMPANY_ID) return "INCLUDE";
  return "EXCLUDE";
}

function localPart(address?: string | null): string {
  const trimmed = (address ?? "").trim().toLowerCase();
  const at = trimmed.indexOf("@");
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

function displayMatches(displayName: string | null | undefined, needle: string): boolean {
  const name = (displayName ?? "").trim().toLowerCase();
  if (!name) return false;
  const first = name.split(/\s+/)[0] ?? "";
  return first === needle.toLowerCase() || name === needle.toLowerCase();
}

export function matchesElvexExcludedPerson(subject: MailboxPolicySubject): (typeof ELVEX_EXCLUDED_PEOPLE)[number] | null {
  for (const person of ELVEX_EXCLUDED_PEOPLE) {
    if (displayMatches(subject.displayName, person.name)) return person;
    if (localPart(subject.mailboxAddress) === person.localPart) return person;
  }
  return null;
}

export async function ensureCompanyIngestionPolicy(
  db: D1Database,
  companyId: string,
): Promise<MailboxIngestionDefault> {
  await ensureMailboxIngestionPolicySchema(db);
  const existing = await db
    .prepare(`SELECT default_policy FROM company_mailbox_ingestion_policies WHERE company_id = ? LIMIT 1`)
    .bind(companyId)
    .first<{ default_policy: MailboxIngestionDefault }>();
  if (existing?.default_policy === "INCLUDE" || existing?.default_policy === "EXCLUDE") {
    return existing.default_policy;
  }
  const fallback = defaultIngestionPolicyForCompany(companyId);
  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO company_mailbox_ingestion_policies (company_id, default_policy, updated_at)
       VALUES (?, ?, ?)`,
    )
    .bind(companyId, fallback, now)
    .run();
  return fallback;
}

export async function listIngestionOverrides(
  db: D1Database,
  companyId: string,
): Promise<MailboxIngestionOverrideRow[]> {
  await ensureMailboxIngestionPolicySchema(db);
  const result = await db
    .prepare(
      `SELECT * FROM company_mailbox_ingestion_overrides WHERE company_id = ? ORDER BY updated_at DESC`,
    )
    .bind(companyId)
    .all<MailboxIngestionOverrideRow>();
  return result.results ?? [];
}

export async function upsertIngestionOverride(
  db: D1Database,
  input: {
    companyId: string;
    mailboxId?: string | null;
    mailboxAddress?: string | null;
    displayName?: string | null;
    policy: MailboxIngestionOverridePolicy;
    reason?: string | null;
  },
): Promise<string> {
  await ensureMailboxIngestionPolicySchema(db);
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT id FROM company_mailbox_ingestion_overrides
       WHERE company_id = ?
         AND (
           (? IS NOT NULL AND mailbox_id = ?)
           OR (? IS NOT NULL AND lower(mailbox_address) = lower(?))
           OR (? IS NOT NULL AND lower(display_name) = lower(?))
         )
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(
      input.companyId,
      input.mailboxId ?? null,
      input.mailboxId ?? null,
      input.mailboxAddress ?? null,
      input.mailboxAddress ?? null,
      input.displayName ?? null,
      input.displayName ?? null,
    )
    .first<{ id: string }>();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE company_mailbox_ingestion_overrides
         SET mailbox_id = COALESCE(?, mailbox_id),
             mailbox_address = COALESCE(?, mailbox_address),
             display_name = COALESCE(?, display_name),
             policy = ?,
             reason = COALESCE(?, reason),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.mailboxId ?? null,
        input.mailboxAddress ?? null,
        input.displayName ?? null,
        input.policy,
        input.reason ?? null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }
  const id = newId("mio");
  await db
    .prepare(
      `INSERT INTO company_mailbox_ingestion_overrides (
        id, company_id, mailbox_id, mailbox_address, display_name, policy, reason, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.mailboxId ?? null,
      input.mailboxAddress ?? null,
      input.displayName ?? null,
      input.policy,
      input.reason ?? null,
      now,
      now,
    )
    .run();
  return id;
}

export async function seedElvexIngestionExclusions(db: D1Database, companyId: string): Promise<void> {
  if (!isElvexCompany({ id: companyId }) && companyId !== ELVEX_COMPANY_ID) return;
  await ensureCompanyIngestionPolicy(db, companyId);
  const members = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name
         FROM users u
         JOIN company_memberships m ON m.user_id = u.id
        WHERE m.company_id = ? AND m.status = 'active'`,
    )
    .bind(companyId)
    .all<{ id: string; email: string | null; display_name: string | null }>()
    .catch(() => ({ results: [] as Array<{ id: string; email: string | null; display_name: string | null }> }));
  for (const person of ELVEX_EXCLUDED_PEOPLE) {
    const member = (members.results ?? []).find((row) => {
      const match = matchesElvexExcludedPerson({
        mailboxAddress: row.email,
        displayName: row.display_name,
        userId: row.id,
        mailboxId: row.id,
      });
      return match?.name === person.name;
    });
    await upsertIngestionOverride(db, {
      companyId,
      mailboxId: member?.id ?? null,
      mailboxAddress: member?.email ?? `${person.localPart}@elvexpropertyservices.com`,
      displayName: person.name,
      policy: "EXCLUDE",
      reason: person.reason,
    });
  }
}

export async function resolveMailboxIngestionPolicy(
  db: D1Database,
  companyId: string,
  subject: MailboxPolicySubject,
): Promise<MailboxPolicyDecision> {
  const defaultPolicy = await ensureCompanyIngestionPolicy(db, companyId);
  const overrides = await listIngestionOverrides(db, companyId);
  const address = (subject.mailboxAddress ?? "").trim().toLowerCase();
  const mailboxId = (subject.mailboxId ?? subject.userId ?? "").trim();
  const override = overrides.find((row) => {
    if (mailboxId && row.mailbox_id && row.mailbox_id === mailboxId) return true;
    if (subject.userId && row.mailbox_id && row.mailbox_id === subject.userId) return true;
    if (address && row.mailbox_address && row.mailbox_address.toLowerCase() === address) return true;
    if (row.display_name && displayMatches(subject.displayName, row.display_name)) return true;
    return false;
  });
  const elvexExcluded = matchesElvexExcludedPerson(subject);
  if (elvexExcluded && (!override || override.policy !== "INCLUDE")) {
    if (!override) {
      await upsertIngestionOverride(db, {
        companyId,
        mailboxId: subject.mailboxId ?? null,
        mailboxAddress: subject.mailboxAddress ?? null,
        displayName: elvexExcluded.name,
        policy: "EXCLUDE",
        reason: elvexExcluded.reason,
      });
    }
    return {
      policy: "EXCLUDE",
      effective: "EXCLUDE",
      reason: elvexExcluded.reason,
      defaultPolicy,
    };
  }
  if (override && override.policy !== "INHERIT_DEFAULT") {
    return {
      policy: override.policy,
      effective: override.policy,
      reason: override.reason ?? `${override.policy} override`,
      defaultPolicy,
    };
  }
  return {
    policy: "INHERIT_DEFAULT",
    effective: defaultPolicy,
    reason:
      defaultPolicy === "INCLUDE"
        ? "inherit company default INCLUDE"
        : "inherit company default EXCLUDE",
    defaultPolicy,
  };
}
