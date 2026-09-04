/**
 * Tenant-aware mailbox ingestion registry.
 * Separates Outlook chat/search from background attachment knowledge ingest.
 * Does not hardcode customer addresses into generic sync logic.
 */

import {
  ELVEX_COMPANY_ID,
  ELVEX_FINANCE_MAILBOXES,
  ELVEX_INFO_MAILBOXES,
  isElvexCompany,
} from "@infra/shared";
import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";

export const MAILBOX_REGISTRY_TYPES = [
  "shared_mailbox",
  "user_mailbox",
  "personal_mailbox",
  "service_mailbox",
  "unknown",
] as const;

export type MailboxRegistryType = (typeof MAILBOX_REGISTRY_TYPES)[number];

export type MailboxRegistryRow = {
  id: string;
  company_id: string;
  mailbox_id: string | null;
  mailbox_address: string;
  mailbox_type: MailboxRegistryType;
  display_name: string | null;
  enabled_for_mail_search: number;
  enabled_for_attachment_ingestion: number;
  sensitivity: string;
  status: string;
  graph_accessible: number | null;
  last_checkpoint: string | null;
  last_successful_sync: string | null;
  last_attachment_scan_at: string | null;
  last_error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export type MailboxRegistrySeed = {
  mailboxAddress: string;
  mailboxType: MailboxRegistryType;
  displayName?: string | null;
  mailboxId?: string | null;
  enabledForMailSearch: boolean;
  enabledForAttachmentIngestion: boolean;
  sensitivity: "company_operational" | "finance_operational" | "personal_work" | "unspecified";
  status?: "available" | "approved" | "denied";
  metadata?: Record<string, unknown>;
};

export async function ensureMailboxRegistrySchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_mailbox_registry (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        mailbox_id TEXT,
        mailbox_address TEXT NOT NULL,
        mailbox_type TEXT NOT NULL,
        display_name TEXT,
        enabled_for_mail_search INTEGER NOT NULL DEFAULT 0,
        enabled_for_attachment_ingestion INTEGER NOT NULL DEFAULT 0,
        sensitivity TEXT NOT NULL DEFAULT 'unspecified',
        status TEXT NOT NULL DEFAULT 'available',
        graph_accessible INTEGER,
        last_checkpoint TEXT,
        last_successful_sync TEXT,
        last_attachment_scan_at TEXT,
        last_error TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(company_id, mailbox_address)
      )`,
    )
    .run();
}

/** Work-user mailboxes Daniel approved for background attachment ingest. Not Portal chat search. */
export const ELVEX_WORK_USER_INGEST_MAILBOXES = [
  "michael@elvexpropertyservices.com",
  "sharon@elvexpropertyservices.com",
] as const;

export function policySeedsForCompany(companyId: string): MailboxRegistrySeed[] {
  if (!isElvexCompany({ id: companyId }) && companyId !== ELVEX_COMPANY_ID) return [];
  return [
    {
      mailboxAddress: ELVEX_INFO_MAILBOXES[0],
      mailboxType: "shared_mailbox",
      displayName: "EL info shared mailbox",
      enabledForMailSearch: true,
      enabledForAttachmentIngestion: true,
      sensitivity: "company_operational",
      status: "approved",
      metadata: { source: "elvex_rbac_info" },
    },
    {
      mailboxAddress: ELVEX_FINANCE_MAILBOXES[0],
      mailboxType: "shared_mailbox",
      displayName: "EL finance shared mailbox",
      enabledForMailSearch: true,
      enabledForAttachmentIngestion: true,
      sensitivity: "finance_operational",
      status: "approved",
      metadata: { source: "elvex_rbac_finance" },
    },
    {
      mailboxAddress: ELVEX_WORK_USER_INGEST_MAILBOXES[0],
      mailboxType: "user_mailbox",
      displayName: "Michael work mailbox",
      enabledForMailSearch: false,
      enabledForAttachmentIngestion: true,
      sensitivity: "personal_work",
      status: "approved",
      metadata: { source: "director_approved_work_user_ingest", person: "Michael" },
    },
    {
      mailboxAddress: ELVEX_WORK_USER_INGEST_MAILBOXES[1],
      mailboxType: "user_mailbox",
      displayName: "Sharon work mailbox",
      enabledForMailSearch: false,
      enabledForAttachmentIngestion: true,
      sensitivity: "personal_work",
      status: "approved",
      metadata: { source: "director_approved_work_user_ingest", person: "Sharon" },
    },
  ];
}

export async function upsertMailboxRegistryRow(
  db: D1Database,
  companyId: string,
  seed: MailboxRegistrySeed,
): Promise<string> {
  await ensureMailboxRegistrySchema(db);
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT id FROM company_mailbox_registry WHERE company_id = ? AND lower(mailbox_address) = lower(?) LIMIT 1`,
    )
    .bind(companyId, seed.mailboxAddress)
    .first<{ id: string }>();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE company_mailbox_registry SET
          mailbox_id = COALESCE(?, mailbox_id),
          mailbox_type = ?,
          display_name = COALESCE(?, display_name),
          enabled_for_mail_search = ?,
          enabled_for_attachment_ingestion = ?,
          sensitivity = ?,
          status = COALESCE(?, status),
          metadata_json = COALESCE(?, metadata_json),
          updated_at = ?
         WHERE id = ? AND company_id = ?`,
      )
      .bind(
        seed.mailboxId ?? null,
        seed.mailboxType,
        seed.displayName ?? null,
        seed.enabledForMailSearch ? 1 : 0,
        seed.enabledForAttachmentIngestion ? 1 : 0,
        seed.sensitivity,
        seed.status ?? null,
        seed.metadata ? JSON.stringify(seed.metadata) : null,
        now,
        existing.id,
        companyId,
      )
      .run();
    return existing.id;
  }
  const id = newId("mbx");
  await db
    .prepare(
      `INSERT INTO company_mailbox_registry (
        id, company_id, mailbox_id, mailbox_address, mailbox_type, display_name,
        enabled_for_mail_search, enabled_for_attachment_ingestion, sensitivity, status,
        graph_accessible, last_checkpoint, last_successful_sync, last_attachment_scan_at,
        last_error, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      id,
      companyId,
      seed.mailboxId ?? null,
      seed.mailboxAddress,
      seed.mailboxType,
      seed.displayName ?? null,
      seed.enabledForMailSearch ? 1 : 0,
      seed.enabledForAttachmentIngestion ? 1 : 0,
      seed.sensitivity,
      seed.status ?? (seed.enabledForAttachmentIngestion ? "approved" : "available"),
      seed.metadata ? JSON.stringify(seed.metadata) : null,
      now,
      now,
    )
    .run();
  return id;
}

export async function seedPolicyMailboxes(db: D1Database, companyId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const seed of policySeedsForCompany(companyId)) {
    ids.push(await upsertMailboxRegistryRow(db, companyId, seed));
  }
  return ids;
}

export async function registerDiscoveredUserMailbox(
  db: D1Database,
  input: {
    companyId: string;
    mailboxAddress: string;
    displayName?: string | null;
    mailboxId?: string | null;
    role?: string | null;
  },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id, enabled_for_attachment_ingestion FROM company_mailbox_registry
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) LIMIT 1`,
    )
    .bind(input.companyId, input.mailboxAddress)
    .first<{ id: string; enabled_for_attachment_ingestion: number }>();
  if (existing?.id) return existing.id;
  return upsertMailboxRegistryRow(db, input.companyId, {
    mailboxAddress: input.mailboxAddress,
    mailboxType: "user_mailbox",
    displayName: input.displayName ?? null,
    mailboxId: input.mailboxId ?? null,
    enabledForMailSearch: false,
    enabledForAttachmentIngestion: false,
    sensitivity: "personal_work",
    status: "available",
    metadata: {
      source: "company_membership",
      role: input.role ?? null,
      policy: "personal_user_mailbox_not_auto_ingested",
    },
  });
}

export async function listApprovedAttachmentMailboxes(
  db: D1Database,
  companyId: string,
): Promise<MailboxRegistryRow[]> {
  await ensureMailboxRegistrySchema(db);
  await seedPolicyMailboxes(db, companyId);
  const result = await db
    .prepare(
      `SELECT * FROM company_mailbox_registry
       WHERE company_id = ? AND enabled_for_attachment_ingestion = 1
       ORDER BY mailbox_address`,
    )
    .bind(companyId)
    .all<MailboxRegistryRow>();
  return result.results ?? [];
}

export async function listCompanyMailboxRegistry(
  db: D1Database,
  companyId: string,
): Promise<MailboxRegistryRow[]> {
  await ensureMailboxRegistrySchema(db);
  const result = await db
    .prepare(`SELECT * FROM company_mailbox_registry WHERE company_id = ? ORDER BY mailbox_address`)
    .bind(companyId)
    .all<MailboxRegistryRow>();
  return result.results ?? [];
}

export async function markMailboxScanResult(
  db: D1Database,
  input: {
    companyId: string;
    mailboxAddress: string;
    checkpoint?: string | null;
    success: boolean;
    graphAccessible?: boolean | null;
    error?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE company_mailbox_registry SET
        last_attachment_scan_at = ?,
        last_successful_sync = CASE WHEN ? THEN ? ELSE last_successful_sync END,
        last_checkpoint = CASE WHEN ? AND ? IS NOT NULL THEN ? ELSE last_checkpoint END,
        graph_accessible = COALESCE(?, graph_accessible),
        last_error = ?,
        status = CASE WHEN ? THEN CASE WHEN enabled_for_attachment_ingestion = 1 THEN 'approved' ELSE status END ELSE 'error' END,
        updated_at = ?
       WHERE company_id = ? AND lower(mailbox_address) = lower(?)`,
    )
    .bind(
      now,
      input.success ? 1 : 0,
      now,
      input.success ? 1 : 0,
      input.checkpoint ?? null,
      input.checkpoint ?? null,
      input.graphAccessible == null ? null : input.graphAccessible ? 1 : 0,
      input.success ? null : input.error ?? "scan failed",
      input.success ? 1 : 0,
      now,
      input.companyId,
      input.mailboxAddress,
    )
    .run();
}

export async function discoverCompanyUserMailboxes(
  env: Env,
  companyId: string,
): Promise<Array<{ mailboxAddress: string; displayName: string; userId: string; role: string }>> {
  const result = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, m.role
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active'`,
  )
    .bind(companyId)
    .all<{ id: string; email: string; display_name: string; role: string }>();
  const approved = new Set(
    policySeedsForCompany(companyId).map((seed) => seed.mailboxAddress.toLowerCase()),
  );
  const rows: Array<{ mailboxAddress: string; displayName: string; userId: string; role: string }> = [];
  for (const row of result.results ?? []) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!email || approved.has(email) || email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) {
      continue;
    }
    rows.push({
      mailboxAddress: email,
      displayName: row.display_name,
      userId: row.id,
      role: row.role,
    });
    await registerDiscoveredUserMailbox(env.DB, {
      companyId,
      mailboxAddress: email,
      displayName: row.display_name,
      mailboxId: row.id,
      role: row.role,
    });
  }
  return rows;
}
