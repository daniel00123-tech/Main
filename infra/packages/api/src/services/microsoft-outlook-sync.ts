/**
 * Outlook shared mailbox knowledge sync — messages and attachments into Company Knowledge.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { listMcpEnvironments } from "./control-plane";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  buildOutlookKnowledgeProvenance,
  buildMicrosoftMailExternalId,
} from "./microsoft-knowledge-bridge";
import {
  createMicrosoftFileJob,
  drainMicrosoftFileJobsForSyncRun,
  finalizeMicrosoftSyncRunIfComplete,
  getMicrosoftSourceJobStats,
  hasMicrosoftKnowledgeQueue,
} from "./microsoft-queue";
import { kickMicrosoftJobProcessor } from "./microsoft-job-processor";
import { resolveIncludedOutlookMailbox } from "./microsoft-outlook-mailbox";
import {
  formatOutlookProvenance,
  isOutlookAttachmentRetrievable,
  listMailboxMessagesDelta,
  listMessageAttachments,
  mailMessageVersionTag,
  type GraphMailMessageDetail,
} from "./microsoft-outlook-graph";
import { assessOutlookPermissions } from "./microsoft-outlook-permissions";

async function recordSyncRun(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId("msr");
  await db
    .prepare(
      `INSERT INTO microsoft_sync_runs (
        id, company_id, connector_instance_id, run_type, status, started_at, metadata_json
      ) VALUES (?, ?, ?, 'sync', 'running', ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      nowIso(),
      input.metadata ? JSON.stringify(input.metadata) : null,
    )
    .run();
  return id;
}

async function completeSyncRun(
  db: D1Database,
  runId: string,
  input: {
    status: "completed" | "failed" | "partial";
    itemsDiscovered?: number;
    itemsIndexed?: number;
    itemsFailed?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE microsoft_sync_runs SET
        status = ?, sources_processed = 1, items_discovered = ?, items_indexed = ?,
        items_failed = ?, completed_at = ?, metadata_json = COALESCE(?, metadata_json)
       WHERE id = ?`,
    )
    .bind(
      input.status,
      input.itemsDiscovered ?? 0,
      input.itemsIndexed ?? 0,
      input.itemsFailed ?? 0,
      nowIso(),
      input.metadata ? JSON.stringify(input.metadata) : null,
      runId,
    )
    .run();
}

function formatAddress(addr: { emailAddress?: { address?: string; name?: string } } | null): string | null {
  if (!addr?.emailAddress?.address) return null;
  const name = addr.emailAddress.name;
  return name ? `${name} <${addr.emailAddress.address}>` : addr.emailAddress.address;
}

function safeFileName(subject: string | null, messageId: string): string {
  const base = (subject ?? "message").replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "message";
  return `${base}-${messageId.slice(0, 8)}.txt`;
}

export async function syncOutlookMailbox(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    actor: string;
    useDelta?: boolean;
    maxMessages?: number;
    drainInline?: boolean;
    onJobsEnqueued?: (syncRunId: string) => void;
  },
): Promise<{
  discovered: number;
  queued: number;
  indexed: number;
  skipped: number;
  failed: number;
  syncRunId: string;
  mode: "queue" | "inline";
}> {
  const sourceRow = await env.DB.prepare(
    `SELECT * FROM microsoft_connector_sources WHERE id = ? AND company_id = ? AND source_type = 'outlook_shared' LIMIT 1`,
  )
    .bind(input.sourceId, input.companyId)
    .first<Record<string, unknown>>();
  if (!sourceRow) throw new Error("Outlook mailbox source not found");

  const mailboxAddress = sourceRow.mailbox_address ? String(sourceRow.mailbox_address) : null;
  if (!mailboxAddress) throw new Error("Mailbox address missing on source");

  const allowed = await resolveIncludedOutlookMailbox(env, {
    companyId: input.companyId,
    mailboxAddress,
    sourceId: input.sourceId,
  });
  if (!allowed.ok) throw new Error(allowed.message);

  const permissions = await assessOutlookPermissions(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
    probeMailboxAddress: mailboxAddress,
  });
  if (permissions.adminConsentRequired) {
    throw new Error(
      permissions.adminConsentBlocker ??
        "Mail.Read (Application) is required before Outlook mailbox ingestion.",
    );
  }

  const token = await acquireMicrosoftAppToken(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
  });
  if (!token.ok) throw new Error(token.message);

  const mcps = await listMcpEnvironments(env.DB, input.companyId);
  if (!mcps[0]) throw new Error("No Business MCP registered for this company");

  await env.DB.prepare(
    `UPDATE microsoft_connector_sources SET sync_status = 'syncing', updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), input.sourceId)
    .run();

  const deltaLink = sourceRow.delta_link ? String(sourceRow.delta_link) : null;
  const queueMode = hasMicrosoftKnowledgeQueue(env) && input.drainInline !== true;
  const maxMessages = input.maxMessages ?? 100;

  const syncRunId = await recordSyncRun(env.DB, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
    sourceId: input.sourceId,
    metadata: {
      mailboxAddress,
      useDelta: Boolean(input.useDelta && deltaLink),
      ingestionMode: queueMode ? "queue" : "inline",
      sourceType: "outlook_shared",
    },
  });

  let discovered = 0;
  let queued = 0;
  let skipped = 0;

  try {
    const delta = await listMailboxMessagesDelta(
      { accessToken: token.accessToken, tenantId: token.tenantId },
      {
        mailboxAddress,
        deltaLink: input.useDelta ? deltaLink : null,
        top: maxMessages,
      },
    );

    if (delta.deltaLink) {
      await env.DB.prepare(
        `UPDATE microsoft_connector_sources SET delta_link = ?, last_discovery_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(delta.deltaLink, nowIso(), nowIso(), input.sourceId)
        .run();
    }

    const activeMessages = delta.messages.filter((m) => !m["@removed"]);

    for (const message of activeMessages.slice(0, maxMessages)) {
      if (!message.id) continue;
      discovered++;

      const versionTag = mailMessageVersionTag(message);
      const existingItem = await env.DB.prepare(
        `SELECT indexing_status, e_tag, visibility_status FROM microsoft_knowledge_items
         WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
      )
        .bind(input.companyId, input.connectorInstanceId, message.id)
        .first<{ indexing_status: string; e_tag: string | null; visibility_status: string | null }>();

      if (
        existingItem?.indexing_status === "indexed" &&
        existingItem.visibility_status === "active" &&
        existingItem.e_tag === versionTag
      ) {
        skipped++;
        continue;
      }

      const subject = message.subject ?? "(no subject)";
      const job = await createMicrosoftFileJob(env, {
        companyId: input.companyId,
        connectorInstanceId: input.connectorInstanceId,
        sourceId: input.sourceId,
        syncRunId,
        driveId: mailboxAddress,
        externalItemId: message.id,
        fileName: safeFileName(message.subject, message.id),
        relativePath: `Inbox/${subject}`,
        mimeType: "text/plain",
        eTag: versionTag,
        modifiedAt: message.receivedDateTime,
        webUrl: message.webLink,
        sizeBytes: null,
        itemKind: "mail_message",
        sendToQueue: queueMode,
      });
      if (!job.duplicate) queued++;

      if (message.hasAttachments) {
        const attachments = await listMessageAttachments(
          { accessToken: token.accessToken, tenantId: token.tenantId },
          mailboxAddress,
          message.id,
        );
        for (const attachment of attachments) {
          if (!isOutlookAttachmentRetrievable(attachment.contentType, attachment.name)) continue;
          const attachmentItemId = `${message.id}|${attachment.id}`;
          const attachmentVersion = `${versionTag}|${attachment.size}`;
          const attachmentJob = await createMicrosoftFileJob(env, {
            companyId: input.companyId,
            connectorInstanceId: input.connectorInstanceId,
            sourceId: input.sourceId,
            syncRunId,
            driveId: mailboxAddress,
            externalItemId: attachmentItemId,
            fileName: attachment.name,
            relativePath: `Inbox/${subject}/attachments/${attachment.name}`,
            mimeType: attachment.contentType,
            eTag: attachmentVersion,
            modifiedAt: message.receivedDateTime,
            webUrl: message.webLink,
            sizeBytes: attachment.size,
            itemKind: "mail_attachment",
            parentMessageId: message.id,
            attachmentId: attachment.id,
            sendToQueue: queueMode,
          });
          if (!attachmentJob.duplicate) queued++;
        }
      }
    }

    if (!queueMode && queued > 0) {
      if (input.drainInline) {
        await drainMicrosoftFileJobsForSyncRun(env, syncRunId);
      } else if (input.onJobsEnqueued) {
        input.onJobsEnqueued(syncRunId);
      } else {
        await kickMicrosoftJobProcessor(env, syncRunId);
      }
    }

    if (queued === 0) {
      await finalizeMicrosoftSyncRunIfComplete(env, syncRunId, input.sourceId);
    }

    const jobStats = await getMicrosoftSourceJobStats(env.DB, {
      companyId: input.companyId,
      sourceId: input.sourceId,
      syncRunId,
    });
    const indexed = (jobStats.byStatus.indexed ?? 0) + (jobStats.byStatus.skipped_unchanged ?? 0);
    const failed = (jobStats.byStatus.failed ?? 0) + (jobStats.byStatus.dead_letter ?? 0);

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: queued > 0 && queueMode ? "connector.sync_started" : "connector.sync_completed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: input.sourceId,
      detail: {
        stage: queued > 0 && queueMode ? "outlook.mail.sync.enqueued" : "outlook.mail.sync.completed",
        mailboxAddress,
        discovered,
        queued,
        skipped,
        failed,
        syncRunId,
        provenance: formatOutlookProvenance({ mailboxAddress, folderName: "Inbox" }),
      },
    });

    await completeSyncRun(env.DB, syncRunId, {
      status: failed > 0 ? "partial" : "completed",
      itemsDiscovered: discovered,
      itemsIndexed: indexed,
      itemsFailed: failed,
      metadata: { mailboxAddress, queued, skipped, failed },
    });

    await env.DB.prepare(
      `UPDATE microsoft_connector_sources SET sync_status = ?, last_sync_at = ?, items_discovered = ?, items_indexed = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        failed > 0 ? "needs_attention" : "healthy",
        nowIso(),
        discovered,
        indexed,
        failed > 0 ? `${failed} mail item(s) failed ingestion` : null,
        nowIso(),
        input.sourceId,
      )
      .run();

    return {
      discovered,
      queued,
      indexed,
      skipped,
      failed,
      syncRunId,
      mode: queueMode ? "queue" : "inline",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Outlook sync failed";
    await env.DB.prepare(
      `UPDATE microsoft_connector_sources SET sync_status = 'error', last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(message, nowIso(), input.sourceId)
      .run();
    await completeSyncRun(env.DB, syncRunId, {
      status: "failed",
      metadata: { error: message },
    });
    throw err;
  }
}

export function summariseMailForReport(message: GraphMailMessageDetail, mailboxAddress: string) {
  return {
    id: message.id,
    subject: message.subject,
    from: formatAddress(message.from),
    receivedDateTime: message.receivedDateTime,
    internetMessageId: message.internetMessageId,
    provenance: formatOutlookProvenance({
      mailboxAddress,
      folderName: "Inbox",
      subject: message.subject,
      messageId: message.id,
    }),
    knowledgeExternalId: buildMicrosoftMailExternalId({ mailboxAddress, messageId: message.id }),
    provenanceRecord: buildOutlookKnowledgeProvenance({
      companyId: "",
      tenantId: null,
      mailboxAddress,
      messageId: message.id,
      internetMessageId: message.internetMessageId,
      subject: message.subject,
      from: formatAddress(message.from),
      to: (message.toRecipients ?? []).map((r) => formatAddress(r)).filter(Boolean) as string[],
      receivedDateTime: message.receivedDateTime,
      sentDateTime: message.sentDateTime,
    }),
  };
}
