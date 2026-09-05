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
import { listFailedMailboxAttachmentEvents, recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";
import { discoverKnowledgeIntakeTarget, storeOriginalInKnowledgeIntake } from "./knowledge-intake";
import { runProductionKnowledgeSearch } from "./microsoft-acceptance-knowledge-search";
import {
  discoverCompanyUserMailboxes,
  listApprovedAttachmentMailboxes,
  listCompanyMailboxRegistry,
  listExcludedAttachmentMailboxes,
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
import { executeCompanyMcpOutlookRead } from "./microsoft-outlook-company-mcp";
import {
  getMailFolder,
  getMessageAttachmentContent,
  listMailboxFolderMessages,
  listMailboxFoldersDeep,
  listMessageAttachments,
  type GraphMailAttachment,
  type GraphMailFolder,
  type GraphMailMessageDetail,
} from "./microsoft-outlook-graph";
import { MicrosoftGraphError } from "./microsoft-graph";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";
import { formatMailboxScanCount, mailboxScanHealth, type MailboxScanHealth } from "./mailbox-scan-status";
import {
  getMailboxFolderSettings,
  listEnabledMailboxFolders,
  markFolderScanResult,
  resolveApprovedIngestFolders,
  seedApprovedMailboxFolderPolicies,
  upsertApprovedMailboxFolder,
  type ResolvedIngestFolder,
} from "./mailbox-ingest-folder-policy";

const MAX_MESSAGES_PER_MAILBOX = 200;
const MAX_RETRIES = 4;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const MAILBOX_INGEST_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAILBOX_INGEST_CHECKPOINT_OVERLAP_MS = 2 * 60 * 1000;

export function resolveMailboxIngestWindow(input: {
  now: Date;
  lastCheckpoint?: string | null;
  maxLookbackMs?: number;
}): { windowFrom: Date; windowTo: Date; usedCheckpoint: boolean } {
  const windowTo = input.now;
  const maxLookback = input.maxLookbackMs ?? MAILBOX_INGEST_MAX_LOOKBACK_MS;
  const floor = new Date(windowTo.getTime() - maxLookback);
  const checkpointMs = input.lastCheckpoint ? Date.parse(input.lastCheckpoint) : Number.NaN;
  if (Number.isFinite(checkpointMs)) {
    const overlapped = new Date(checkpointMs - MAILBOX_INGEST_CHECKPOINT_OVERLAP_MS);
    return {
      windowFrom: overlapped.getTime() > floor.getTime() ? overlapped : floor,
      windowTo,
      usedCheckpoint: true,
    };
  }
  return { windowFrom: floor, windowTo, usedCheckpoint: false };
}

export type AttachmentIngestCounts = {
  mailboxesEligible: number;
  mailboxesScanned: number;
  mailboxesExcluded: number;
  messagesScanned: number;
  messagesWithAttachments: number;
  attachmentsDiscovered: number;
  attachmentsFetched: number;
  attachmentsStored: number;
  attachmentsExtracted: number;
  attachmentsIndexed: number;
  chunksAdded: number;
  skipped: number;
  skippedJunk: number;
  unsupported: number;
  failed: number;
  recovered: number;
  duplicates: number;
  retries: number;
};

export type MailboxFolderScanReport = {
  name: string;
  folderId: string | null;
  kind: string;
  checked: boolean;
  failed: boolean;
  messagesScanned: number | null;
  messagesWithAttachments: number;
  error: string | null;
};

export type NamedPersonMailboxReport = {
  name: string;
  mailboxAddress: string | null;
  mailboxFound: boolean;
  approvedForAttachmentIngestion: boolean;
  graphAccessible: boolean | null;
  mailSearchEnabled: boolean;
  messagesScanned: number | null;
  messagesScannedLabel: string;
  scanStatus: MailboxScanHealth;
  errorCode: string | null;
  messagesWithAttachmentsInWindow: number;
  attachmentsFound: number;
  fetched: number;
  stored: number;
  indexed: number;
  failures: number;
  policy: string;
  excluded: boolean;
  folders?: MailboxFolderScanReport[];
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
    mailboxesEligible: 0,
    mailboxesScanned: 0,
    mailboxesExcluded: 0,
    messagesScanned: 0,
    messagesWithAttachments: 0,
    attachmentsDiscovered: 0,
    attachmentsFetched: 0,
    attachmentsStored: 0,
    attachmentsExtracted: 0,
    attachmentsIndexed: 0,
    chunksAdded: 0,
    skipped: 0,
    skippedJunk: 0,
    unsupported: 0,
    failed: 0,
    recovered: 0,
    duplicates: 0,
    retries: 0,
  };
}

async function findIndexedByHash(
  db: D1Database,
  companyId: string,
  contentHash: string,
): Promise<{
  id: string;
  chunk_count: number | null;
  stored_item_id: string | null;
  stored_url: string | null;
  stored_at: string | null;
} | null> {
  return db
    .prepare(
      `SELECT id, chunk_count, stored_item_id, stored_url, stored_at FROM knowledge_ingestion_events
       WHERE company_id = ? AND content_hash = ? AND event_type IN ('indexed', 'reindexed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(companyId, contentHash)
    .first<{
      id: string;
      chunk_count: number | null;
      stored_item_id: string | null;
      stored_url: string | null;
      stored_at: string | null;
    }>();
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

function filterMessagesInWindow(
  rows: GraphMailMessageDetail[],
  windowFrom: Date,
  windowTo: Date,
): GraphMailMessageDetail[] {
  return rows.filter((row) => {
    if (row["@removed"]) return false;
    const when = messageTime(row);
    return when ? timestampInWindow(when, windowFrom, windowTo) : false;
  });
}

async function discoverMessagesViaGraph(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    windowFrom: Date;
    windowTo: Date;
    actor: string;
    useFolderCheckpoints?: boolean;
  },
): Promise<
  | {
      ok: true;
      source: "graph";
      messages: GraphMailMessageDetail[];
      messagesScanned: number;
      tenantId: string;
      accessToken: string;
      folders: MailboxFolderScanReport[];
      nextLinkFollowed: boolean;
    }
  | { ok: false; code: string; message: string; folders?: MailboxFolderScanReport[] }
> {
  const access = await resolveOutlookGraphAccess(env, {
    companyId: input.companyId,
    mailboxAddress: input.mailboxAddress,
    actor: input.actor,
  });
  if (!access.ok) return access;
  const config = { accessToken: access.accessToken, tenantId: access.tenantId };

  let inbox: GraphMailFolder;
  try {
    inbox = await withBoundedRetry(() => getMailFolder(config, input.mailboxAddress, "inbox"));
  } catch (err) {
    return {
      ok: false,
      code: "GRAPH_INBOX_UNAVAILABLE",
      message: err instanceof Error ? err.message : "Inbox folder could not be resolved",
    };
  }

  const listedFolders = await withBoundedRetry(() => listMailboxFoldersDeep(config, input.mailboxAddress)).catch(
    () => [inbox],
  );
  const settings = await getMailboxFolderSettings(env.DB, input.companyId, input.mailboxAddress);
  const enabledPolicies = await listEnabledMailboxFolders(env.DB, input.companyId, input.mailboxAddress);
  let sent: GraphMailFolder | null = null;
  let archive: GraphMailFolder | null = null;
  if (settings.includeSent) {
    sent = await getMailFolder(config, input.mailboxAddress, "sentitems").catch(() => null);
  }
  if (settings.includeArchive) {
    archive = await getMailFolder(config, input.mailboxAddress, "archive").catch(() => null);
  }
  const resolved = resolveApprovedIngestFolders({
    inbox,
    listedFolders,
    enabledPolicies,
    includeSent: settings.includeSent,
    includeArchive: settings.includeArchive,
    sent,
    archive,
  });

  const messagesById = new Map<string, GraphMailMessageDetail>();
  const folderReports: MailboxFolderScanReport[] = [];
  let messagesScanned = 0;
  let nextLinkFollowed = false;
  let inboxFailed = false;

  const scanFolder = async (folder: ResolvedIngestFolder) => {
    const folderWindow = input.useFolderCheckpoints
      ? resolveMailboxIngestWindow({
          now: input.windowTo,
          lastCheckpoint: folder.lastCheckpoint,
          maxLookbackMs: Math.min(
            MAILBOX_INGEST_MAX_LOOKBACK_MS,
            Math.max(60_000, input.windowTo.getTime() - input.windowFrom.getTime()),
          ),
        })
      : { windowFrom: input.windowFrom, windowTo: input.windowTo, usedCheckpoint: false };
    try {
      const listed = await withBoundedRetry(() =>
        listMailboxFolderMessages(config, {
          mailboxAddress: input.mailboxAddress,
          folderId: folder.folderId,
          top: 50,
          receivedAfter: folderWindow.windowFrom.toISOString(),
          maxItems: MAX_MESSAGES_PER_MAILBOX,
        }),
      );
      const inWindow = filterMessagesInWindow(listed.messages, folderWindow.windowFrom, folderWindow.windowTo);
      const withAttachments = inWindow.filter((row) => Boolean(row.hasAttachments));
      for (const message of withAttachments) {
        if (message.id && !messagesById.has(message.id)) messagesById.set(message.id, message);
      }
      messagesScanned += inWindow.length;
      nextLinkFollowed = nextLinkFollowed || listed.nextLinkFollowed;
      folderReports.push({
        name: folder.folderName,
        folderId: folder.folderId,
        kind: folder.kind,
        checked: true,
        failed: false,
        messagesScanned: inWindow.length,
        messagesWithAttachments: withAttachments.length,
        error: null,
      });
      await upsertApprovedMailboxFolder(env.DB, {
        companyId: input.companyId,
        mailboxAddress: input.mailboxAddress,
        folderName: folder.folderName,
        folderId: folder.folderId,
        enabled: true,
        source: folder.source === "always" ? "always" : folder.source,
      }).catch(() => undefined);
      await markFolderScanResult(env.DB, {
        companyId: input.companyId,
        mailboxAddress: input.mailboxAddress,
        folderName: folder.folderName,
        folderId: folder.folderId,
        checkpoint: inWindow[0] ? messageTime(inWindow[0]) : folder.lastCheckpoint,
        success: true,
        messagesScanned: inWindow.length,
      }).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "folder scan failed";
      if (folder.kind === "inbox") inboxFailed = true;
      folderReports.push({
        name: folder.folderName,
        folderId: folder.folderId,
        kind: folder.kind,
        checked: false,
        failed: true,
        messagesScanned: null,
        messagesWithAttachments: 0,
        error: message,
      });
      await markFolderScanResult(env.DB, {
        companyId: input.companyId,
        mailboxAddress: input.mailboxAddress,
        folderName: folder.folderName,
        folderId: folder.folderId,
        success: false,
        error: message,
      }).catch(() => undefined);
    }
  };

  for (const folder of resolved.folders) {
    await scanFolder(folder);
  }
  for (const missing of resolved.unresolved) {
    folderReports.push({
      name: missing.folderName,
      folderId: null,
      kind: "user",
      checked: false,
      failed: true,
      messagesScanned: null,
      messagesWithAttachments: 0,
      error: missing.reason,
    });
  }

  if (inboxFailed && messagesById.size === 0) {
    return {
      ok: false,
      code: "GRAPH_DISCOVER_FAILED",
      message: folderReports.find((row) => row.kind === "inbox")?.error || "Inbox scan failed",
      folders: folderReports,
    };
  }

  return {
    ok: true,
    source: "graph",
    messages: [...messagesById.values()],
    messagesScanned,
    tenantId: access.tenantId,
    accessToken: access.accessToken,
    folders: folderReports,
    nextLinkFollowed,
  };
}

function mapMcpListRows(
  rows: unknown[],
  windowFrom: Date,
  windowTo: Date,
): { messages: GraphMailMessageDetail[]; messagesScanned: number } {
  const inWindow = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .filter((row) =>
      timestampInWindow(asText(row.receivedDateTime) || asText(row.sentDateTime), windowFrom, windowTo),
    );
  const messages = inWindow
    .filter((row) => Boolean(row.hasAttachments) || Boolean(row.attachments))
    .map((row) => ({
      id: asText(row.id) || asText(row.messageId),
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
  return { messages, messagesScanned: inWindow.length };
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
): Promise<
  | { ok: true; messages: GraphMailMessageDetail[]; messagesScanned: number; via: string }
  | { ok: false; code: string; message: string }
> {
  const attempts: Array<{ toolName: string; arguments: Record<string, unknown>; label: string }> = [
    {
      toolName: "outlook_list_messages",
      arguments: { mailboxAddress: input.mailboxAddress, mailbox: input.mailboxAddress, limit: MAX_MESSAGES_PER_MAILBOX },
      label: "company_mcp_list",
    },
    {
      toolName: "outlook_search_mailbox",
      arguments: {
        mailboxAddress: input.mailboxAddress,
        mailbox: input.mailboxAddress,
        query: "hasAttachments:yes",
        limit: MAX_MESSAGES_PER_MAILBOX,
      },
      label: "company_mcp_search_attachments",
    },
    {
      toolName: "outlook_search_mailbox",
      arguments: {
        mailboxAddress: input.mailboxAddress,
        mailbox: input.mailboxAddress,
        query: input.mailboxAddress,
        limit: MAX_MESSAGES_PER_MAILBOX,
      },
      label: "company_mcp_search_address",
    },
  ];
  let lastError: { code: string; message: string } | null = null;
  for (const attempt of attempts) {
    const listed = await executeCompanyMcpOutlookRead(env, {
      companyId: input.companyId,
      toolName: attempt.toolName,
      arguments: attempt.arguments,
      actor: input.actor,
    }).catch(async (err: unknown) => {
      const fallback = await executeOutlookReadTool(env, {
        companyId: input.companyId,
        toolName: attempt.toolName,
        arguments: attempt.arguments,
        actor: input.actor,
      });
      if (!fallback.ok) {
        return {
          ok: false as const,
          status: fallback.status,
          code: fallback.code,
          message: `${fallback.message}; ${err instanceof Error ? err.message : "direct mcp failed"}`,
        };
      }
      return fallback;
    });
    if (!listed.ok) {
      lastError = { code: listed.code, message: listed.message };
      continue;
    }
    const record = asRecord(listed.result);
    const rows = Array.isArray(record?.messages) ? record!.messages : [];
    const mapped = mapMcpListRows(rows, input.windowFrom, input.windowTo);
    if (mapped.messagesScanned > 0 || mapped.messages.length > 0) {
      return { ok: true, ...mapped, via: attempt.label };
    }
    if (rows.length > 0) {
      return { ok: true, ...mapped, via: attempt.label };
    }
  }
  if (lastError) return { ok: false, code: lastError.code, message: lastError.message };
  return { ok: true, messages: [], messagesScanned: 0, via: "company_mcp_empty" };
}

type ListedAttachment = GraphMailAttachment & { contentId?: string | null; contentBytes?: string | null };

function mapListedAttachments(rows: unknown[]): ListedAttachment[] {
  return rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({
      id: asText(row.id) || asText(row.attachmentId),
      name: asText(row.name) || asText(row.filename),
      contentType: asText(row.contentType) || asText(row.mimeType) || null,
      size: Number(row.size ?? row.sizeBytes ?? 0),
      isInline: Boolean(row.isInline),
      contentId: asText(row.contentId) || asText(row.contentID) || null,
      contentBytes: asText(row.contentBytesBase64) || asText(row.contentBytes) || null,
    }));
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
): Promise<{ attachments: ListedAttachment[]; via: string }> {
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
  if (listed.ok) {
    const record = asRecord(listed.result);
    const rows = Array.isArray(record?.attachments) ? record!.attachments : [];
    const attachments = mapListedAttachments(rows);
    if (attachments.length) return { via: asText(record?.via) || "outlook_read", attachments };
  }
  const expanded = await executeOutlookReadTool(env, {
    companyId: input.companyId,
    toolName: "outlook_get_message",
    arguments: {
      mailboxAddress: input.mailboxAddress,
      messageId: input.messageId,
      includeAttachments: true,
      expand: "attachments",
    },
    actor: input.actor,
  });
  if (expanded.ok) {
    const record = asRecord(expanded.result);
    const rows = Array.isArray(record?.attachments) ? record!.attachments : [];
    const attachments = mapListedAttachments(rows);
    if (attachments.length) return { via: "company_mcp_get_expand", attachments };
  }
  return { attachments: [], via: listed.ok ? "ATTACHMENT_ENUM_EMPTY" : listed.code };
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

async function verifyIndexedDocumentRetrievable(
  env: Env,
  input: { companyId: string; filename: string; documentId: number; actor: string },
): Promise<{ ok: boolean; hitCount: number; reason: string | null }> {
  const query = input.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || input.filename;
  try {
    const search = await runProductionKnowledgeSearch(env, {
      companyId: input.companyId,
      query,
      limit: 8,
      actor: input.actor,
    });
    if (!search.ok) return { ok: false, hitCount: 0, reason: search.error ?? "knowledge search failed" };
    const matched = search.hits.some((hit) => {
      const title = (hit.title ?? "").toLowerCase();
      const id = String(hit.documentId ?? "");
      return id === String(input.documentId) || title.includes(input.filename.toLowerCase()) || title.includes(query.toLowerCase());
    });
    if (!matched) {
      return {
        ok: false,
        hitCount: search.hitCount,
        reason: search.hitCount === 0 ? "knowledge retrieval returned no hits" : "filename not in top hits",
      };
    }
    return { ok: true, hitCount: search.hitCount, reason: null };
  } catch (err) {
    return { ok: false, hitCount: 0, reason: err instanceof Error ? err.message : "retrieval verify failed" };
  }
}

export function isMailboxBlockingFailure(code: string | null | undefined): boolean {
  return (
    code === "FETCH_FAILED" ||
    code === "FETCH_TRANSIENT" ||
    code === "ATTACHMENT_ENUM_FAILED" ||
    code === "MCP_UNAVAILABLE"
  );
}

async function ingestOneAttachment(
  env: Env,
  input: {
    companyId: string;
    mailbox: MailboxRegistryRow;
    message: GraphMailMessageDetail;
    attachment: ListedAttachment;
    actor: string;
    graph?: { accessToken: string; tenantId: string } | null;
    tenantId: string | null;
    recoverExisting: boolean;
  },
): Promise<{
  status: "indexed" | "skipped" | "failed" | "duplicate" | "stored_not_indexed";
  chunks: number;
  recovered: boolean;
  stored: boolean;
  storedThisRun: boolean;
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

  if (filter.classification === "junk" || !filter.store) {
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
      metadata: { subject, from: sender, pipelineStatus: "SKIPPED", classification: filter.classification },
    });
    return {
      status: "skipped",
      chunks: 0,
      recovered: false,
      stored: false,
      storedThisRun: false,
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
      stored: true,
      storedThisRun: false,
      skipReason: "already_indexed",
      failureCode: null,
    };
  }

  let fetched;
  try {
    if (input.attachment.contentBytes) {
      fetched = {
        bytes: decodeBase64Bytes(input.attachment.contentBytes),
        name: input.attachment.name,
        contentType: input.attachment.contentType,
        size: input.attachment.size,
        via: "inline_list",
      };
    } else {
      fetched = await fetchAttachmentBytes(env, {
        companyId: input.companyId,
        mailboxAddress: input.mailbox.mailbox_address,
        messageId: input.message.id,
        attachmentId: input.attachment.id,
        actor: input.actor,
        graph: input.graph,
      });
    }
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
    return { status: "failed", chunks: 0, recovered: false, stored: false, storedThisRun: false, skipReason: message, failureCode: "FETCH_FAILED" };
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
      storedAt: hashed.stored_at,
      storedItemId: hashed.stored_item_id,
      storedUrl: hashed.stored_url,
      sourceModifiedAt: messageTime(input.message),
      metadata: {
        subject,
        from: sender,
        originalEventId: hashed.id,
        pipelineStatus: "STORED",
        reusedStoredItem: true,
      },
    });
    return {
      status: "duplicate",
      chunks: hashed.chunk_count ?? 0,
      recovered: false,
      stored: Boolean(hashed.stored_item_id),
      storedThisRun: false,
      skipReason: "duplicate_content_hash",
      failureCode: null,
    };
  }

  const storedAt = nowIso();
  const stored = await storeOriginalInKnowledgeIntake(env, {
    companyId: input.companyId,
    mailboxAddress: input.mailbox.mailbox_address,
    filename: fetched.name,
    mimeType: fetched.contentType,
    bytes: fetched.bytes,
    contentHash,
    attachmentId: input.attachment.id,
    receivedAt: messageTime(input.message) ? new Date(messageTime(input.message)!) : new Date(),
    actor: input.actor,
    quarantine: filter.classification === "unsafe",
  });
  if (!stored.ok) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "failed",
      providerItemId,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      failureCode: stored.code,
      skipReason: stored.message,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, from: sender, pipelineStatus: "FAILED_RETRYABLE", stop: "STORE" },
    });
    return {
      status: "failed",
      chunks: 0,
      recovered: false,
      stored: false,
      storedThisRun: false,
      skipReason: stored.message,
      failureCode: stored.code,
    };
  }

  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: "outlook_attachments",
    eventType: "stored",
    providerItemId,
    parentMessageId: input.message.id,
    filename: fetched.name,
    contentHash,
    mailboxAddress: input.mailbox.mailbox_address,
    mimeType: fetched.contentType,
    sizeBytes: fetched.bytes.byteLength,
    storedAt,
    storedItemId: stored.storedItemId,
    storedUrl: stored.storedUrl,
    sourceModifiedAt: messageTime(input.message),
    metadata: {
      subject,
      from: sender,
      pipelineStatus: "STORED",
      storeVia: stored.via,
      landingZoneReady: stored.landingZoneReady,
      warning: stored.warning,
      quarantine: filter.classification === "unsafe",
    },
  });

  if (!filter.ingest) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "skipped",
      providerItemId,
      parentMessageId: input.message.id,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      skipReason: filter.skipReason,
      failureCode: filter.failureCode,
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: {
        subject,
        from: sender,
        pipelineStatus: "STORED_NOT_INDEXED",
        classification: filter.classification,
        storeVia: stored.via,
      },
    });
    return {
      status: "stored_not_indexed",
      chunks: 0,
      recovered: false,
      stored: true,
      storedThisRun: true,
      skipReason: filter.skipReason,
      failureCode: filter.failureCode,
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
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, pipelineStatus: "FAILED_RETRYABLE", stop: "INDEX" },
    });
    return {
      status: "failed",
      chunks: 0,
      recovered: false,
      stored: true,
      storedThisRun: true,
      skipReason: "Business MCP unavailable",
      failureCode: "MCP_UNAVAILABLE",
    };
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
  provenance.stored_provider_item_id = stored.storedItemId;
  provenance.stored_url = stored.storedUrl;
  provenance.stored_at = storedAt;

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
          knowledgeIntake: true,
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
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, stop: "INDEX", pipelineStatus: "FAILED_RETRYABLE" },
    });
    return {
      status: "failed",
      chunks: 0,
      recovered: false,
      stored: true,
      storedThisRun: true,
      skipReason: message,
      failureCode: "INDEX_WRITE_FAILED",
    };
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
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: { subject, stop: "EXTRACT_OR_INDEX", pipelineStatus: "FAILED_RETRYABLE" },
    });
    return {
      status: "failed",
      chunks: 0,
      recovered: false,
      stored: true,
      storedThisRun: true,
      skipReason: upload.message,
      failureCode: upload.code,
    };
  }

  const chunks = upload.chunksIndexed ?? (upload.indexed ? 1 : 0);
  if (!upload.indexed) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "extracted",
      providerItemId,
      parentMessageId: input.message.id,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      mimeType: fetched.contentType,
      sizeBytes: fetched.bytes.byteLength,
      chunkCount: chunks,
      extractedAt: nowIso(),
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: {
        subject,
        from: sender,
        knowledgeDocumentId: upload.documentId,
        externalId,
        pipelineStatus: "STORED_NOT_INDEXED",
        documentStatus: upload.documentStatus ?? null,
      },
    });
    return {
      status: "failed",
      chunks,
      recovered: input.recoverExisting,
      stored: true,
      storedThisRun: true,
      skipReason: upload.documentStatus ?? "not indexed",
      failureCode: "NOT_INDEXED",
    };
  }

  const verified = await verifyIndexedDocumentRetrievable(env, {
    companyId: input.companyId,
    filename: fetched.name,
    documentId: upload.documentId,
    actor: input.actor,
  });
  if (!verified.ok) {
    await recordKnowledgeIngestionEvent(env.DB, {
      companyId: input.companyId,
      sourceType: "outlook_attachments",
      eventType: "extracted",
      providerItemId,
      parentMessageId: input.message.id,
      filename: fetched.name,
      contentHash,
      mailboxAddress: input.mailbox.mailbox_address,
      chunkCount: chunks,
      extractedAt: nowIso(),
      storedAt,
      storedItemId: stored.storedItemId,
      storedUrl: stored.storedUrl,
      sourceModifiedAt: messageTime(input.message),
      metadata: {
        subject,
        from: sender,
        knowledgeDocumentId: upload.documentId,
        pipelineStatus: "STORED",
        retrievalVerified: false,
        retrievalReason: verified.reason,
      },
    });
    return {
      status: "failed",
      chunks,
      recovered: input.recoverExisting,
      stored: true,
      storedThisRun: true,
      skipReason: verified.reason ?? "retrieval verification failed",
      failureCode: "RETRIEVAL_UNVERIFIED",
    };
  }

  await recordKnowledgeIngestionEvent(env.DB, {
    companyId: input.companyId,
    sourceType: "outlook_attachments",
    eventType: "indexed",
    providerItemId,
    parentMessageId: input.message.id,
    filename: fetched.name,
    contentHash,
    mailboxAddress: input.mailbox.mailbox_address,
    mimeType: fetched.contentType,
    sizeBytes: fetched.bytes.byteLength,
    chunkCount: chunks,
    extractedAt: nowIso(),
    indexedAt: nowIso(),
    storedAt,
    storedItemId: stored.storedItemId,
    storedUrl: stored.storedUrl,
    sourceModifiedAt: messageTime(input.message),
    metadata: {
      subject,
      from: sender,
      knowledgeDocumentId: upload.documentId,
      externalId,
      extractionQuality: upload.extractionQuality ?? null,
      documentStatus: upload.documentStatus ?? null,
      pipelineStatus: "INDEXED",
      retrievalVerified: true,
      storeVia: stored.via,
      storedUrl: stored.storedUrl,
    },
  });

  return {
    status: "indexed",
    chunks,
    recovered: input.recoverExisting,
    stored: true,
    storedThisRun: true,
    skipReason: null,
    failureCode: null,
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
    useMailboxCheckpoints?: boolean;
    mailboxAddresses?: string[];
  },
): Promise<{
  companyId: string;
  counts: AttachmentIngestCounts;
  mailboxes: Array<Record<string, unknown>>;
  excludedMailboxes: Array<Record<string, unknown>>;
  namedPeople: NamedPersonMailboxReport[];
  registry: MailboxRegistryRow[];
}> {
  const actor = input.actor ?? "system:outlook-attachment-ingest";
  await discoverKnowledgeIntakeTarget(env, { companyId: input.companyId, actor }).catch(() => undefined);
  await seedPolicyMailboxes(env.DB, input.companyId);
  await seedApprovedMailboxFolderPolicies(env.DB, input.companyId);
  const discoveredUsers = await discoverCompanyUserMailboxes(env, input.companyId);
  const approvedAll = await listApprovedAttachmentMailboxes(env.DB, input.companyId);
  const wanted = (input.mailboxAddresses ?? []).map((row) => row.trim().toLowerCase()).filter(Boolean);
  const approved = wanted.length
    ? approvedAll.filter((row) => wanted.includes(row.mailbox_address.toLowerCase()))
    : approvedAll;
  const excluded = wanted.length ? [] : await listExcludedAttachmentMailboxes(env.DB, input.companyId);
  const counts = emptyCounts();
  counts.mailboxesEligible = approved.length;
  counts.mailboxesExcluded = excluded.length;
  const mailboxReports: Array<Record<string, unknown>> = [];
  const excludedReports = excluded.map((mailbox) => ({
    mailboxAddress: mailbox.mailbox_address,
    mailboxType: mailbox.mailbox_type,
    displayName: mailbox.display_name,
    excluded: true,
    scanned: false,
    reason: "explicit exclusion or inherit-default EXCLUDE",
  }));

  for (const mailbox of approved) {
    counts.mailboxesScanned += 1;
    const mailboxWindow = input.useMailboxCheckpoints
      ? resolveMailboxIngestWindow({
          now: input.windowTo,
          lastCheckpoint: mailbox.last_checkpoint,
          maxLookbackMs: Math.min(
            MAILBOX_INGEST_MAX_LOOKBACK_MS,
            Math.max(60_000, input.windowTo.getTime() - input.windowFrom.getTime()),
          ),
        })
      : { windowFrom: input.windowFrom, windowTo: input.windowTo, usedCheckpoint: false };
    const graphDiscover = await discoverMessagesViaGraph(env, {
      companyId: input.companyId,
      mailboxAddress: mailbox.mailbox_address,
      windowFrom: mailboxWindow.windowFrom,
      windowTo: mailboxWindow.windowTo,
      actor,
      useFolderCheckpoints: input.useMailboxCheckpoints === true,
    }).catch((err: unknown) => ({
      ok: false as const,
      code: "GRAPH_DISCOVER_FAILED",
      message: err instanceof Error ? err.message : "graph discover failed",
      folders: [] as MailboxFolderScanReport[],
    }));

    let messages: GraphMailMessageDetail[] = [];
    let graph: { accessToken: string; tenantId: string } | null = null;
    let discoverVia = "none";
    let discoverError: string | null = null;
    let errorCode: string | null = null;
    let provenEmpty = false;
    let folderReports: MailboxFolderScanReport[] = [];
    let nextLinkFollowed = false;

    let messagesScanned: number | null = null;
    if (graphDiscover.ok) {
      messages = graphDiscover.messages;
      messagesScanned = graphDiscover.messagesScanned;
      graph = { accessToken: graphDiscover.accessToken, tenantId: graphDiscover.tenantId };
      discoverVia = "graph";
      provenEmpty = graphDiscover.messagesScanned === 0;
      folderReports = graphDiscover.folders;
      nextLinkFollowed = graphDiscover.nextLinkFollowed;
    } else {
      const mcpDiscover = await discoverMessagesViaMcp(env, {
        companyId: input.companyId,
        mailboxAddress: mailbox.mailbox_address,
        windowFrom: mailboxWindow.windowFrom,
        windowTo: mailboxWindow.windowTo,
        actor,
      });
      if (mcpDiscover.ok && (mcpDiscover.messagesScanned > 0 || mcpDiscover.messages.length > 0)) {
        messages = mcpDiscover.messages;
        messagesScanned = mcpDiscover.messagesScanned;
        discoverVia = mcpDiscover.via;
        discoverError = graphDiscover.ok === false ? graphDiscover.message : null;
        errorCode = graphDiscover.ok === false ? graphDiscover.code : null;
      } else {
        const mcpNote = mcpDiscover.ok
          ? "MCP listed this mailbox as empty after Graph auth failed — empty is unproven"
          : mcpDiscover.message;
        errorCode = mcpDiscover.ok ? "MCP_EMPTY_UNPROVEN" : mcpDiscover.code;
        discoverError = `${graphDiscover.ok === false ? graphDiscover.message : ""}; ${mcpNote}`;
        await markMailboxScanResult(env.DB, {
          companyId: input.companyId,
          mailboxAddress: mailbox.mailbox_address,
          checkpoint: null,
          success: false,
          graphAccessible: false,
          error: `${errorCode}: ${discoverError}`,
          messagesScanned: null,
        });
        mailboxReports.push({
          mailboxAddress: mailbox.mailbox_address,
          mailboxType: mailbox.mailbox_type,
          ok: false,
          scanned: true,
          scanFailed: true,
          scanStatus: "FAILED",
          messagesScanned: null,
          scannedLabel: formatMailboxScanCount({ health: "FAILED", messagesScanned: null, errorCode }),
          error: discoverError,
          errorCode,
          discoverVia: mcpDiscover.ok ? mcpDiscover.via : "none",
          folders: graphDiscover.folders ?? [],
        });
        continue;
      }
    }

    counts.messagesScanned += messagesScanned ?? 0;
    counts.messagesWithAttachments += messages.length;
    const attachmentSummaries: Array<Record<string, unknown>> = [];
    let latestCheckpoint = mailbox.last_checkpoint;
    let mailboxFailures = 0;

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
        mailboxFailures += 1;
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
          if (result.storedThisRun) counts.attachmentsStored += 1;
          counts.attachmentsExtracted += 1;
          counts.attachmentsIndexed += 1;
          counts.chunksAdded += result.chunks;
          if (result.recovered) counts.recovered += 1;
        } else if (result.status === "duplicate") {
          counts.attachmentsFetched += 1;
          if (result.storedThisRun) counts.attachmentsStored += 1;
          counts.duplicates += 1;
          counts.skipped += 1;
        } else if (result.status === "stored_not_indexed") {
          counts.attachmentsFetched += 1;
          if (result.storedThisRun) counts.attachmentsStored += 1;
          counts.unsupported += 1;
          counts.skipped += 1;
        } else if (result.status === "skipped") {
          counts.skipped += 1;
          counts.skippedJunk += 1;
        } else {
          counts.attachmentsFetched += 1;
          if (result.storedThisRun) counts.attachmentsStored += 1;
          counts.failed += 1;
          if (isMailboxBlockingFailure(result.failureCode)) mailboxFailures += 1;
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
          stored: result.stored,
          skipReason: result.skipReason,
          failureCode: result.failureCode,
        });
      }
      const when = messageTime(message);
      if (when && (!latestCheckpoint || when > latestCheckpoint)) latestCheckpoint = when;
    }

    const scanCompleted = true;
    const health = mailboxScanHealth({
      scanned: true,
      scanFailed: !scanCompleted,
      graphFailed: !graph && Boolean(discoverError),
      fetchFailed: mailboxFailures > 0,
      messagesScanned,
      failures: mailboxFailures,
      lastScanAt: mailbox.last_attachment_scan_at,
    });
    await markMailboxScanResult(env.DB, {
      companyId: input.companyId,
      mailboxAddress: mailbox.mailbox_address,
      checkpoint: scanCompleted ? latestCheckpoint : null,
      success: scanCompleted,
      graphAccessible: Boolean(graph),
      warning:
        scanCompleted && mailboxFailures > 0
          ? `DEGRADED: ${mailboxFailures} attachments will be retried`
          : null,
      error: scanCompleted ? null : errorCode || discoverError || "mailbox scan failed",
      messagesScanned,
    });
    mailboxReports.push({
      mailboxAddress: mailbox.mailbox_address,
      mailboxType: mailbox.mailbox_type,
      ok: scanCompleted,
      scanned: true,
      scanFailed: !scanCompleted,
      scanStatus: health,
      discoverVia,
      graphAccessible: Boolean(graph),
      graphNote: discoverError,
      errorCode: scanCompleted ? null : errorCode,
      messagesScanned,
      scannedLabel: formatMailboxScanCount({
        health,
        messagesScanned,
        errorCode: scanCompleted ? null : errorCode,
      }),
      provenEmpty,
      messagesWithAttachments: messages.length,
      attachments: attachmentSummaries,
      failed: mailboxFailures,
      folders: folderReports,
      nextLinkFollowed,
    });
  }

  const registry = await listCompanyMailboxRegistry(env.DB, input.companyId);
  const namedPeople = await buildNamedPersonReports(env, {
    companyId: input.companyId,
    discoveredUsers,
    registry,
    mailboxReports,
    excludedReports,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    actor,
  });

  return {
    companyId: input.companyId,
    counts,
    mailboxes: mailboxReports,
    excludedMailboxes: excludedReports,
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
    excludedReports: Array<Record<string, unknown>>;
    windowFrom: Date;
    windowTo: Date;
    actor: string;
  },
): Promise<NamedPersonMailboxReport[]> {
  const wanted = ["Michael", "Sharon", "Lauren", "William", "Ella"];
  const reports: NamedPersonMailboxReport[] = [];
  for (const name of wanted) {
    const needle = `${name.toLowerCase()}@`;
    const user = input.discoveredUsers.find((row) => row.displayName.toLowerCase().startsWith(name.toLowerCase()));
    const row =
      (user
        ? input.registry.find((item) => item.mailbox_address.toLowerCase() === user.mailboxAddress.toLowerCase())
        : null) ??
      input.registry.find(
        (item) =>
          (item.display_name ?? "").toLowerCase().startsWith(name.toLowerCase()) ||
          item.mailbox_address.toLowerCase().startsWith(needle),
      );
    let graphAccessible: boolean | null = null;
    if (row?.mailbox_address) {
      graphAccessible = row.graph_accessible == null ? null : row.graph_accessible === 1;
    }
    const scanned = input.mailboxReports.find(
      (item) =>
        String(item.mailboxAddress ?? "").toLowerCase() ===
        (user?.mailboxAddress ?? row?.mailbox_address ?? "").toLowerCase(),
    );
    const excluded = input.excludedReports.some(
      (item) =>
        String(item.mailboxAddress ?? "").toLowerCase() ===
        (user?.mailboxAddress ?? row?.mailbox_address ?? "").toLowerCase(),
    );
    const scannedAttachments = Array.isArray(scanned?.attachments) ? scanned!.attachments : [];
    const included = row?.enabled_for_attachment_ingestion === 1 && !excluded;
    const scanFailed = Boolean(scanned?.scanFailed) || scanned?.ok === false;
    const health = mailboxScanHealth({
      excluded: !included,
      scanned: Boolean(scanned),
      scanFailed,
      lastScanAt: row?.last_attachment_scan_at,
      graphFailed: scanned?.graphAccessible === false,
      fetchFailed: Number(scanned?.failed ?? 0) > 0,
      messagesScanned: scanned && scanned.messagesScanned != null ? Number(scanned.messagesScanned) : null,
      failures: Number(scanned?.failed ?? 0),
    });
    const errorCode = scanFailed
      ? asText(scanned?.errorCode) || asText(scanned?.error) || "MAILBOX_SCAN_FAILED"
      : included && !scanned
        ? "MAILBOX_COVERAGE_GAP"
        : null;
    const messagesScanned =
      scanFailed || health === "COVERAGE_GAP" || health === "FAILED"
        ? null
        : scanned && scanned.messagesScanned != null
          ? Number(scanned.messagesScanned)
          : included
            ? null
            : 0;
    reports.push({
      name,
      mailboxAddress: user?.mailboxAddress ?? row?.mailbox_address ?? null,
      mailboxFound: Boolean(user || row),
      approvedForAttachmentIngestion: included,
      graphAccessible,
      mailSearchEnabled: row?.enabled_for_mail_search === 1,
      messagesScanned,
      messagesScannedLabel: formatMailboxScanCount({ health, messagesScanned, errorCode }),
      scanStatus: health,
      errorCode,
      messagesWithAttachmentsInWindow: Number(scanned?.messagesWithAttachments ?? 0),
      attachmentsFound: scannedAttachments.length || Number(scanned?.messagesWithAttachments ?? 0),
      fetched: scannedAttachments.filter((item) => {
        const status = asText(asRecord(item)?.status);
        return status === "indexed" || status === "duplicate" || status === "stored_not_indexed" || status === "failed";
      }).length,
      stored: scannedAttachments.filter((item) => {
        const status = asText(asRecord(item)?.status);
        return status === "indexed" || status === "duplicate" || status === "stored_not_indexed" || Boolean(asRecord(item)?.stored);
      }).length,
      indexed: scannedAttachments.filter((item) => asRecord(item)?.status === "indexed").length,
      failures: scannedAttachments.filter((item) => asRecord(item)?.status === "failed").length,
      excluded: !included,
      folders: Array.isArray(scanned?.folders) ? (scanned!.folders as MailboxFolderScanReport[]) : [],
      policy: included
        ? "inherit company default INCLUDE; Portal chat search remains off for personal work mailboxes"
        : user || row
          ? name === "William" || name === "Ella"
            ? "explicit EXCLUDE: attachment knowledge ingest off; product access/roles unchanged"
            : "excluded by company mailbox ingestion policy"
          : "no company membership mailbox found; not invented",
    });
  }
  return reports;
}

export async function retryFailedOutlookAttachments(
  env: Env,
  input: { companyId: string; mailboxAddresses: string[]; actor?: string; limit?: number },
): Promise<{
  retried: number;
  succeeded: number;
  stillFailed: number;
  items: Array<{ filename: string | null; mailboxAddress: string | null; status: string; reason: string | null }>;
}> {
  const actor = input.actor ?? "system:mailbox-attachment-retry";
  const mailboxes = await listApprovedAttachmentMailboxes(env.DB, input.companyId);
  const wanted = new Map(mailboxes.map((row) => [row.mailbox_address.toLowerCase(), row]));
  const failed = await listFailedMailboxAttachmentEvents(env.DB, {
    companyId: input.companyId,
    mailboxAddresses: input.mailboxAddresses,
    limit: input.limit ?? 80,
  });
  const graphByMailbox = new Map<string, { accessToken: string; tenantId: string } | null>();
  const items: Array<{ filename: string | null; mailboxAddress: string | null; status: string; reason: string | null }> = [];
  let succeeded = 0;
  let stillFailed = 0;
  for (const row of failed) {
    const address = String(row.mailbox_address ?? "").toLowerCase();
    const mailbox = wanted.get(address);
    if (!mailbox) {
      items.push({ filename: row.filename, mailboxAddress: row.mailbox_address, status: "skipped", reason: "mailbox not approved" });
      continue;
    }
    if (!graphByMailbox.has(address)) {
      graphByMailbox.set(
        address,
        await resolveOutlookGraphAccess(env, { companyId: input.companyId, mailboxAddress: mailbox.mailbox_address }).catch(
          () => null,
        ),
      );
    }
    const graph = graphByMailbox.get(address) ?? null;
    const provider = String(row.provider_item_id ?? "");
    const [messageId, attachmentId] = provider.includes("|") ? provider.split("|") : [row.parent_message_id ?? provider, ""];
    if (!messageId) {
      items.push({ filename: row.filename, mailboxAddress: row.mailbox_address, status: "still_failed", reason: "missing message id" });
      stillFailed += 1;
      continue;
    }
    const listed = await listAttachmentsForMessage(env, {
      companyId: input.companyId,
      mailboxAddress: mailbox.mailbox_address,
      messageId,
      actor,
      graph,
    });
    const targets = listed.attachments.filter((item) => !attachmentId || item.id === attachmentId);
    if (!targets.length) {
      items.push({
        filename: row.filename,
        mailboxAddress: row.mailbox_address,
        status: "still_failed",
        reason: listed.via || "attachment not listed",
      });
      stillFailed += 1;
      continue;
    }
    for (const attachment of targets) {
      const message: GraphMailMessageDetail = {
        id: messageId,
        subject: row.filename ?? null,
        bodyPreview: null,
        from: null,
        sender: null,
        toRecipients: [],
        ccRecipients: [],
        receivedDateTime: row.source_modified_at ?? null,
        sentDateTime: null,
        conversationId: null,
        internetMessageId: null,
        hasAttachments: true,
        webLink: null,
        parentFolderId: null,
      };
      const result = await ingestOneAttachment(env, {
        companyId: input.companyId,
        mailbox,
        message,
        attachment,
        actor,
        graph,
        tenantId: graph?.tenantId ?? null,
        recoverExisting: true,
      });
      if (result.status === "failed") {
        stillFailed += 1;
        items.push({
          filename: attachment.name ?? row.filename,
          mailboxAddress: row.mailbox_address,
          status: "still_failed",
          reason: result.failureCode ?? result.skipReason,
        });
      } else {
        succeeded += 1;
        items.push({
          filename: attachment.name ?? row.filename,
          mailboxAddress: row.mailbox_address,
          status: result.status,
          reason: result.skipReason,
        });
      }
    }
  }
  return { retried: failed.length, succeeded, stillFailed, items };
}
