/**
 * Push Microsoft documents into the company Business MCP knowledge corpus.
 * Reuses Caddington /admin/knowledge/upload + /admin/knowledge/{id}/index.
 */

import type { Env } from "../env";
import type { McpEnvironment } from "@infra/shared";
import { resolveMcpFetcher } from "./mcp-client";
import { resolveMcpAdminAuthHeader } from "./mcp-admin-bridge";

export type KnowledgeUploadResult =
  | {
      ok: true;
      documentId: number;
      externalId: string;
      indexed: boolean;
      partial?: boolean;
      requiresOcr?: boolean;
      extractionQuality?: string;
      documentStatus?: string;
    }
  | { ok: false; code: string; message: string };

export type OutlookAttachmentMeta = {
  filename: string;
  contentType: string | null;
  attachmentId: string;
  knowledgeDocumentId: number | null;
  indexingStatus: string;
  extractionStatus?: string;
};

function adminAuthHeader(env: Env, mcp: McpEnvironment): string | null {
  return resolveMcpAdminAuthHeader(env, mcp).authorizationHeader;
}

async function adminFetch(
  env: Env,
  mcp: McpEnvironment,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const auth = adminAuthHeader(env, mcp);
  if (!auth) {
    throw new Error("MCP admin bridge token is not configured on infra-api");
  }

  const binding = resolveMcpFetcher(env, mcp.serviceBindingRef ?? "CADDINGTON_MCP");
  const url = `https://company-mcp.internal${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", auth);

  if (binding) {
    return binding.fetch(new Request(url, { ...init, headers }));
  }

  const base = mcp.endpointUrl.replace(/\/mcp\/?$/, "");
  return fetch(`${base}${path}`, { ...init, headers });
}

const INDEX_CONTINUATION_MAX_ROUNDS = 64;

type IndexResponseBody = {
  ok?: boolean;
  error?: string;
  partial?: boolean;
  continueAt?: number;
  totalChunks?: number;
  chunksIndexed?: number;
  requiresOcr?: boolean;
  extractionQuality?: string;
  documentStatus?: string;
};

export async function indexKnowledgeDocumentUntilComplete(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<
  | {
      ok: true;
      partial: boolean;
      requiresOcr: boolean;
      extractionQuality?: string;
      documentStatus?: string;
      chunksIndexed?: number;
    }
  | { ok: false; code: string; message: string }
> {
  let lastBody: IndexResponseBody = {};
  for (let round = 0; round < INDEX_CONTINUATION_MAX_ROUNDS; round++) {
    const indexResponse = await adminFetch(
      env,
      mcp,
      `/admin/knowledge/${documentId}/index`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    lastBody = (await indexResponse.json().catch(() => ({}))) as IndexResponseBody;

    if (!indexResponse.ok || lastBody.ok === false) {
      return {
        ok: false,
        code: lastBody.requiresOcr ? "KNOWLEDGE_REQUIRES_OCR" : "KNOWLEDGE_INDEX_FAILED",
        message: lastBody.error ?? `Index HTTP ${indexResponse.status}`,
      };
    }

    if (lastBody.requiresOcr) {
      return {
        ok: true,
        partial: true,
        requiresOcr: true,
        extractionQuality: lastBody.extractionQuality,
        documentStatus: lastBody.documentStatus ?? "requires_ocr",
        chunksIndexed: lastBody.chunksIndexed ?? 0,
      };
    }

    if (!lastBody.partial) {
      return {
        ok: true,
        partial: false,
        requiresOcr: false,
        extractionQuality: lastBody.extractionQuality,
        documentStatus: lastBody.documentStatus ?? "indexed",
        chunksIndexed: lastBody.chunksIndexed,
      };
    }
  }

  return {
    ok: false,
    code: "KNOWLEDGE_INDEX_PARTIAL_TIMEOUT",
    message: `Indexing did not complete after ${INDEX_CONTINUATION_MAX_ROUNDS} batches (last continueAt=${lastBody.continueAt ?? "unknown"})`,
  };
}

export function mapKnowledgeIndexOutcomeToMicrosoftStatus(input: {
  indexOk: boolean;
  requiresOcr?: boolean;
  partial?: boolean;
  documentStatus?: string;
}): string {
  if (!input.indexOk) return "failed";
  if (input.requiresOcr || input.documentStatus === "requires_ocr") return "partial";
  if (input.partial || input.documentStatus === "pending") return "indexing";
  return "indexed";
}

export async function uploadMicrosoftDocumentToKnowledge(
  env: Env,
  mcp: McpEnvironment,
  input: {
    filename: string;
    bytes: ArrayBuffer;
    mimeType: string | null;
    externalId: string;
    title: string;
    metadata: Record<string, unknown>;
    autoIndex?: boolean;
  },
): Promise<KnowledgeUploadResult> {
  try {
    const form = new FormData();
    form.append("file", new Blob([input.bytes], { type: input.mimeType ?? "application/octet-stream" }), input.filename);
    form.append("title", input.title);
    form.append("external_id", input.externalId);
    form.append("source", "microsoft_365");
    form.append("category", String(input.metadata.sourceType ?? "document"));
    if (input.metadata.topic) form.append("topic", String(input.metadata.topic));
    if (input.metadata.companyId) form.append("company", String(input.metadata.companyId));
    form.append("metadata_json", JSON.stringify(input.metadata));

    const uploadResponse = await adminFetch(env, mcp, "/admin/knowledge/upload", {
      method: "POST",
      body: form,
    });

    const uploadBody = (await uploadResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      documentId?: number;
      externalId?: string;
      error?: string;
      action?: string;
    };

    if (!uploadResponse.ok || !uploadBody.documentId) {
      return {
        ok: false,
        code: "KNOWLEDGE_UPLOAD_FAILED",
        message: uploadBody.error ?? `Upload HTTP ${uploadResponse.status}`,
      };
    }

    let indexed = false;
    let partial = false;
    let requiresOcr = false;
    let extractionQuality: string | undefined;
    let documentStatus: string | undefined;

    if (input.autoIndex !== false) {
      const indexResult = await indexKnowledgeDocumentUntilComplete(
        env,
        mcp,
        uploadBody.documentId,
      );
      if (!indexResult.ok) {
        return {
          ok: false,
          code: indexResult.code,
          message: indexResult.message,
        };
      }
      indexed = !indexResult.requiresOcr && !indexResult.partial;
      partial = indexResult.partial;
      requiresOcr = indexResult.requiresOcr;
      extractionQuality = indexResult.extractionQuality;
      documentStatus = indexResult.documentStatus;
    }

    return {
      ok: true,
      documentId: uploadBody.documentId,
      externalId: uploadBody.externalId ?? input.externalId,
      indexed,
      partial,
      requiresOcr,
      extractionQuality,
      documentStatus,
    };
  } catch (err) {
    return {
      ok: false,
      code: "KNOWLEDGE_BRIDGE_ERROR",
      message: err instanceof Error ? err.message : "Knowledge bridge failed",
    };
  }
}

export async function reindexMicrosoftKnowledgeDocument(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<KnowledgeUploadResult> {
  const indexResult = await indexKnowledgeDocumentUntilComplete(env, mcp, documentId);
  if (!indexResult.ok) {
    return { ok: false, code: indexResult.code, message: indexResult.message };
  }
  return {
    ok: true,
    documentId,
    externalId: "",
    indexed: !indexResult.requiresOcr && !indexResult.partial,
    partial: indexResult.partial,
    requiresOcr: indexResult.requiresOcr,
    extractionQuality: indexResult.extractionQuality,
    documentStatus: indexResult.documentStatus,
  };
}

function fnv1aHex(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable external id for Vectorize upsert — must stay within 64 bytes. */
export function buildMicrosoftExternalId(input: {
  sourceType: string;
  driveId: string;
  itemId: string;
}): string {
  const raw = `${input.sourceType}|${input.driveId}|${input.itemId}`;
  const prefix = input.sourceType === "sharepoint" ? "mssp" : "msod";
  return `${prefix}-${fnv1aHex(raw)}${fnv1aHex(`${raw}|salt`)}`;
}

/** Stable external id for Outlook mail messages and attachments. */
export function buildMicrosoftMailExternalId(input: {
  mailboxAddress: string;
  messageId: string;
  attachmentId?: string | null;
}): string {
  const raw = input.attachmentId
    ? `outlook_shared|${input.mailboxAddress}|${input.messageId}|${input.attachmentId}`
    : `outlook_shared|${input.mailboxAddress}|${input.messageId}`;
  const prefix = input.attachmentId ? "msat" : "msml";
  return `${prefix}-${fnv1aHex(raw)}${fnv1aHex(`${raw}|salt`)}`;
}

export function buildOutlookKnowledgeProvenance(input: {
  companyId: string;
  tenantId: string | null;
  mailboxAddress: string;
  folderId?: string | null;
  folderName?: string | null;
  messageId: string;
  internetMessageId?: string | null;
  subject?: string | null;
  sender?: string | null;
  from?: string | null;
  recipients?: string[];
  to?: string[];
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  bodyPreview?: string | null;
  attachmentId?: string | null;
  attachmentName?: string | null;
  attachmentFilename?: string | null;
  contentType?: string | null;
  itemKind?: "mail_message" | "mail_attachment";
  parentMessageId?: string | null;
  parentInternetMessageId?: string | null;
  parentSubject?: string | null;
  parentKnowledgeDocumentId?: number | null;
  hasAttachments?: boolean;
  attachments?: OutlookAttachmentMeta[];
  extractionStatus?: string | null;
  indexingStatus?: string | null;
}): Record<string, unknown> {
  const sender = input.sender ?? input.from ?? null;
  const recipients = input.recipients ?? input.to ?? [];
  const attachmentFilename = input.attachmentFilename ?? input.attachmentName ?? null;
  return {
    connector: "microsoft_365",
    sourceType: "outlook_shared",
    companyId: input.companyId,
    tenantId: input.tenantId,
    mailboxAddress: input.mailboxAddress,
    folderId: input.folderId ?? null,
    folderName: input.folderName ?? "Inbox",
    messageId: input.messageId,
    internetMessageId: input.internetMessageId ?? null,
    subject: input.subject ?? null,
    sender,
    from: sender,
    recipients,
    to: recipients,
    receivedDateTime: input.receivedDateTime ?? null,
    sentDateTime: input.sentDateTime ?? null,
    bodyPreview: input.bodyPreview ?? null,
    attachmentId: input.attachmentId ?? null,
    attachmentFilename,
    contentType: input.contentType ?? null,
    itemKind: input.itemKind ?? (input.attachmentId ? "mail_attachment" : "mail_message"),
    parentMessageId: input.parentMessageId ?? null,
    parentInternetMessageId: input.parentInternetMessageId ?? null,
    parentSubject: input.parentSubject ?? null,
    parentKnowledgeDocumentId: input.parentKnowledgeDocumentId ?? null,
    hasAttachments: input.hasAttachments ?? false,
    attachments: input.attachments ?? [],
    extractionStatus: input.extractionStatus ?? null,
    indexingStatus: input.indexingStatus ?? null,
    sourceLabel: [
      "Microsoft 365",
      "Outlook",
      input.mailboxAddress,
      input.folderName ?? "Inbox",
      attachmentFilename ?? input.subject ?? input.messageId,
    ].join(" → "),
  };
}

export async function deactivateMicrosoftKnowledgeDocument(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.error ?? `Deactivate HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Deactivate failed" };
  }
}

export async function reactivateMicrosoftKnowledgeDocument(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.error ?? `Reactivate HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Reactivate failed" };
  }
}

export async function lookupParentKnowledgeDocumentId(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    messageId: string;
  },
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT knowledge_document_id FROM microsoft_knowledge_items
       WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.messageId)
    .first<{ knowledge_document_id: number | null }>();
  return row?.knowledge_document_id ?? null;
}

export async function buildOutlookAttachmentMetadata(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    messageId: string;
    attachments: Array<{
      id: string;
      name: string;
      contentType: string | null;
    }>;
  },
): Promise<OutlookAttachmentMeta[]> {
  const results: OutlookAttachmentMeta[] = [];
  for (const attachment of input.attachments) {
    const externalItemId = `${input.messageId}|${attachment.id}`;
    const row = await db
      .prepare(
        `SELECT knowledge_document_id, indexing_status FROM microsoft_knowledge_items
         WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
      )
      .bind(input.companyId, input.connectorInstanceId, externalItemId)
      .first<{ knowledge_document_id: number | null; indexing_status: string | null }>();
    results.push({
      filename: attachment.name,
      contentType: attachment.contentType,
      attachmentId: attachment.id,
      knowledgeDocumentId: row?.knowledge_document_id ?? null,
      indexingStatus: row?.indexing_status ?? "discovered",
      extractionStatus:
        row?.indexing_status === "partial" ? "requires_ocr" : row?.indexing_status ?? "discovered",
    });
  }
  return results;
}

export async function patchKnowledgeDocumentMetadata(
  env: Env,
  mcp: McpEnvironment,
  documentId: number,
  metadataPatch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await adminFetch(env, mcp, `/admin/knowledge/${documentId}/metadata`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: metadataPatch }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.error ?? `Metadata patch HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Metadata patch failed" };
  }
}

/** Refresh parent message attachment array after an attachment finishes indexing. */
export async function refreshParentMessageAttachmentMetadata(
  env: Env,
  mcp: McpEnvironment,
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    mailboxAddress: string;
    messageId: string;
    tenantId: string | null;
  },
): Promise<{ ok: boolean; parentDocumentId: number | null }> {
  const parentRow = await db
    .prepare(
      `SELECT knowledge_document_id, provenance_json FROM microsoft_knowledge_items
       WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.messageId)
    .first<{ knowledge_document_id: number | null; provenance_json: string | null }>();

  const parentDocumentId = parentRow?.knowledge_document_id ?? null;
  if (!parentDocumentId) return { ok: false, parentDocumentId: null };

  let existingProvenance: Record<string, unknown> = {};
  try {
    existingProvenance = parentRow?.provenance_json ? JSON.parse(parentRow.provenance_json) : {};
  } catch {
    existingProvenance = {};
  }

  const attachmentRows = await db
    .prepare(
      `SELECT external_item_id, file_name, mime_type, knowledge_document_id, indexing_status
       FROM microsoft_knowledge_items
       WHERE company_id = ? AND connector_instance_id = ?
         AND external_item_id LIKE ? || '|%'
       ORDER BY file_name ASC`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.messageId)
    .all<{
      external_item_id: string;
      file_name: string;
      mime_type: string | null;
      knowledge_document_id: number | null;
      indexing_status: string | null;
    }>();

  const attachments: OutlookAttachmentMeta[] = (attachmentRows.results ?? []).map((row) => {
    const attachmentId = row.external_item_id.split("|")[1] ?? row.external_item_id;
    const indexingStatus = row.indexing_status ?? "discovered";
    return {
      filename: row.file_name,
      contentType: row.mime_type,
      attachmentId,
      knowledgeDocumentId: row.knowledge_document_id,
      indexingStatus,
      extractionStatus: indexingStatus === "partial" ? "requires_ocr" : indexingStatus,
    };
  });

  const metadataPatch = {
    ...existingProvenance,
    hasAttachments: attachments.length > 0,
    attachments,
    mailboxAddress: input.mailboxAddress,
    messageId: input.messageId,
    tenantId: input.tenantId,
    companyId: input.companyId,
    itemKind: "mail_message",
  };

  const patched = await patchKnowledgeDocumentMetadata(env, mcp, parentDocumentId, metadataPatch);
  if (patched.ok) {
    await db
      .prepare(
        `UPDATE microsoft_knowledge_items SET provenance_json = ?, updated_at = ?
         WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ?`,
      )
      .bind(JSON.stringify(metadataPatch), new Date().toISOString(), input.companyId, input.connectorInstanceId, input.messageId)
      .run();
  }
  return { ok: patched.ok, parentDocumentId };
}
