/**
 * Shared Microsoft knowledge item persistence — used by sync and queue consumer.
 */

import type { MicrosoftSourceType } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";

export async function upsertKnowledgeItem(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    sourceType: MicrosoftSourceType;
    externalItemId: string;
    externalId: string;
    title: string;
    path: string | null;
    mimeType: string | null;
    modifiedAt: string | null;
    webUrl: string | null;
    sizeBytes: number | null;
    eTag: string | null;
    provenance: Record<string, unknown>;
    indexingStatus: string;
    knowledgeDocumentId?: number | null;
    lastError?: string | null;
  },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM microsoft_knowledge_items
       WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.externalItemId)
    .first<{ id: string }>();

  const now = nowIso();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE microsoft_knowledge_items SET
          title = ?, path = ?, mime_type = ?, modified_at = ?, web_url = ?, size_bytes = ?,
          e_tag = ?, provenance_json = ?, indexing_status = ?, knowledge_document_id = ?,
          external_id = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.title,
        input.path,
        input.mimeType,
        input.modifiedAt,
        input.webUrl,
        input.sizeBytes,
        input.eTag,
        JSON.stringify(input.provenance),
        input.indexingStatus,
        input.knowledgeDocumentId ?? null,
        input.externalId,
        input.lastError ?? null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }

  const id = newId("mki");
  await db
    .prepare(
      `INSERT INTO microsoft_knowledge_items (
        id, company_id, connector_instance_id, source_id, source_type, external_item_id,
        external_id, title, path, mime_type, modified_at, web_url, size_bytes, e_tag,
        provenance_json, indexing_status, knowledge_document_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      input.sourceId,
      input.sourceType,
      input.externalItemId,
      input.externalId,
      input.title,
      input.path,
      input.mimeType,
      input.modifiedAt,
      input.webUrl,
      input.sizeBytes,
      input.eTag,
      JSON.stringify(input.provenance),
      input.indexingStatus,
      input.knowledgeDocumentId ?? null,
      input.lastError ?? null,
      now,
      now,
    )
    .run();
  return id;
}
