/**
 * Cloudflare Queue producer/consumer for Microsoft 365 file ingestion.
 * One file per queue message — credentials are resolved server-side only.
 */

import type { Env } from "../env";
import type { MicrosoftSourceType } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { listMcpEnvironments } from "./control-plane";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  buildMicrosoftProvenance,
  classifyMicrosoftFile,
  downloadDriveItemContent,
  formatMicrosoftSourceLabel,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import {
  buildMicrosoftExternalId,
  buildMicrosoftMailExternalId,
  buildOutlookAttachmentMetadata,
  buildOutlookKnowledgeProvenance,
  lookupParentKnowledgeDocumentId,
  mapKnowledgeIndexOutcomeToMicrosoftStatus,
  reactivateMicrosoftKnowledgeDocument,
  uploadMicrosoftDocumentToKnowledge,
} from "./microsoft-knowledge-bridge";
import { listMessageAttachments } from "./microsoft-outlook-graph";
import { upsertKnowledgeItem } from "./microsoft-sync-internals";
import {
  buildMailKnowledgeText,
  getMailboxMessage,
  getMessageAttachmentContent,
} from "./microsoft-outlook-graph";

export const MICROSOFT_KNOWLEDGE_INGEST_QUEUE = "microsoft-knowledge-ingest";
export const MICROSOFT_KNOWLEDGE_INGEST_DLQ = "microsoft-knowledge-ingest-dlq";

export const MICROSOFT_QUEUE_MAX_RETRIES = 5;

export type MicrosoftFileJobStatus =
  | "queued"
  | "processing"
  | "indexed"
  | "skipped_unchanged"
  | "unsupported"
  | "catalogue_only"
  | "failed"
  | "retrying"
  | "dead_letter";

/** Queue payload — identifiers only; no tokens or secrets. */
export type MicrosoftFileJobMessage = {
  jobId: string;
  companyId: string;
  sourceId: string;
  syncRunId: string;
};

export type MicrosoftFileJobRow = {
  id: string;
  company_id: string;
  connector_instance_id: string;
  source_id: string;
  sync_run_id: string;
  external_item_id: string;
  drive_id: string;
  file_name: string;
  relative_path: string | null;
  mime_type: string | null;
  e_tag: string | null;
  modified_at: string | null;
  web_url: string | null;
  size_bytes: number | null;
  action: "index" | "delete";
  status: MicrosoftFileJobStatus;
  attempts: number;
  last_error: string | null;
  item_kind?: string | null;
  parent_message_id?: string | null;
  attachment_id?: string | null;
};

export function hasMicrosoftKnowledgeQueue(env: Env): boolean {
  return typeof env.MICROSOFT_KNOWLEDGE_QUEUE !== "undefined" && env.MICROSOFT_KNOWLEDGE_QUEUE !== null;
}

export async function getMicrosoftSourceJobStats(
  db: D1Database,
  input: { companyId: string; sourceId: string; syncRunId?: string | null },
): Promise<{
  byStatus: Record<string, number>;
  total: number;
  pending: number;
  latestSyncRunId: string | null;
  latestFailure: { fileName: string; error: string; at: string } | null;
}> {
  const runFilter = input.syncRunId
    ? ` AND sync_run_id = ?`
    : ` AND sync_run_id = (
        SELECT id FROM microsoft_sync_runs
        WHERE company_id = ? AND connector_instance_id = (
          SELECT connector_instance_id FROM microsoft_connector_sources WHERE id = ? LIMIT 1
        )
        ORDER BY started_at DESC LIMIT 1
      )`;
  const binds = input.syncRunId
    ? [input.companyId, input.sourceId, input.syncRunId]
    : [input.companyId, input.sourceId, input.companyId, input.sourceId];

  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM microsoft_file_jobs
       WHERE company_id = ? AND source_id = ?${runFilter}
       GROUP BY status`,
    )
    .bind(...binds)
    .all<{ status: string; count: number }>();

  const byStatus: Record<string, number> = {};
  let total = 0;
  let pending = 0;
  for (const row of rows.results ?? []) {
    byStatus[row.status] = Number(row.count);
    total += Number(row.count);
    if (row.status === "queued" || row.status === "processing" || row.status === "retrying") {
      pending += Number(row.count);
    }
  }

  const latestRun = await db
    .prepare(
      `SELECT sync_run_id FROM microsoft_file_jobs
       WHERE company_id = ? AND source_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.companyId, input.sourceId)
    .first<{ sync_run_id: string }>();

  const latestFailure = await db
    .prepare(
      `SELECT file_name, last_error, updated_at FROM microsoft_file_jobs
       WHERE company_id = ? AND source_id = ? AND status IN ('failed', 'dead_letter')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(input.companyId, input.sourceId)
    .first<{ file_name: string; last_error: string; updated_at: string }>();

  return {
    byStatus,
    total,
    pending,
    latestSyncRunId: latestRun?.sync_run_id ?? null,
    latestFailure: latestFailure?.last_error
      ? {
          fileName: latestFailure.file_name,
          error: latestFailure.last_error,
          at: latestFailure.updated_at,
        }
      : null,
  };
}

async function loadJob(db: D1Database, jobId: string): Promise<MicrosoftFileJobRow | null> {
  return db
    .prepare(`SELECT * FROM microsoft_file_jobs WHERE id = ? LIMIT 1`)
    .bind(jobId)
    .first<MicrosoftFileJobRow>();
}

async function loadSourceContext(
  db: D1Database,
  companyId: string,
  sourceId: string,
): Promise<{
  sourceType: MicrosoftSourceType;
  externalId: string;
  displayName: string;
  siteId: string | null;
  connectorInstanceId: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT source_type, external_id, display_name, site_id, connector_instance_id
       FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`,
    )
    .bind(sourceId, companyId)
    .first<{
      source_type: string;
      external_id: string;
      display_name: string;
      site_id: string | null;
      connector_instance_id: string;
    }>();
  if (!row) return null;
  return {
    sourceType: row.source_type as MicrosoftSourceType,
    externalId: row.external_id,
    displayName: row.display_name,
    siteId: row.site_id,
    connectorInstanceId: row.connector_instance_id,
  };
}

export async function createMicrosoftFileJob(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    syncRunId: string;
    driveId: string;
    externalItemId: string;
    fileName: string;
    relativePath: string;
    mimeType: string | null;
    eTag: string | null;
    modifiedAt: string | null;
    webUrl: string | null;
    sizeBytes: number | null;
    itemKind?: "drive_file" | "mail_message" | "mail_attachment";
    parentMessageId?: string | null;
    attachmentId?: string | null;
    sendToQueue?: boolean;
  },
): Promise<{ jobId: string; enqueued: boolean; duplicate: boolean }> {
  const existingActive = await env.DB.prepare(
    `SELECT id FROM microsoft_file_jobs
     WHERE company_id = ? AND source_id = ? AND external_item_id = ?
       AND e_tag IS ? AND status IN ('queued', 'processing', 'retrying')
     LIMIT 1`,
  )
    .bind(input.companyId, input.sourceId, input.externalItemId, input.eTag)
    .first<{ id: string }>();

  if (existingActive?.id) {
    return { jobId: existingActive.id, enqueued: false, duplicate: true };
  }

  const jobId = newId("msj");
  const now = nowIso();
  const itemKind = input.itemKind ?? "drive_file";
  await env.DB.prepare(
    `INSERT INTO microsoft_file_jobs (
      id, company_id, connector_instance_id, source_id, sync_run_id,
      external_item_id, drive_id, file_name, relative_path, mime_type,
      e_tag, modified_at, web_url, size_bytes, action, status, attempts,
      item_kind, parent_message_id, attachment_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'index', 'queued', 0, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      input.companyId,
      input.connectorInstanceId,
      input.sourceId,
      input.syncRunId,
      input.externalItemId,
      input.driveId,
      input.fileName,
      input.relativePath,
      input.mimeType,
      input.eTag,
      input.modifiedAt,
      input.webUrl,
      input.sizeBytes,
      itemKind,
      input.parentMessageId ?? null,
      input.attachmentId ?? null,
      now,
      now,
    )
    .run();

  const shouldSend = input.sendToQueue !== false && hasMicrosoftKnowledgeQueue(env);
  if (shouldSend) {
    const message: MicrosoftFileJobMessage = {
      jobId,
      companyId: input.companyId,
      sourceId: input.sourceId,
      syncRunId: input.syncRunId,
    };
    await env.MICROSOFT_KNOWLEDGE_QUEUE!.send(message);
  }

  return { jobId, enqueued: shouldSend, duplicate: false };
}

export async function processMicrosoftFileJob(
  env: Env,
  message: MicrosoftFileJobMessage,
  options?: { deadLetter?: boolean },
): Promise<void> {
  const job = await loadJob(env.DB, message.jobId);
  if (!job) return;

  if (
    job.status === "indexed" ||
    job.status === "skipped_unchanged" ||
    job.status === "catalogue_only" ||
    job.status === "unsupported"
  ) {
    return;
  }

  if (options?.deadLetter) {
    await env.DB.prepare(
      `UPDATE microsoft_file_jobs SET status = 'dead_letter', updated_at = ?, completed_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), nowIso(), job.id)
      .run();
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  const source = await loadSourceContext(env.DB, job.company_id, job.source_id);
  if (!source) {
    await markJobFailed(env.DB, job.id, "Source not found");
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  const token = await acquireMicrosoftAppToken(env, {
    companyId: job.company_id,
    connectorInstanceId: job.connector_instance_id,
  });
  if (!token.ok) {
    await markJobRetrying(env.DB, job.id, token.message);
    throw new Error(token.message);
  }

  const config: MicrosoftGraphConfig = {
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  };

  const mcps = await listMcpEnvironments(env.DB, job.company_id);
  const mcp = mcps[0] ?? null;
  if (!mcp) {
    await markJobFailed(env.DB, job.id, "No Business MCP registered");
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  const itemKind = job.item_kind ?? "drive_file";
  if (itemKind === "mail_message" || itemKind === "mail_attachment") {
    await processMicrosoftMailJob(env, {
      job,
      source,
      config,
      mcp,
      itemKind,
      tenantId: token.tenantId,
    });
    return;
  }

  await env.DB.prepare(
    `UPDATE microsoft_file_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), job.id)
    .run();

  const classification = classifyMicrosoftFile(job.mime_type, job.file_name);
  const externalId = buildMicrosoftExternalId({
    sourceType: source.sourceType,
    driveId: job.drive_id,
    itemId: job.external_item_id,
  });

  const provenance = buildMicrosoftProvenance({
    companyId: job.company_id,
    tenantId: token.tenantId,
    sourceType: source.sourceType,
    externalItemId: job.external_item_id,
    path: job.relative_path,
    filename: job.file_name,
    modifiedAt: job.modified_at,
    driveId: job.drive_id,
    siteId: source.siteId,
    webUrl: job.web_url,
    inclusionStatus: "included",
  });

  const existingItem = await env.DB.prepare(
    `SELECT indexing_status, knowledge_document_id, e_tag, visibility_status
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
  )
    .bind(job.company_id, job.connector_instance_id, job.external_item_id)
    .first<{
      indexing_status: string;
      knowledge_document_id: number | null;
      e_tag: string | null;
      visibility_status: string | null;
    }>();

  if (
    existingItem?.indexing_status === "indexed" &&
    existingItem.knowledge_document_id &&
    existingItem.visibility_status === "active" &&
    existingItem.e_tag === (job.e_tag ?? null)
  ) {
    await completeJob(env.DB, job.id, "skipped_unchanged");
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  if (
    existingItem?.knowledge_document_id &&
    existingItem.visibility_status === "tombstoned" &&
    existingItem.indexing_status === "indexed"
  ) {
    await reactivateMicrosoftKnowledgeDocument(env, mcp, existingItem.knowledge_document_id);
    await env.DB.prepare(
      `UPDATE microsoft_knowledge_items SET visibility_status = 'active', updated_at = ? WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ?`,
    )
      .bind(nowIso(), job.company_id, job.connector_instance_id, job.external_item_id)
      .run();
    if (existingItem.e_tag === (job.e_tag ?? null)) {
      await completeJob(env.DB, job.id, "skipped_unchanged");
      await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
      return;
    }
  }

  if (classification.indexingStatus !== "indexable") {
    const jobStatus =
      classification.indexingStatus === "catalogue_only" ? "catalogue_only" : "unsupported";
    await upsertKnowledgeItem(env.DB, {
      companyId: job.company_id,
      connectorInstanceId: job.connector_instance_id,
      sourceId: job.source_id,
      sourceType: source.sourceType,
      externalItemId: job.external_item_id,
      externalId,
      title: job.file_name,
      path: job.relative_path,
      mimeType: job.mime_type,
      modifiedAt: job.modified_at,
      webUrl: job.web_url,
      sizeBytes: job.size_bytes,
      eTag: job.e_tag,
      provenance: {
        ...provenance,
        sourceLabel: formatMicrosoftSourceLabel({
          sourceType: source.sourceType,
          displayName: source.displayName,
          path: job.relative_path,
          filename: job.file_name,
        }),
      },
      indexingStatus: classification.indexingStatus === "catalogue_only" ? "unsupported" : "skipped",
      lastError: classification.reason,
    });
    await completeJob(env.DB, job.id, jobStatus);
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  try {
    const download = await downloadDriveItemContent(config, job.drive_id, job.external_item_id);
    const upload = await uploadMicrosoftDocumentToKnowledge(env, mcp, {
      filename: job.file_name,
      bytes: download.bytes,
      mimeType: download.mimeType,
      externalId,
      title: job.file_name,
      metadata: {
        ...provenance,
        sourceType: source.sourceType,
        companyId: job.company_id,
        topic: formatMicrosoftSourceLabel({
          sourceType: source.sourceType,
          displayName: source.displayName,
          path: job.relative_path,
          filename: job.file_name,
        }),
      },
      autoIndex: true,
    });

    if (!upload.ok) {
      await upsertKnowledgeItem(env.DB, {
        companyId: job.company_id,
        connectorInstanceId: job.connector_instance_id,
        sourceId: job.source_id,
        sourceType: source.sourceType,
        externalItemId: job.external_item_id,
        externalId,
        title: job.file_name,
        path: job.relative_path,
        mimeType: download.mimeType,
        modifiedAt: job.modified_at,
        webUrl: job.web_url,
        sizeBytes: download.contentLength,
        eTag: job.e_tag,
        provenance,
        indexingStatus: "failed",
        lastError: upload.message,
      });
      await markJobRetrying(env.DB, job.id, upload.message);
      throw new Error(upload.message);
    }

    await upsertKnowledgeItem(env.DB, {
      companyId: job.company_id,
      connectorInstanceId: job.connector_instance_id,
      sourceId: job.source_id,
      sourceType: source.sourceType,
      externalItemId: job.external_item_id,
      externalId,
      title: job.file_name,
      path: job.relative_path,
      mimeType: download.mimeType,
      modifiedAt: job.modified_at,
      webUrl: job.web_url,
      sizeBytes: download.contentLength,
      eTag: job.e_tag,
      provenance,
      indexingStatus: mapKnowledgeIndexOutcomeToMicrosoftStatus({
        indexOk: true,
        requiresOcr: upload.requiresOcr,
        partial: upload.partial,
        documentStatus: upload.documentStatus,
      }),
      knowledgeDocumentId: upload.documentId,
      lastError: upload.requiresOcr
        ? `PDF extraction insufficient (${upload.extractionQuality ?? "requires_ocr"}); OCR fallback not available in production`
        : null,
    });
    await env.DB.prepare(
      `UPDATE microsoft_knowledge_items SET visibility_status = 'active', updated_at = ? WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ?`,
    )
      .bind(nowIso(), job.company_id, job.connector_instance_id, job.external_item_id)
      .run();

    const jobStatus =
      upload.requiresOcr
        ? "failed"
        : "indexed";
    await completeJob(env.DB, job.id, jobStatus);
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    const current = await loadJob(env.DB, job.id);
    if ((current?.attempts ?? 0) >= MICROSOFT_QUEUE_MAX_RETRIES) {
      await markJobFailed(env.DB, job.id, message);
      await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
      return;
    }
    await upsertKnowledgeItem(env.DB, {
      companyId: job.company_id,
      connectorInstanceId: job.connector_instance_id,
      sourceId: job.source_id,
      sourceType: source.sourceType,
      externalItemId: job.external_item_id,
      externalId,
      title: job.file_name,
      path: job.relative_path,
      mimeType: job.mime_type,
      modifiedAt: job.modified_at,
      webUrl: job.web_url,
      sizeBytes: job.size_bytes,
      eTag: job.e_tag,
      provenance,
      indexingStatus: "failed",
      lastError: message,
    });
    await markJobRetrying(env.DB, job.id, message);
    throw err;
  }
}

async function processMicrosoftMailJob(
  env: Env,
  input: {
    job: MicrosoftFileJobRow;
    source: NonNullable<Awaited<ReturnType<typeof loadSourceContext>>>;
    config: MicrosoftGraphConfig;
    mcp: Awaited<ReturnType<typeof listMcpEnvironments>>[number];
    itemKind: "mail_message" | "mail_attachment";
    tenantId: string;
  },
): Promise<void> {
  const { job, source, config, mcp, itemKind, tenantId } = input;
  const mailboxAddress = job.drive_id;

  await env.DB.prepare(
    `UPDATE microsoft_file_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), job.id)
    .run();

  const messageId =
    itemKind === "mail_attachment"
      ? job.parent_message_id ?? job.external_item_id.split("|")[0]
      : job.external_item_id;
  const attachmentId =
    itemKind === "mail_attachment"
      ? job.attachment_id ?? job.external_item_id.split("|")[1] ?? null
      : null;

  const externalId = buildMicrosoftMailExternalId({
    mailboxAddress,
    messageId: messageId ?? job.external_item_id,
    attachmentId,
  });

  const existingItem = await env.DB.prepare(
    `SELECT indexing_status, knowledge_document_id, e_tag, visibility_status
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
  )
    .bind(job.company_id, job.connector_instance_id, job.external_item_id)
    .first<{
      indexing_status: string;
      knowledge_document_id: number | null;
      e_tag: string | null;
      visibility_status: string | null;
    }>();

  if (
    existingItem?.indexing_status === "indexed" &&
    existingItem.knowledge_document_id &&
    existingItem.visibility_status === "active" &&
    existingItem.e_tag === (job.e_tag ?? null)
  ) {
    await completeJob(env.DB, job.id, "skipped_unchanged");
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
    return;
  }

  try {
    const message = await getMailboxMessage(config, mailboxAddress, messageId!);
    const from = message.from?.emailAddress?.address ?? message.sender?.emailAddress?.address ?? null;
    const to = (message.toRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter(Boolean) as string[];

    let bytes: ArrayBuffer;
    let mimeType: string | null;
    let title: string;
    let filename: string;

    const parentKnowledgeDocumentId =
      itemKind === "mail_attachment"
        ? await lookupParentKnowledgeDocumentId(env.DB, {
            companyId: job.company_id,
            connectorInstanceId: job.connector_instance_id,
            messageId: messageId!,
          })
        : null;

    let attachmentMetadataList: Awaited<ReturnType<typeof buildOutlookAttachmentMetadata>> = [];
    if (itemKind === "mail_message" && message.hasAttachments) {
      const attachments = await listMessageAttachments(config, mailboxAddress, message.id);
      attachmentMetadataList = await buildOutlookAttachmentMetadata(env.DB, {
        companyId: job.company_id,
        connectorInstanceId: job.connector_instance_id,
        messageId: message.id,
        attachments: attachments.map((a) => ({
          id: a.id,
          name: a.name,
          contentType: a.contentType,
        })),
      });
    }

    if (itemKind === "mail_attachment") {
      if (!attachmentId) throw new Error("Attachment ID missing on mail attachment job");
      const attachment = await getMessageAttachmentContent(
        config,
        mailboxAddress,
        messageId!,
        attachmentId,
      );
      if (!attachment.contentBytes) throw new Error("Attachment content unavailable");
      const binary = Uint8Array.from(atob(attachment.contentBytes), (c) => c.charCodeAt(0));
      bytes = binary.buffer;
      mimeType = attachment.contentType;
      title = attachment.name;
      filename = attachment.name;
    } else {
      const text = buildMailKnowledgeText(message, {
        hasAttachments: message.hasAttachments,
        attachments: attachmentMetadataList,
      });
      bytes = new TextEncoder().encode(text).buffer;
      mimeType = "text/plain";
      title = message.subject ?? job.file_name;
      filename = job.file_name;
    }

    const provenance = buildOutlookKnowledgeProvenance({
      companyId: job.company_id,
      tenantId,
      mailboxAddress,
      folderName: job.relative_path?.split("/")[0] ?? "Inbox",
      messageId: message.id,
      internetMessageId: message.internetMessageId,
      subject: message.subject,
      from,
      to,
      receivedDateTime: message.receivedDateTime,
      sentDateTime: message.sentDateTime,
      attachmentId,
      attachmentName: itemKind === "mail_attachment" ? filename : null,
      itemKind,
      parentMessageId: itemKind === "mail_attachment" ? messageId : null,
      parentKnowledgeDocumentId,
      hasAttachments: message.hasAttachments,
      attachments: attachmentMetadataList,
    });

    const upload = await uploadMicrosoftDocumentToKnowledge(env, mcp, {
      filename,
      bytes,
      mimeType,
      externalId,
      title,
      metadata: {
        ...provenance,
        sourceType: "outlook_shared",
        companyId: job.company_id,
        topic: String(provenance.sourceLabel),
      },
      autoIndex: true,
    });

    if (!upload.ok) {
      await upsertKnowledgeItem(env.DB, {
        companyId: job.company_id,
        connectorInstanceId: job.connector_instance_id,
        sourceId: job.source_id,
        sourceType: source.sourceType,
        externalItemId: job.external_item_id,
        externalId,
        title,
        path: job.relative_path,
        mimeType,
        modifiedAt: job.modified_at,
        webUrl: job.web_url,
        sizeBytes: bytes.byteLength,
        eTag: job.e_tag,
        provenance,
        indexingStatus: "failed",
        lastError: upload.message,
      });
      await markJobRetrying(env.DB, job.id, upload.message);
      throw new Error(upload.message);
    }

    await upsertKnowledgeItem(env.DB, {
      companyId: job.company_id,
      connectorInstanceId: job.connector_instance_id,
      sourceId: job.source_id,
      sourceType: source.sourceType,
      externalItemId: job.external_item_id,
      externalId,
      title,
      path: job.relative_path,
      mimeType,
      modifiedAt: job.modified_at,
      webUrl: job.web_url,
      sizeBytes: bytes.byteLength,
      eTag: job.e_tag,
      provenance,
      indexingStatus: mapKnowledgeIndexOutcomeToMicrosoftStatus({
        indexOk: true,
        requiresOcr: upload.requiresOcr,
        partial: upload.partial,
        documentStatus: upload.documentStatus,
      }),
      knowledgeDocumentId: upload.documentId,
      lastError: upload.requiresOcr
        ? `PDF extraction insufficient (${upload.extractionQuality ?? "requires_ocr"}); OCR fallback not available in production`
        : null,
    });
    await env.DB.prepare(
      `UPDATE microsoft_knowledge_items SET visibility_status = 'active', updated_at = ? WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ?`,
    )
      .bind(nowIso(), job.company_id, job.connector_instance_id, job.external_item_id)
      .run();

    const jobStatus =
      upload.requiresOcr || upload.partial
        ? upload.requiresOcr
          ? "failed"
          : "indexed"
        : "indexed";
    await completeJob(env.DB, job.id, jobStatus);
    await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Mail job failed";
    const current = await loadJob(env.DB, job.id);
    if ((current?.attempts ?? 0) >= MICROSOFT_QUEUE_MAX_RETRIES) {
      await markJobFailed(env.DB, job.id, message);
      await finalizeMicrosoftSyncRunIfComplete(env, job.sync_run_id, job.source_id);
      return;
    }
    await markJobRetrying(env.DB, job.id, message);
    throw err;
  }
}

async function completeJob(
  db: D1Database,
  jobId: string,
  status: MicrosoftFileJobStatus,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE microsoft_file_jobs SET status = ?, updated_at = ?, completed_at = ?, last_error = NULL WHERE id = ?`,
    )
    .bind(status, now, now, jobId)
    .run();
}

async function markJobFailed(db: D1Database, jobId: string, error: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE microsoft_file_jobs SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    )
    .bind(error, now, now, jobId)
    .run();
}

async function markJobRetrying(db: D1Database, jobId: string, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE microsoft_file_jobs SET status = 'retrying', last_error = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(error, nowIso(), jobId)
    .run();
}

export async function finalizeMicrosoftSyncRunIfComplete(
  env: Env,
  syncRunId: string,
  sourceId: string,
): Promise<boolean> {
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM microsoft_file_jobs
     WHERE sync_run_id = ? AND status IN ('queued', 'processing', 'retrying')`,
  )
    .bind(syncRunId)
    .first<{ count: number }>();

  if ((pending?.count ?? 0) > 0) return false;

  const stats = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM microsoft_file_jobs WHERE sync_run_id = ? GROUP BY status`,
  )
    .bind(syncRunId)
    .all<{ status: string; count: number }>();

  const byStatus: Record<string, number> = {};
  for (const row of stats.results ?? []) {
    byStatus[row.status] = Number(row.count);
  }

  const indexed = (byStatus.indexed ?? 0) + (byStatus.skipped_unchanged ?? 0);
  const failed = (byStatus.failed ?? 0) + (byStatus.dead_letter ?? 0);
  const discovered = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

  const syncStatus = failed > 0 ? "needs_attention" : "healthy";
  await env.DB.prepare(
    `UPDATE microsoft_connector_sources SET sync_status = ?, last_sync_at = ?,
     items_discovered = ?, items_indexed = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      syncStatus,
      nowIso(),
      discovered,
      indexed,
      failed > 0 ? `${failed} file(s) failed ingestion` : null,
      nowIso(),
      sourceId,
    )
    .run();

  const runStatus = failed > 0 ? "partial" : "completed";
  const existingRun = await env.DB.prepare(
    `SELECT metadata_json FROM microsoft_sync_runs WHERE id = ? LIMIT 1`,
  )
    .bind(syncRunId)
    .first<{ metadata_json: string | null }>();
  let metadata: Record<string, unknown> = {};
  try {
    metadata = existingRun?.metadata_json ? JSON.parse(existingRun.metadata_json) : {};
  } catch {
    metadata = {};
  }
  metadata.queueStats = byStatus;

  await env.DB.prepare(
    `UPDATE microsoft_sync_runs SET
      status = ?, items_discovered = ?, items_indexed = ?, items_failed = ?,
      completed_at = ?, metadata_json = ?
     WHERE id = ?`,
  )
    .bind(runStatus, discovered, indexed, failed, nowIso(), JSON.stringify(metadata), syncRunId)
    .run();

  const source = await env.DB.prepare(
    `SELECT company_id, connector_instance_id, display_name FROM microsoft_connector_sources WHERE id = ? LIMIT 1`,
  )
    .bind(sourceId)
    .first<{ company_id: string; connector_instance_id: string; display_name: string }>();

  if (source) {
    await recordAuditEvent(env.DB, {
      companyId: source.company_id,
      eventType: "connector.sync_completed",
      actor: "system:microsoft-queue",
      resourceType: "connector",
      resourceId: sourceId,
      detail: {
        stage: "microsoft.sync.queue_completed",
        syncRunId,
        sourceName: source.display_name,
        queueStats: byStatus,
        indexed,
        failed,
      },
    });
  }

  return true;
}

/** Process queued jobs synchronously when no Cloudflare Queue binding (tests/local). */
export async function drainMicrosoftFileJobsForSyncRun(
  env: Env,
  syncRunId: string,
): Promise<{ processed: number; failed: number }> {
  const jobs = await env.DB.prepare(
    `SELECT id, company_id, source_id FROM microsoft_file_jobs
     WHERE sync_run_id = ? AND status = 'queued' ORDER BY created_at ASC`,
  )
    .bind(syncRunId)
    .all<{ id: string; company_id: string; source_id: string }>();

  let processed = 0;
  let failed = 0;
  for (const job of jobs.results ?? []) {
    try {
      await processMicrosoftFileJob(env, {
        jobId: job.id,
        companyId: job.company_id,
        sourceId: job.source_id,
        syncRunId,
      });
      processed++;
    } catch {
      failed++;
    }
  }
  return { processed, failed };
}

export async function waitForMicrosoftSyncRun(
  env: Env,
  input: {
    syncRunId: string;
    sourceId: string;
    companyId: string;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<{ completed: boolean; stats: Awaited<ReturnType<typeof getMicrosoftSourceJobStats>> }> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollMs = input.pollMs ?? 2_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const stats = await getMicrosoftSourceJobStats(env.DB, {
      companyId: input.companyId,
      sourceId: input.sourceId,
      syncRunId: input.syncRunId,
    });
    if (stats.pending === 0) {
      await finalizeMicrosoftSyncRunIfComplete(env, input.syncRunId, input.sourceId);
      return { completed: true, stats };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const stats = await getMicrosoftSourceJobStats(env.DB, {
    companyId: input.companyId,
    sourceId: input.sourceId,
    syncRunId: input.syncRunId,
  });
  return { completed: false, stats };
}
