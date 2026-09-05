/**
 * Tenant/mailbox-scoped Outlook folder coverage for attachment ingest.
 * Inbox is always included. Sent Items and Archive are opt-in.
 * User-created folders are never auto-enabled.
 */

import { ELVEX_COMPANY_ID, isElvexCompany } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";

export const DEFAULT_EXCLUDED_FOLDER_NAMES = [
  "deleted items",
  "deleteditems",
  "junk email",
  "junkemail",
  "drafts",
  "conversation history",
  "conversationhistory",
  "recoverable items",
  "recoverableitems",
  "sync issues",
  "syncissues",
  "outbox",
  "clutter",
  "rss feeds",
  "notes",
  "conflicts",
  "local failures",
  "server failures",
  "sync issues/conflicts",
  "sync issues/local failures",
  "sync issues/server failures",
] as const;

export type MailboxFolderSettingsRow = {
  id: string;
  company_id: string;
  mailbox_address: string;
  include_sent: number;
  include_archive: number;
  updated_at: string;
  created_at: string;
};

export type MailboxIngestFolderRow = {
  id: string;
  company_id: string;
  mailbox_address: string;
  folder_id: string | null;
  folder_name: string;
  enabled: number;
  source: string;
  last_checkpoint: string | null;
  last_scan_at: string | null;
  last_messages_scanned: number | null;
  last_error: string | null;
  updated_at: string;
  created_at: string;
};

export type GraphFolderRef = {
  id: string;
  displayName: string;
};

export type ResolvedIngestFolder = {
  folderId: string;
  folderName: string;
  kind: "inbox" | "user" | "sent" | "archive";
  source: string;
  lastCheckpoint: string | null;
  policyId?: string | null;
};

/** EL configuration seed only — never used as shared routing logic. */
export const EL_SEEDED_MAILBOX_FOLDER_APPROVALS = [
  {
    mailboxAddress: "michael@elvexpropertyservices.com",
    folderNames: ["DAVIES GROUP INVOICES FOR SPREADSHEET", "COMPLETED"],
    includeSent: false,
    includeArchive: false,
  },
] as const;

export async function ensureMailboxIngestFolderPolicySchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_mailbox_folder_settings (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        mailbox_address TEXT NOT NULL,
        include_sent INTEGER NOT NULL DEFAULT 0,
        include_archive INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (company_id, mailbox_address)
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS company_mailbox_ingest_folders (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        mailbox_address TEXT NOT NULL,
        folder_id TEXT,
        folder_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'seed',
        last_checkpoint TEXT,
        last_scan_at TEXT,
        last_messages_scanned INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    )
    .run();
}

export function normalizeFolderName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isDefaultExcludedFolder(name: string | null | undefined): boolean {
  const key = normalizeFolderName(name);
  return (DEFAULT_EXCLUDED_FOLDER_NAMES as readonly string[]).includes(key);
}

export function isInboxFolder(name: string | null | undefined): boolean {
  return normalizeFolderName(name) === "inbox";
}

export function isSentItemsFolder(name: string | null | undefined): boolean {
  const key = normalizeFolderName(name);
  return key === "sent items" || key === "sentitems";
}

export function isArchiveFolder(name: string | null | undefined): boolean {
  return normalizeFolderName(name) === "archive";
}

export function isFolderCoveredByCurrentIngestPolicy(input: {
  folderName: string | null | undefined;
  folderId?: string | null;
  enabledFolders: Array<{ folder_name: string; folder_id?: string | null }>;
  includeSent: boolean;
  includeArchive: boolean;
}): boolean {
  if (isInboxFolder(input.folderName)) return true;
  if (isDefaultExcludedFolder(input.folderName)) return false;
  if (isSentItemsFolder(input.folderName)) return input.includeSent;
  if (isArchiveFolder(input.folderName)) return input.includeArchive;
  const name = normalizeFolderName(input.folderName);
  const id = (input.folderId ?? "").trim();
  return input.enabledFolders.some((folder) => {
    if (folder.folder_id && id && folder.folder_id === id) return true;
    return normalizeFolderName(folder.folder_name) === name;
  });
}

export async function getMailboxFolderSettings(
  db: D1Database,
  companyId: string,
  mailboxAddress: string,
): Promise<{ includeSent: boolean; includeArchive: boolean }> {
  await ensureMailboxIngestFolderPolicySchema(db);
  const row = await db
    .prepare(
      `SELECT include_sent, include_archive FROM company_mailbox_folder_settings
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) LIMIT 1`,
    )
    .bind(companyId, mailboxAddress)
    .first<{ include_sent: number; include_archive: number }>();
  return {
    includeSent: row?.include_sent === 1,
    includeArchive: row?.include_archive === 1,
  };
}

export async function upsertMailboxFolderSettings(
  db: D1Database,
  input: {
    companyId: string;
    mailboxAddress: string;
    includeSent?: boolean;
    includeArchive?: boolean;
  },
): Promise<void> {
  await ensureMailboxIngestFolderPolicySchema(db);
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT id, include_sent, include_archive FROM company_mailbox_folder_settings
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) LIMIT 1`,
    )
    .bind(input.companyId, input.mailboxAddress)
    .first<{ id: string; include_sent: number; include_archive: number }>();
  const includeSent = input.includeSent ?? existing?.include_sent === 1;
  const includeArchive = input.includeArchive ?? existing?.include_archive === 1;
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE company_mailbox_folder_settings
         SET include_sent = ?, include_archive = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(includeSent ? 1 : 0, includeArchive ? 1 : 0, now, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO company_mailbox_folder_settings (
        id, company_id, mailbox_address, include_sent, include_archive, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("mfs"),
      input.companyId,
      input.mailboxAddress.toLowerCase(),
      includeSent ? 1 : 0,
      includeArchive ? 1 : 0,
      now,
      now,
    )
    .run();
}

export async function listEnabledMailboxFolders(
  db: D1Database,
  companyId: string,
  mailboxAddress: string,
): Promise<MailboxIngestFolderRow[]> {
  await ensureMailboxIngestFolderPolicySchema(db);
  const result = await db
    .prepare(
      `SELECT * FROM company_mailbox_ingest_folders
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) AND enabled = 1
       ORDER BY folder_name`,
    )
    .bind(companyId, mailboxAddress)
    .all<MailboxIngestFolderRow>();
  return result.results ?? [];
}

export async function upsertApprovedMailboxFolder(
  db: D1Database,
  input: {
    companyId: string;
    mailboxAddress: string;
    folderName: string;
    folderId?: string | null;
    enabled?: boolean;
    source?: string;
  },
): Promise<string> {
  await ensureMailboxIngestFolderPolicySchema(db);
  const now = nowIso();
  const name = input.folderName.trim();
  const existing = await db
    .prepare(
      `SELECT id FROM company_mailbox_ingest_folders
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) AND lower(folder_name) = lower(?)
       LIMIT 1`,
    )
    .bind(input.companyId, input.mailboxAddress, name)
    .first<{ id: string }>();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE company_mailbox_ingest_folders
         SET folder_id = COALESCE(?, folder_id),
             folder_name = ?,
             enabled = ?,
             source = COALESCE(?, source),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.folderId ?? null,
        name,
        input.enabled === false ? 0 : 1,
        input.source ?? null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }
  const id = newId("mfp");
  await db
    .prepare(
      `INSERT INTO company_mailbox_ingest_folders (
        id, company_id, mailbox_address, folder_id, folder_name, enabled, source,
        last_checkpoint, last_scan_at, last_messages_scanned, last_error, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.mailboxAddress.toLowerCase(),
      input.folderId ?? null,
      name,
      input.enabled === false ? 0 : 1,
      input.source ?? "seed",
      now,
      now,
    )
    .run();
  return id;
}

export async function markFolderScanResult(
  db: D1Database,
  input: {
    companyId: string;
    mailboxAddress: string;
    folderName: string;
    folderId?: string | null;
    checkpoint?: string | null;
    success: boolean;
    messagesScanned?: number | null;
    error?: string | null;
  },
): Promise<void> {
  await ensureMailboxIngestFolderPolicySchema(db);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE company_mailbox_ingest_folders SET
        folder_id = COALESCE(?, folder_id),
        last_scan_at = ?,
        last_checkpoint = CASE WHEN ? AND ? IS NOT NULL THEN ? ELSE last_checkpoint END,
        last_messages_scanned = CASE WHEN ? IS NOT NULL THEN ? ELSE last_messages_scanned END,
        last_error = ?,
        updated_at = ?
       WHERE company_id = ? AND lower(mailbox_address) = lower(?) AND lower(folder_name) = lower(?)`,
    )
    .bind(
      input.folderId ?? null,
      now,
      input.success ? 1 : 0,
      input.checkpoint ?? null,
      input.checkpoint ?? null,
      input.messagesScanned == null ? null : input.messagesScanned,
      input.messagesScanned == null ? null : input.messagesScanned,
      input.success ? null : input.error ?? "folder scan failed",
      now,
      input.companyId,
      input.mailboxAddress,
      input.folderName,
    )
    .run();
}

export async function seedApprovedMailboxFolderPolicies(db: D1Database, companyId: string): Promise<void> {
  if (!isElvexCompany({ id: companyId }) && companyId !== ELVEX_COMPANY_ID) return;
  await ensureMailboxIngestFolderPolicySchema(db);
  for (const seed of EL_SEEDED_MAILBOX_FOLDER_APPROVALS) {
    await upsertMailboxFolderSettings(db, {
      companyId,
      mailboxAddress: seed.mailboxAddress,
      includeSent: seed.includeSent,
      includeArchive: seed.includeArchive,
    });
    for (const folderName of seed.folderNames) {
      await upsertApprovedMailboxFolder(db, {
        companyId,
        mailboxAddress: seed.mailboxAddress,
        folderName,
        enabled: true,
        source: "seed",
      });
    }
  }
}

export function matchFolderRef(
  folders: GraphFolderRef[],
  input: { folderId?: string | null; folderName?: string | null },
): GraphFolderRef | null {
  if (input.folderId) {
    const byId = folders.find((folder) => folder.id === input.folderId);
    if (byId) return byId;
  }
  const want = normalizeFolderName(input.folderName);
  if (!want) return null;
  return folders.find((folder) => normalizeFolderName(folder.displayName) === want) ?? null;
}

export function resolveApprovedIngestFolders(input: {
  inbox: GraphFolderRef;
  listedFolders: GraphFolderRef[];
  enabledPolicies: MailboxIngestFolderRow[];
  includeSent: boolean;
  includeArchive: boolean;
  sent?: GraphFolderRef | null;
  archive?: GraphFolderRef | null;
}): { folders: ResolvedIngestFolder[]; unresolved: Array<{ folderName: string; reason: string }> } {
  const folders: ResolvedIngestFolder[] = [
    {
      folderId: input.inbox.id,
      folderName: input.inbox.displayName || "Inbox",
      kind: "inbox",
      source: "always",
      lastCheckpoint: null,
    },
  ];
  const seen = new Set<string>([input.inbox.id]);
  const unresolved: Array<{ folderName: string; reason: string }> = [];

  for (const policy of input.enabledPolicies) {
    if (isInboxFolder(policy.folder_name)) {
      const inbox = folders[0];
      if (inbox) {
        inbox.lastCheckpoint = policy.last_checkpoint;
        inbox.policyId = policy.id;
      }
      continue;
    }
    if (isDefaultExcludedFolder(policy.folder_name)) {
      unresolved.push({ folderName: policy.folder_name, reason: "system folder is excluded by default" });
      continue;
    }
    if (isSentItemsFolder(policy.folder_name) && !input.includeSent) {
      unresolved.push({ folderName: policy.folder_name, reason: "Sent Items is not enabled for this mailbox" });
      continue;
    }
    if (isArchiveFolder(policy.folder_name) && !input.includeArchive) {
      unresolved.push({ folderName: policy.folder_name, reason: "Archive is not enabled for this mailbox" });
      continue;
    }
    const matched = matchFolderRef(input.listedFolders, {
      folderId: policy.folder_id,
      folderName: policy.folder_name,
    });
    if (!matched) {
      unresolved.push({ folderName: policy.folder_name, reason: "FOLDER_NOT_FOUND" });
      continue;
    }
    if (seen.has(matched.id)) continue;
    seen.add(matched.id);
    folders.push({
      folderId: matched.id,
      folderName: matched.displayName || policy.folder_name,
      kind: isSentItemsFolder(matched.displayName)
        ? "sent"
        : isArchiveFolder(matched.displayName)
          ? "archive"
          : "user",
      source: policy.source,
      lastCheckpoint: policy.last_checkpoint,
      policyId: policy.id,
    });
  }

  if (input.includeSent && input.sent && !seen.has(input.sent.id)) {
    seen.add(input.sent.id);
    folders.push({
      folderId: input.sent.id,
      folderName: input.sent.displayName || "Sent Items",
      kind: "sent",
      source: "mailbox_setting",
      lastCheckpoint: null,
    });
  }
  if (input.includeArchive && input.archive && !seen.has(input.archive.id)) {
    folders.push({
      folderId: input.archive.id,
      folderName: input.archive.displayName || "Archive",
      kind: "archive",
      source: "mailbox_setting",
      lastCheckpoint: null,
    });
  }

  return { folders, unresolved };
}
