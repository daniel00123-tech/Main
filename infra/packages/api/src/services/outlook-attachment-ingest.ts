/**
 * Platform Outlook attachment ingestion.
 * Discover approved mailboxes → fetch bytes → shared knowledge pipeline → ledger.
 * Attachments only. Does not auto-vectorise email bodies.
 */

import {
  classifyOutlookAttachmentForKnowledge,
  timestampInWindow,
} from "@infra/shared";
import type { Env } from "../env";
import { listMcpEnvironments } from "./control-plane";
import { nowIso } from "../db/mappers";
import { recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";
import {
  discoverCompanyUserMailboxes,
  listApprovedAttachmentMailboxes,
  listCompanyMailboxRegistry,
  markMailboxScanResult,
  seedPolicyMailboxes,
  type MailboxRegistryRow,
} from "./mailbox-registry";
import {
  buildMicrosoftMailExternalId,
  buildOutlookKnowledgeProvenance,
  uploadMicrosoftDocumentToKnowledge,
} from "./microsoft-knowledge-bridge";
import { executeOutlookReadTool } from "./microsoft-outlook-read";
import {
  getMessageAttachmentContent,
  listMailboxMessages,
  listMessageAttachments,
  type GraphMailAttachment,
  type GraphMailMessageDetail,
} from "./microsoft-outlook-graph";
import { MicrosoftGraphError } from "./microsoft-graph";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";

const MAX_MESSAGES_PER_MAILBOX = 80;
const MAX_RETRIES = 4;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type AttachmentIngestCounts = {
  mailboxesScanned: number;
  messagesWithAttachments: number;
  attachmentsDiscovered: number;
  attachmentsFetched: number;
  attachmentsExtracted: number;
  attachmentsIndexed: number;
  chunksAdded: number;
  skipped: number;
  failed: number;
  recovered: number;
  duplicates: number;
};

export type NamedPersonMailboxReport = {
  name: string;
  mailboxAddress: string | null;
  mailboxFound: boolean;
  approvedForAttachmentIngestion: boolean;
  graphAccessible: boolean | null;
  mailSearchEnabled: boolean;
  messagesWithAttachmentsInWindow: number;
  attachmentsFound: number;
  indexed: number;
  policy: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err: unknown): boolean {
  if (err instanceof MicrosoftGraphError) return TRANSIENT_STATUSES.has(err.status);
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|429|5\d\d|temporarily|network/i.test(message);
}

async function withBoundedRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransientError(err) || attempt === MAX_RETRIES - 1) throw err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error("retry exhausted");
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function messageTime(row: { receivedDateTime?: string | null; sentDateTime?: string | null }): string | null {
  return row.receivedDateTime || row.sentDateTime || null;
}

function emptyCounts(): AttachmentIngestCounts {
  return {
    mailboxesScanned: 0,
    messagesWithAttachments: 0,
    attachmentsDiscovered: 0,
    attachmentsFetched: 0,
    attachmentsExtracted: 0,
    attachmentsIndexed: 0,
    chunksAdded: 0,
    skipped: 0,
    failed: 0,
    recovered: 0,
    duplicates: 0,
  };
}

async function findIndexedByHash(
  db: D1Database,
  companyId: string,
  contentHash: string,
): Promise<{ id: string; chunk_count: number | null } | null> {
  return db
    .prepare(
      `SELECT id, chunk_count FROM knowledge_ingestion_events
       WHERE company_id = ? AND content_hash = ? AND event_type IN ('indexed', 'reindexed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(companyId, contentHash)
    .first<{ id: string; chunk_count: number | null }>();
}

async function findIndexedByProvider(
  db: D1Database,
  companyId: string,
  providerItemId: string,
): Promise<{ id: string; event_type: string; chunk_count: number | null } | null> {
  return db
    .prepare(
      `SELECT id, event_type, chunk_count FROM knowledge_ingestion_events
       WHERE company_id = ? AND provider_item_id = ? AND event_type IN ('indexed', 'reindexed', 'duplicate')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(companyId, providerItemId)
    .first<{ id: string; event_type: string; chunk_count: number | null }>();
}

function decodeBase64Bytes(contentBytes: string): ArrayBuffer {
  const binary = Uint8Array.from(atob(contentBytes), (c) => c.charCodeAt(0));
  return binary.buffer;
}

async function discoverMessagesViaGraph(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    windowFrom: Date;
    windowTo: Date;
    actor: string;
  },
): Promise<
  | { ok: true; source: "graph"; messages: GraphMailMessageDetail[]; tenantId: string; accessToken: string }
  | { ok: false; code: string; message: string }
> {
  const access = await resolveOutlookGraphAccess(env, {
    companyId: input.companyId,
    mailboxAddress: input.mailboxAddress,
    actor: input.actor,
  });
  if (!access.ok) return access;
  const listed = await withBoundedRetry(() =>
    listMailboxMessages(
      { accessToken: access.accessToken, tenantId: access.tenantId },
      { mailboxAddress: input.mailboxAddress, top: MAX_MESSAGES_PER_MAILBOX },
    ),
  );
  const messages = listed.filter((row) => {
    if (!row.hasAttachments || row["@removed"]) return false;
    const when = messageTime(row);
    return when ? timestampInWindow(when, input.windowFrom, input.windowTo) : false;
  });
  return {
    ok: true,
    source: "graph",
    messages,
    tenantId: access.tenantId,
    accessToken: access.accessToken,
  };
}

async function discoverMessagesViaMcp(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    windowFrom: Date;
    windowTo: Date;
    actor: string;
  },
): Promise<{ ok: true; messages: GraphMailMessageDetail[] } | { ok: false; code: string; message: string }> {
  const listed = await executeOutlookReadTool(env, {
    companyId: input.companyId,
    toolName: "outlook_list_messages",
    arguments: { mailboxAddress: input.mailboxAddress, limit: MAX_MESSAGES_PER_MAILBOX },
    actor: input.actor,
  });
  if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
  const record = asRecord(listed.result);
  const rows = Array.isArray(record?.messages) ? record!.messages : [];
  const messages = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .filter((row) => Boolean(row.hasAttachments))
    .filter((row) => timestampInWindow(asText(row.receivedDateTime) || asText(row.sentDateTime), input.windowFrom, input.windowTo))
    .map((row) => ({
      id: asText(row.id),
      subject: asText(row.subject) || null,
      bodyPreview: asText(row.bodyPreview) || null,
      from: typeof row.from === "string" ? { emailAddress: { address: row.from } } : null,
      sender: null,
      toRecipients: [],
      ccRecipients: [],
      receivedDateTime: asText(row.receivedDateTime) || null,
      sentDateTime: asText(row.sentDateTime) || null,
      conversationId: asText(row.conversationId) || null,
      internetMessageId: asText(row.internetMessageId) || null,
      hasAttachments: true,
      webLink: asText(row.webLink) || null,
      parentFolderId: null,
    }));
  return { ok: true, messages };
}

async function listAttachmentsForMessage(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    messageId: string;
    actor: string;
    graph?: { accessToken: string; tenantId: string } | null;
  },
): Promise<{ attachments: Array<GraphMailAttachment & { contentId?: string | null }>; via: string }> {
  if (input.graph) {
    const attachments = await withBoundedRetry(() =>
      listMessageAttachments(input.graph!, input.mailboxAddress, input.messageId),
    );
    return { attachments, via: "graph" };
  }
  const listed = await executeOutlookReadTool(env, {
    companyId: input.companyId,
    toolName: "outlook_list_attachments",
    arguments: { mailboxAddress: input.mailboxAddress, messageId: input.messageId },
    actor: input.actor,
  });
  if (!listed.ok) return { attachments: [], via: listed.code };
  const record = asRecord(listed.result);
  const rows = Array.isArray(record?.attachments) ? record!.attachments : [];
  return {
    via: "outlook_read",
    attachments: rows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .map((row) => ({
        id: asText(row.id) || asText(row.attachmentId),
        name: asText(row.name) || asText(row.filename),
        contentType: asText(row.contentType) || asText(row.mimeType) || null,
        size: Number(row.size ?? row.sizeBytes ?? 0),
        isInline: Boolean(row.isInline),
        contentId: asText(row.contentId) || asText(row.contentID) || null,
      })),
  };
}

async function fetchAttachmentBytes(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    messageId: string;
    attachmentId: string;
    actor: string;
    graph?: { accessToken: string; tenantId: string } | null;
  },
): Promise<{ bytes: ArrayBuffer; name: string; contentType: string | null; size: number; via: string }> {
  if (input.graph) {
    const attachment = await withBoundedRetry(() =>
      getMessageAttachmentContent(input.graph!, input.mailboxAddress, input.messageId, input.attachmentId),
    );
    if (!attachment.contentBytes) throw new Error("Attachment content unavailable");
    return {
      bytes: decodeBase64Bytes(attachment.contentBytes),
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      via: "graph",
    };
  }
  const got = await executeOutlookReadTool(env, {
    companyId: input.companyId,
    toolName: "outlook_get_attachment",
    arguments: {
      mailboxAddress: input.mailboxAddress,
      messageId: input.messageId,
      attachmentId: input.attachmentId,
    },
    actor: input.actor,
  });
  if (!got.ok) throw new Error(got.message);
  const record = asRecord(got.result);
  const encoded = asText(record?.contentBytesBase64) || asText(record?.contentBytes);
  if (!encoded) throw new Error("Attachment content unavailable");
  return {
    bytes: decodeBase64Bytes(encoded),
    name: asText(record?.name) || "attachment",
    contentType: asText(record?.contentType) || null,
    size: Number(record?.size ?? 0),
    via: "outlook_read",
  };
}

async function ingestOneAttachment(
  env: Env,
  input: {
    companyId: string;
    mailbox: MailboxRegistryRow;
    message: GraphMailMessageDetail;
    attachment: GraphMailAttachment & { contentId?: string | null };
    actor: string;
    graph?: { accessToken: string; tenantId: string } | null;
    tenantId: string | null;
    recoverExisting: boolean;
  },
): Promise<{
  status: "indexed" | "skipped" | "failed" | "duplicate";
  chunks: number;
  recovered: boolean;
  skipReason: string | null;
  failureCode: string | null;
}> {
  const providerItemId = `${input.message.id}|${input.attachment.id}`;
  const filter = classifyOutlookAttachmentForKnowledge({
    filename: input.attachment.name,
    mimeType: input.attachment.contentType,
    sizeBytes: input.attachment.size,
    isInline: input.attachment.isInline,
    contentId: input.attachment.contentId,
  });
  const subject = input.message.subject ?? "";
  const sender =
    input.message.from?.emailAddress?.address ?? input.message.sender?.emailAddress?.address ?? null;

  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: "outlook_attachments",
    eventType: "discovered",
    providerItemId,
    parentMessageId: input.message.id,
    filename: input.attachment.name,
    mailboxAddress: input.mailbox.mailbox_address,
    mimeType: input.attachment.contentType,
    sizeBytes: input.attachment.size,
    sourceModifiedAt: messageTime(input.message),
    metadata: { subject, from: sender, attachmentId: input.attachment.id },
  });

  if (!filter.ingest) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "skipped",
      providerItemId,
      parentMessageId: input.message.id,
      filename: input.attachment.name,
      mailboxAddress: input.mailbox.mailbox_address,
      skipReason: filter.skipReason,
      failureCode: filter.failureCode,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, from: sender },
    });
    return {
      status: "skipped",
      chunks: 0,
      recovered: false,
      skipReason: filter.skipReason,
      failureCode: filter.failureCode,
    };
  }

  const already = await findIndexedByProvider(env.DB, input.companyId, providerItemId);
  if (already && !input.recoverExisting) {
    return {
      status: already.event_type === "duplicate" ? "duplicate" : "indexed",
      chunks: already.chunk_count ?? 0,
      recovered: false,
      skipReason: "already_indexed",
      failureCode: null,
    };
  }

  let fetched;
  try {
    fetched = await fetchAttachmentBytes(env, {
      companyId: input.companyId,
      mailboxAddress: input.mailbox.mailbox_address,
      messageId: input.message.id,
      attachmentId: input.attachment.id,
      actor: input.actor,
      graph: input.graph,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      parentMessageId: input.message.id,
      filename: input.attachment.name,
      mailboxAddress: input.mailbox.mailbox_address,
      skipReason: message,
      failureCode: isTransientError(err) ? "FETCH_TRANSIENT" : "FETCH_FAILED",
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, from: sender, stop: "FETCH" },
    });
    return { status: "failed", chunks: 0, recovered: false, skipReason: message, failureCode: "FETCH_FAILED" };
  }

  const contentHash = await sha256Hex(fetched.bytes);
  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: "outlook_attachments",
    eventType: "fetched",
    providerItemId,
    parentMessageId: input.message.id,
    filename: fetched.name,
    contentHash,
    mailboxAddress: input.mailbox.mailbox_address,
    mimeType: fetched.contentType,
    sizeBytes: fetched.bytes.byteLength,
    fetchedAt: nowIso(),
    sourceModifiedAt: messageTime(input.message),
    metadata: { subject, from: sender, via: fetched.via },
  });

  const hashed = await findIndexedByHash(env.DB, input.companyId, contentHash);
  if (hashed) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "duplicate",
      providerItemId,
      parentMessageId: input.message.id,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      chunkCount: hashed.chunk_count,
      skipReason: "duplicate_content_hash",
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, from: sender, originalEventId: hashed.id },
    });
    return {
      status: "duplicate",
      chunks: hashed.chunk_count ?? 0,
      recovered: false,
      skipReason: "duplicate_content_hash",
      failureCode: null,
    };
  }

  const mcp = (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled);
  if (!mcp) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      failureCode: "MCP_UNAVAILABLE",
      skipReason: "Business MCP unavailable",
      sourceModifiedAt: messageTime(input.message),
    });
    return { status: "failed", chunks: 0, recovered: false, skipReason: "Business MCP unavailable", failureCode: "MCP_UNAVAILABLE" };
  }

  const externalId = buildMicrosoftMailExternalId({
    mailboxAddress: input.mailbox.mailbox_address,
    messageId: input.message.id,
    attachmentId: input.attachment.id,
  });
  const provenance = buildOutlookKnowledgeProvenance({
    companyId: input.companyId,
    tenantId: input.tenantId,
    mailboxAddress: input.mailbox.mailbox_address,
    messageId: input.message.id,
    internetMessageId: input.message.internetMessageId,
    subject: input.message.subject,
    from: sender,
    receivedDateTime: input.message.receivedDateTime,
    attachmentId: input.attachment.id,
    attachmentFilename: fetched.name,
    contentType: fetched.contentType,
    itemKind: "mail_attachment",
    parentMessageId: input.message.id,
    parentSubject: input.message.subject,
    hasAttachments: true,
  });
  provenance.source_type = "outlook_attachment";
  provenance.content_hash = contentHash;
  provenance.chunk_count = null;

  let upload;
  try {
    upload = await withBoundedRetry(() =>
      uploadMicrosoftDocumentToKnowledge(env, mcp, {
        filename: fetched.name,
        bytes: fetched.bytes,
        mimeType: fetched.contentType,
        externalId,
        title: fetched.name || (subject ? `Attachment on: ${subject}` : "Email attachment"),
        metadata: {
          ...provenance,
          sourceType: "outlook_attachments",
          companyId: input.companyId,
          topic: String(provenance.sourceLabel),
        },
        autoIndex: true,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "index write failed";
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      failureCode: "INDEX_WRITE_FAILED",
      skipReason: message,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, stop: "INDEX" },
    });
    return { status: "failed", chunks: 0, recovered: false, skipReason: message, failureCode: "INDEX_WRITE_FAILED" };
  }

  if (!upload.ok) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      failureCode: upload.code,
      skipReason: upload.message,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, stop: "EXTRACT_OR_INDEX" },
    });
    return { status: "failed", chunks: 0, recovered: false, skipReason: upload.message, failureCode: upload.code };
  }

  const chunks = upload.indexed ? 1 : 0;
  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: "outlook_attachments",
    eventType: upload.indexed ? "indexed" : "extracted",
    providerItemId,
    parentMessageId: input.message.id,
    filename: fetched.name,
    contentHash,
    mailboxAddress: input.mailbox.mailbox_address,
    mimeType: fetched.contentType,
    sizeBytes: fetched.bytes.byteLength,
    chunkCount: chunks,
    extractedAt: nowIso(),
    indexedAt: upload.indexed ? nowIso() : null,
    sourceModifiedAt: messageTime(input.message),
    metadata: {
      subject,
      from: sender,
      knowledgeDocumentId: upload.documentId,
      externalId,
      extractionQuality: upload.extractionQuality ?? null,
      documentStatus: upload.documentStatus ?? null,
    },
  });

  return {
    status: upload.indexed ? "indexed" : "failed",
    chunks,
    recovered: input.recoverExisting,
    skipReason: upload.indexed ? null : upload.documentStatus ?? "not indexed",
    failureCode: upload.indexed ? null : "NOT_INDEXED",
  };
}

export async function ingestApprovedOutlookAttachments(
  env: Env,
  input: {
    companyId: string;
    windowFrom: Date;
    windowTo: Date;
    actor?: string;
    recoverExisting?: boolean;
  },
): Promise<{
  companyId: string;
  counts: AttachmentIngestCounts;
  mailboxes: Array<Record<string, unknown>>;
  namedPeople: NamedPersonMailboxReport[];
  registry: MailboxRegistryRow[];
}> {
  const actor = input.actor ?? "system:outlook-attachment-ingest";
  await seedPolicyMailboxes(env.DB, input.companyId);
  const discoveredUsers = await discoverCompanyUserMailboxes(env, input.companyId);
  const approved = await listApprovedAttachmentMailboxes(env.DB, input.companyId);
  const counts = emptyCounts();
  const mailboxReports: Array<Record<string, unknown>> = [];

  for (const mailbox of approved) {
    counts.mailboxesScanned += 1;
    const graphDiscover = await discoverMessagesViaGraph(env, {
      companyId: input.companyId,
      mailboxAddress: mailbox.mailbox_address,
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      actor,
    }).catch((err: unknown) => ({
      ok: false as const,
      code: "GRAPH_DISCOVER_FAILED",
      message: err instanceof Error ? err.message : "graph discover failed",
    }));

    let messages: GraphMailMessageDetail[] = [];
    let graph: { accessToken: string; tenantId: string } | null = null;
    let discoverVia = "none";
    let discoverError: string | null = null;

    if (graphDiscover.ok) {
      messages = graphDiscover.messages;
      graph = { accessToken: graphDiscover.accessToken, tenantId: graphDiscover.tenantId };
      discoverVia = "graph";
    } else {
      const mcpDiscover = await discoverMessagesViaMcp(env, {
        companyId: input.companyId,
        mailboxAddress: mailbox.mailbox_address,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        actor,
      });
      if (mcpDiscover.ok) {
        messages = mcpDiscover.messages;
        discoverVia = "company_mcp";
        discoverError = graphDiscover.ok === false ? graphDiscover.message : null;
      } else {
        discoverError = `${graphDiscover.ok === false ? graphDiscover.message : ""}; ${mcpDiscover.message}`;
        await markMailboxScanResult(env.DB, {
          companyId: input.companyId,
          mailboxAddress: mailbox.mailbox_address,
          success: false,
          graphAccessible: false,
          error: discoverError,
        });
        mailboxReports.push({
          mailboxAddress: mailbox.mailbox_address,
          mailboxType: mailbox.mailbox_type,
          ok: false,
          error: discoverError,
        });
        continue;
      }
    }

    counts.messagesWithAttachments += messages.length;
    const attachmentSummaries: Array<Record<string, unknown>> = [];
    let latestCheckpoint = mailbox.last_checkpoint;

    for (const message of messages) {
      if (!message.id) continue;
      const listed = await listAttachmentsForMessage(env, {
        companyId: input.companyId,
        mailboxAddress: mailbox.mailbox_address,
        messageId: message.id,
        actor,
        graph,
      });
      if (listed.attachments.length === 0 && message.hasAttachments) {
        counts.attachmentsDiscovered += 1;
        counts.failed += 1;
        await recordKnowledgeIngestionEvent(env.DB, {
          companyId: input.companyId,
          sourceType: "outlook_attachments",
          eventType: "failed",
          providerItemId: message.id,
          parentMessageId: message.id,
          filename: message.subject ? `Attachment on: ${message.subject}` : "Email attachment (name unavailable)",
          mailboxAddress: mailbox.mailbox_address,
          failureCode: "ATTACHMENT_ENUM_FAILED",
          skipReason: `Could not list attachments (${listed.via})`,
          sourceModifiedAt: messageTime(message),
          metadata: { subject: message.subject, stop: "ENUMERATE" },
        });
        continue;
      }
      for (const attachment of listed.attachments) {
        if (!attachment.id) continue;
        counts.attachmentsDiscovered += 1;
        const result = await ingestOneAttachment(env, {
          companyId: input.companyId,
          mailbox,
          message,
          attachment,
          actor,
          graph,
          tenantId: graph?.tenantId ?? null,
          recoverExisting: input.recoverExisting === true,
        });
        if (result.status === "indexed") {
          counts.attachmentsFetched += 1;
          counts.attachmentsExtracted += 1;
          counts.attachmentsIndexed += 1;
          counts.chunksAdded += result.chunks;
          if (result.recovered) counts.recovered += 1;
        } else if (result.status === "duplicate") {
          counts.attachmentsFetched += 1;
          counts.duplicates += 1;
          counts.skipped += 1;
        } else if (result.status === "skipped") {
          counts.skipped += 1;
        } else {
          counts.failed += 1;
        }
        attachmentSummaries.push({
          messageId: message.id,
          attachmentId: attachment.id,
          filename: attachment.name,
          mimeType: attachment.contentType,
          size: attachment.size,
          inline: Boolean(attachment.isInline),
          subject: message.subject,
          sender: message.from?.emailAddress?.address ?? null,
          received: messageTime(message),
          status: result.status,
          skipReason: result.skipReason,
          failureCode: result.failureCode,
        });
      }
      const when = messageTime(message);
      if (when && (!latestCheckpoint || when > latestCheckpoint)) latestCheckpoint = when;
    }

    await markMailboxScanResult(env.DB, {
      companyId: input.companyId,
      mailboxAddress: mailbox.mailbox_address,
      checkpoint: latestCheckpoint,
      success: true,
      graphAccessible: Boolean(graph),
    });
    mailboxReports.push({
      mailboxAddress: mailbox.mailbox_address,
      mailboxType: mailbox.mailbox_type,
      ok: true,
      discoverVia,
      graphAccessible: Boolean(graph),
      graphNote: discoverError,
      messagesWithAttachments: messages.length,
      attachments: attachmentSummaries,
    });
  }

  const registry = await listCompanyMailboxRegistry(env.DB, input.companyId);
  const namedPeople = await buildNamedPersonReports(env, {
    companyId: input.companyId,
    discoveredUsers,
    registry,
    mailboxReports,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    actor,
  });

  return {
    companyId: input.companyId,
    counts,
    mailboxes: mailboxReports,
    namedPeople,
    registry,
  };
}

async function buildNamedPersonReports(
  env: Env,
  input: {
    companyId: string;
    discoveredUsers: Array<{ mailboxAddress: string; displayName: string; userId: string; role: string }>;
    registry: MailboxRegistryRow[];
    mailboxReports: Array<Record<string, unknown>>;
    windowFrom: Date;
    windowTo: Date;
    actor: string;
  },
): Promise<NamedPersonMailboxReport[]> {
  const wanted = ["Michael", "Sharon", "Lauren"];
  const reports: NamedPersonMailboxReport[] = [];
  for (const name of wanted) {
    const user = input.discoveredUsers.find((row) => row.displayName.toLowerCase() === name.toLowerCase());
    const row = user
      ? input.registry.find((item) => item.mailbox_address.toLowerCase() === user.mailboxAddress.toLowerCase())
      : null;
    let graphAccessible: boolean | null = null;
    if (row?.mailbox_address) {
      graphAccessible = row.graph_accessible == null ? null : row.graph_accessible === 1;
    }
    reports.push({
      name,
      mailboxAddress: user?.mailboxAddress ?? null,
      mailboxFound: Boolean(user),
      approvedForAttachmentIngestion: row?.enabled_for_attachment_ingestion === 1,
      graphAccessible,
      mailSearchEnabled: row?.enabled_for_mail_search === 1,
      messagesWithAttachmentsInWindow: 0,
      attachmentsFound: 0,
      indexed: 0,
      policy: user
        ? row?.enabled_for_attachment_ingestion === 1
          ? "director-approved work mailbox: attachments ingested; Portal chat search remains off"
          : "personal_work mailbox exists as a company user; not approved for attachment ingest"
        : "no company membership mailbox found; not invented",
    });
  }
  return reports;
}
