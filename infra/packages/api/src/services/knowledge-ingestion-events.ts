/**
 * Tenant-aware knowledge ingestion event ledger.
 * Used by daily activity reporting and future company MCPs.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";

export const KNOWLEDGE_INGESTION_EVENT_TYPES = [
  "discovered",
  "fetched",
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
  if (row.source_modified_at) return inRange(row.source_modified_at);
  if (row.indexed_at) return inRange(row.indexed_at);
  return inRange(row.discovered_at) || inRange(row.created_at);
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
           (source_modified_at IS NOT NULL AND source_modified_at BETWEEN ? AND ?)
           OR (indexed_at IS NOT NULL AND indexed_at BETWEEN ? AND ?)
           OR (
             source_modified_at IS NULL AND indexed_at IS NULL
             AND COALESCE(discovered_at, created_at) BETWEEN ? AND ?
           )
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
