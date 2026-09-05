/**
 * Tenant-aware knowledge ingestion event ledger.
 * Used by daily activity reporting and future company MCPs.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";

export const KNOWLEDGE_INGESTION_EVENT_TYPES = [
  "discovered",
  "fetched",
  "stored",
  "extracted",
  "indexed",
  "reindexed",
  "skipped",
  "duplicate",
  "failed",
  "source_observed",
] as const;

export type KnowledgeIngestionEventType = (typeof KNOWLEDGE_INGESTION_EVENT_TYPES)[number];

export type KnowledgeIngestionEventInput = {
  companyId: string;
  sourceType: string;
  eventType: KnowledgeIngestionEventType;
  providerItemId?: string | null;
  parentMessageId?: string | null;
  filename?: string | null;
  contentHash?: string | null;
  mailboxAddress?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  chunkCount?: number | null;
  skipReason?: string | null;
  failureCode?: string | null;
  discoveredAt?: string | null;
  sourceModifiedAt?: string | null;
  fetchedAt?: string | null;
  extractedAt?: string | null;
  indexedAt?: string | null;
  storedAt?: string | null;
  storedItemId?: string | null;
  storedUrl?: string | null;
  retryCount?: number | null;
  metadata?: Record<string, unknown> | null;
};

export async function ensureKnowledgeIngestionEventsSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS knowledge_ingestion_events (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_item_id TEXT,
        parent_message_id TEXT,
        filename TEXT,
        content_hash TEXT,
        mailbox_address TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        chunk_count INTEGER,
        skip_reason TEXT,
        failure_code TEXT,
        discovered_at TEXT,
        source_modified_at TEXT,
        fetched_at TEXT,
        extracted_at TEXT,
        indexed_at TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_ingestion_events_company_window
       ON knowledge_ingestion_events(company_id, created_at)`,
    )
    .run();
  for (const column of [
    "ALTER TABLE knowledge_ingestion_events ADD COLUMN stored_at TEXT",
    "ALTER TABLE knowledge_ingestion_events ADD COLUMN stored_item_id TEXT",
    "ALTER TABLE knowledge_ingestion_events ADD COLUMN stored_url TEXT",
    "ALTER TABLE knowledge_ingestion_events ADD COLUMN retry_count INTEGER",
  ]) {
    await db.prepare(column).run().catch(() => undefined);
  }
}

export async function recordKnowledgeIngestionEvent(
  db: D1Database,
  input: KnowledgeIngestionEventInput,
): Promise<string> {
  await ensureKnowledgeIngestionEventsSchema(db);
  const now = nowIso();
  const existing = input.providerItemId
    ? await db
        .prepare(
          `SELECT id FROM knowledge_ingestion_events
           WHERE company_id = ? AND source_type = ? AND event_type = ?
             AND IFNULL(provider_item_id,'') = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(input.companyId, input.sourceType, input.eventType, input.providerItemId)
        .first<{ id: string }>()
    : null;
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE knowledge_ingestion_events
         SET status = ?, filename = COALESCE(?, filename), content_hash = COALESCE(?, content_hash),
             mailbox_address = COALESCE(?, mailbox_address), mime_type = COALESCE(?, mime_type),
             size_bytes = COALESCE(?, size_bytes), chunk_count = COALESCE(?, chunk_count),
             skip_reason = COALESCE(?, skip_reason), failure_code = COALESCE(?, failure_code),
             source_modified_at = COALESCE(?, source_modified_at), fetched_at = COALESCE(?, fetched_at),
             extracted_at = COALESCE(?, extracted_at), indexed_at = COALESCE(?, indexed_at),
             stored_at = COALESCE(?, stored_at), stored_item_id = COALESCE(?, stored_item_id),
             stored_url = COALESCE(?, stored_url), retry_count = COALESCE(?, retry_count),
             metadata_json = COALESCE(?, metadata_json), updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.eventType,
        input.filename ?? null,
        input.contentHash ?? null,
        input.mailboxAddress ?? null,
        input.mimeType ?? null,
        input.sizeBytes ?? null,
        input.chunkCount ?? null,
        input.skipReason ?? null,
        input.failureCode ?? null,
        input.sourceModifiedAt ?? null,
        input.fetchedAt ?? null,
        input.extractedAt ?? null,
        input.indexedAt ?? null,
        input.storedAt ?? null,
        input.storedItemId ?? null,
        input.storedUrl ?? null,
        input.retryCount ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }
  const id = newId("kie");
  await db
    .prepare(
      `INSERT INTO knowledge_ingestion_events (
        id, company_id, source_type, event_type, status, provider_item_id, parent_message_id,
        filename, content_hash, mailbox_address, mime_type, size_bytes, chunk_count,
        skip_reason, failure_code, discovered_at, source_modified_at, fetched_at,
        extracted_at, indexed_at, stored_at, stored_item_id, stored_url, retry_count,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.sourceType,
      input.eventType,
      input.eventType,
      input.providerItemId ?? null,
      input.parentMessageId ?? null,
      input.filename ?? null,
      input.contentHash ?? null,
      input.mailboxAddress ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.chunkCount ?? null,
      input.skipReason ?? null,
      input.failureCode ?? null,
      input.discoveredAt ?? now,
      input.sourceModifiedAt ?? null,
      input.fetchedAt ?? null,
      input.extractedAt ?? null,
      input.indexedAt ?? null,
      input.storedAt ?? null,
      input.storedItemId ?? null,
      input.storedUrl ?? null,
      input.retryCount ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    )
    .run();
  return id;
}

export type KnowledgeIngestionEventRow = {
  id: string;
  company_id: string;
  source_type: string;
  event_type: string;
  status: string;
  provider_item_id: string | null;
  parent_message_id: string | null;
  filename: string | null;
  content_hash: string | null;
  mailbox_address: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  chunk_count: number | null;
  skip_reason: string | null;
  failure_code: string | null;
  discovered_at: string | null;
  source_modified_at: string | null;
  indexed_at: string | null;
  stored_at: string | null;
  stored_item_id: string | null;
  stored_url: string | null;
  retry_count: number | null;
  created_at: string;
  metadata_json: string | null;
};

export function knowledgeIngestionEventInWindow(
  row: {
    source_modified_at?: string | null;
    indexed_at?: string | null;
    discovered_at?: string | null;
    created_at?: string | null;
  },
  windowFrom: string,
  windowTo: string,
): boolean {
  const start = Date.parse(windowFrom);
  const end = Date.parse(windowTo);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const inRange = (value?: string | null) => {
    if (!value) return false;
    const ts = Date.parse(value);
    return Number.isFinite(ts) && ts >= start && ts <= end;
  };
  if (
    inRange(row.created_at) ||
    inRange(row.discovered_at) ||
    inRange(row.indexed_at) ||
    inRange(row.stored_at)
  ) {
    return true;
  }
  return inRange(row.source_modified_at);
}

export async function listKnowledgeIngestionEvents(
  db: D1Database,
  input: { companyId: string; windowFrom: string; windowTo: string; limit?: number },
): Promise<KnowledgeIngestionEventRow[]> {
  await ensureKnowledgeIngestionEventsSchema(db);
  const result = await db
    .prepare(
      `SELECT id, company_id, source_type, event_type, status, provider_item_id, parent_message_id,
              filename, content_hash, mailbox_address, mime_type, size_bytes, chunk_count, skip_reason,
              failure_code, discovered_at, source_modified_at, indexed_at, stored_at, stored_item_id,
              stored_url, retry_count, created_at, metadata_json
       FROM knowledge_ingestion_events
       WHERE company_id = ?
         AND (
           created_at BETWEEN ? AND ?
           OR discovered_at BETWEEN ? AND ?
           OR indexed_at BETWEEN ? AND ?
           OR stored_at BETWEEN ? AND ?
           OR (source_modified_at IS NOT NULL AND source_modified_at BETWEEN ? AND ?)
         )
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(
      input.companyId,
      input.windowFrom,
      input.windowTo,
      input.windowFrom,
      input.windowTo,
      input.windowFrom,
      input.windowTo,
      input.windowFrom,
      input.windowTo,
      input.windowFrom,
      input.windowTo,
      input.limit ?? 400,
    )
    .all<KnowledgeIngestionEventRow>();
  return (result.results ?? []).filter((row) =>
    knowledgeIngestionEventInWindow(row, input.windowFrom, input.windowTo),
  );
}

export async function recordJobIngestionEvent(
  env: Pick<Env, "DB">,
  input: {
    companyId: string;
    sourceType: string;
    status: string;
    filename?: string | null;
    providerItemId?: string | null;
    parentMessageId?: string | null;
    mailboxAddress?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    chunkCount?: number | null;
    skipReason?: string | null;
    sourceModifiedAt?: string | null;
  },
): Promise<void> {
  const mapped =
    input.status === "indexed"
      ? "indexed"
      : input.status === "skipped_unchanged"
        ? "duplicate"
        : input.status === "unsupported"
          ? "skipped"
          : input.status === "failed" || input.status === "dead_letter"
            ? "failed"
            : input.status === "catalogue_only"
              ? "extracted"
              : null;
  if (!mapped) return;
  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: input.sourceType,
    eventType: mapped,
    providerItemId: input.providerItemId,
    parentMessageId: input.parentMessageId,
    filename: input.filename,
    mailboxAddress: input.mailboxAddress,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    chunkCount: input.chunkCount,
    skipReason: input.skipReason ?? (mapped === "duplicate" ? "unchanged" : null),
    failureCode: mapped === "failed" ? input.status : null,
    sourceModifiedAt: input.sourceModifiedAt,
    indexedAt: mapped === "indexed" ? nowIso() : null,
    metadata: { jobStatus: input.status },
  });
}

export const MAILBOX_FAILURE_MAX_RETRIES = 5;

const TERMINAL_SKIP_CODES = new Set([
  "UNSUPPORTED",
  "UNSUPPORTED_MIME",
  "UNSUPPORTED_TYPE",
  "JUNK",
  "EMPTY_WORKBOOK",
]);
const TERMINAL_FAIL_CODES = new Set(["CORRUPT_WORKBOOK", "CORRUPT", "MALFORMED_WORKBOOK"]);
const TRANSIENT_CODES = new Set([
  "FETCH_FAILED",
  "FETCH_TRANSIENT",
  "ATTACHMENT_ENUM_FAILED",
  "MCP_UNAVAILABLE",
  "INDEX_WRITE_FAILED",
  "NOT_INDEXED",
  "RETRIEVAL_UNVERIFIED",
  "KNOWLEDGE_EXTRACT_EMPTY",
  "KNOWLEDGE_INDEX_WRITE_FAILED",
]);

export function classifyMailboxAttachmentFailure(code: string | null | undefined): {
  retryable: boolean;
  terminal: boolean;
  eventType: "failed" | "skipped";
} {
  const value = String(code ?? "").trim();
  if (TERMINAL_SKIP_CODES.has(value)) return { retryable: false, terminal: true, eventType: "skipped" };
  if (TERMINAL_FAIL_CODES.has(value)) return { retryable: false, terminal: true, eventType: "failed" };
  if (TRANSIENT_CODES.has(value) || !value) return { retryable: true, terminal: false, eventType: "failed" };
  return { retryable: true, terminal: false, eventType: "failed" };
}

export function mailboxFailureLedgerMetadata(input: {
  company?: string;
  mailbox?: string | null;
  folder?: string | null;
  messageId?: string | null;
  attachmentId?: string | null;
  filename?: string | null;
  stage?: string | null;
  errorClass?: string | null;
  retryable?: boolean;
  attemptCount?: number;
  lastAttempt?: string | null;
  nextRetry?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    company: input.company ?? null,
    mailbox: input.mailbox ?? null,
    folder: input.folder ?? null,
    messageId: input.messageId ?? null,
    attachmentId: input.attachmentId ?? null,
    filename: input.filename ?? null,
    stage: input.stage ?? null,
    errorClass: input.errorClass ?? null,
    retryable: input.retryable ?? true,
    attemptCount: input.attemptCount ?? 0,
    lastAttempt: input.lastAttempt ?? nowIso(),
    nextRetry: input.nextRetry ?? null,
    ...(input.extra ?? {}),
  };
}

export async function listFailedMailboxAttachmentEvents(
  db: D1Database,
  input: { companyId: string; mailboxAddresses?: string[]; limit?: number },
): Promise<KnowledgeIngestionEventRow[]> {
  await ensureKnowledgeIngestionEventsSchema(db);
  const addresses = (input.mailboxAddresses ?? []).map((row) => row.trim().toLowerCase()).filter(Boolean);
  const retryableWhere = `source_type IN ('outlook_attachments', 'outlook_attachment')
             AND (
               event_type = 'failed'
               OR (event_type = 'extracted' AND failure_code IN ('NOT_INDEXED','RETRIEVAL_UNVERIFIED','KNOWLEDGE_EXTRACT_EMPTY'))
             )
             AND IFNULL(retry_count, 0) < ${MAILBOX_FAILURE_MAX_RETRIES}
             AND IFNULL(json_extract(metadata_json, '$.retryable'), 1) != 0`;
  const result = addresses.length
    ? await db
        .prepare(
          `SELECT id, company_id, source_type, event_type, status, provider_item_id, parent_message_id,
                  filename, content_hash, mailbox_address, mime_type, size_bytes, chunk_count, skip_reason,
                  failure_code, discovered_at, source_modified_at, indexed_at, stored_at, stored_item_id,
                  stored_url, retry_count, created_at, metadata_json
           FROM knowledge_ingestion_events
           WHERE company_id = ?
             AND ${retryableWhere}
             AND lower(IFNULL(mailbox_address,'')) IN (${addresses.map(() => "?").join(",")})
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .bind(input.companyId, ...addresses, input.limit ?? 80)
        .all<KnowledgeIngestionEventRow>()
    : await db
        .prepare(
          `SELECT id, company_id, source_type, event_type, status, provider_item_id, parent_message_id,
                  filename, content_hash, mailbox_address, mime_type, size_bytes, chunk_count, skip_reason,
                  failure_code, discovered_at, source_modified_at, indexed_at, stored_at, stored_item_id,
                  stored_url, retry_count, created_at, metadata_json
           FROM knowledge_ingestion_events
           WHERE company_id = ?
             AND ${retryableWhere}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .bind(input.companyId, input.limit ?? 80)
        .all<KnowledgeIngestionEventRow>();
  return result.results ?? [];
}

export async function backfillMissingMailboxFailureLedger(
  db: D1Database,
  input: { companyId: string; mailboxAddress: string },
): Promise<{ recovered: number; unrecoverable: number; recoveredIds: string[] }> {
  await ensureKnowledgeIngestionEventsSchema(db);
  const mailbox = input.mailboxAddress.trim().toLowerCase();
  const rows = await db
    .prepare(
      `SELECT id, event_type, provider_item_id, parent_message_id, filename, failure_code, skip_reason,
              retry_count, metadata_json, source_modified_at
       FROM knowledge_ingestion_events
       WHERE company_id = ?
         AND source_type IN ('outlook_attachments', 'outlook_attachment')
         AND lower(IFNULL(mailbox_address,'')) = ?
       ORDER BY created_at ASC`,
    )
    .bind(input.companyId, mailbox)
    .all<{
      id: string;
      event_type: string;
      provider_item_id: string | null;
      parent_message_id: string | null;
      filename: string | null;
      failure_code: string | null;
      skip_reason: string | null;
      retry_count: number | null;
      metadata_json: string | null;
      source_modified_at: string | null;
    }>();
  const byProvider = new Map<string, typeof rows.results>();
  for (const row of rows.results ?? []) {
    const key = String(row.provider_item_id ?? "").trim();
    if (!key) continue;
    const list = byProvider.get(key) ?? [];
    list.push(row);
    byProvider.set(key, list);
  }
  let recovered = 0;
  let unrecoverable = 0;
  const recoveredIds: string[] = [];
  const terminal = new Set(["failed", "skipped", "indexed", "duplicate"]);
  for (const [providerItemId, events] of byProvider) {
    const last = events[events.length - 1];
    if (!last) continue;
    if (terminal.has(last.event_type)) continue;
    if (last.event_type === "extracted" && last.failure_code) {
      // already visible to retry query
      continue;
    }
    const parts = providerItemId.includes("|") ? providerItemId.split("|") : [last.parent_message_id ?? providerItemId, ""];
    const messageId = parts[0] || last.parent_message_id;
    const attachmentId = parts[1] || null;
    if (!messageId) {
      unrecoverable += 1;
      continue;
    }
    if (providerItemId.includes("|") && !attachmentId) {
      unrecoverable += 1;
      continue;
    }
    const id = await recordKnowledgeIngestionEvent(db, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      parentMessageId: messageId,
      filename: last.filename,
      mailboxAddress: input.mailboxAddress,
      failureCode: last.failure_code ?? "LEGACY_FAILURE_UNLOGGED",
      skipReason: last.skip_reason ?? "Recovered from incomplete ledger trail",
      retryCount: last.retry_count ?? 0,
      sourceModifiedAt: last.source_modified_at,
      metadata: mailboxFailureLedgerMetadata({
        company: input.companyId,
        mailbox: input.mailboxAddress,
        messageId,
        attachmentId,
        filename: last.filename,
        stage: last.event_type,
        errorClass: last.failure_code ?? "LEGACY_FAILURE_UNLOGGED",
        retryable: true,
        extra: { recovered: true },
      }),
    });
    recovered += 1;
    recoveredIds.push(id);
  }
  for (const row of rows.results ?? []) {
    if (row.provider_item_id) continue;
    if (row.event_type === "failed" || row.event_type === "skipped") continue;
    unrecoverable += 1;
  }
  return { recovered, unrecoverable, recoveredIds };
}

export async function listRecentKnowledgeIntakeEvents(
  db: D1Database,
  input: { companyId: string; limit?: number },
): Promise<KnowledgeIngestionEventRow[]> {
  await ensureKnowledgeIngestionEventsSchema(db);
  const result = await db
    .prepare(
      `SELECT id, company_id, source_type, event_type, status, provider_item_id, parent_message_id,
              filename, content_hash, mailbox_address, mime_type, size_bytes, chunk_count, skip_reason,
              failure_code, discovered_at, source_modified_at, indexed_at, stored_at, stored_item_id,
              stored_url, retry_count, created_at, metadata_json
       FROM knowledge_ingestion_events
       WHERE company_id = ?
         AND source_type IN ('outlook_attachments', 'outlook_attachment')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(input.companyId, input.limit ?? 100)
    .all<KnowledgeIngestionEventRow>();
  return result.results ?? [];
}
