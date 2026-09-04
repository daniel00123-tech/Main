/**
 * Forensic EL knowledge ingestion audit for a frozen reporting window.
 * Reads Graph/MCP source activity and INFRA/MCP index metadata. No secret output.
 */

import {
  ELVEX_FINANCE_MAILBOXES,
  ELVEX_INFO_MAILBOXES,
  automationRecipientEmailOf,
  capKnowledgeList,
  classifyKnowledgePipelineHealth,
  formatCivilDateLong,
  isValidRecipientEmail,
  knowledgeIngestionGapWarning,
  renderKnowledgeIngestionReportEmail,
  timestampInWindow,
  zonedCivilParts,
} from "@infra/shared";
import type { Env } from "../env";
import { executeRegisteredMcpTool, getCompanyById, listMcpEnvironments } from "./control-plane";
import { queryKnowledgeIngestionActivity } from "./automation-engine/knowledge-ingestion-query";
import { getAutomationDefinition } from "./automation-engine/store";
import { executeListDocuments } from "./document-catalogue";
import { ELVEX_QUERY_TOOL } from "./document-fetch";
import { sendTransactionalEmail } from "./email/send-transactional";
import { recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";
import { executeOutlookReadTool } from "./microsoft-outlook-read";
import { isOutlookAttachmentRetrievable } from "./microsoft-outlook-graph";
import { extractHitList, toStandardSearchPayload, unwrapToolPayload } from "./mcp-knowledge-standard";
import { ingestApprovedOutlookAttachments } from "./outlook-attachment-ingest";
import { seedPolicyMailboxes } from "./mailbox-registry";
import { newId, nowIso } from "../db/mappers";
import { portalOrigin } from "./public-urls";

export const EL_KNOWLEDGE_AUDIT_WINDOW = {
  from: "2026-09-03T17:39:03.388Z",
  to: "2026-09-04T17:39:03.388Z",
} as const;

export const EL_KNOWLEDGE_CORRECTED_SUBJECT =
  "INFRA — EL Business Daily Knowledge Activity — Attachment landing-zone confirmation";

const COMPANY_ID = "co_el";
const AUTOMATION_ID = "aut_b00ab912-845b-49b4-9609-cbedeeea6ddf";
const MAILBOXES = ["info@elvexpropertyservices.com", "finance@elvexpropertyservices.com"] as const;
const TIMEZONE = "Europe/London";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function messageTime(row: Record<string, unknown>): string | null {
  return asText(row.receivedDateTime) || asText(row.sentDateTime) || asText(row.date) || null;
}

function sqlIso(value: Date): string {
  return value.toISOString().replace(/'/g, "");
}

function sqlLite(value: Date): string {
  return sqlIso(value).replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
}

function rowsFromQueryPayload(payload: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapToolPayload(payload);
  if (!asRecord(unwrapped)) return [];
  const record = asRecord(unwrapped)!;
  if (Array.isArray(record.rows)) return record.rows.filter((row): row is Record<string, unknown> => Boolean(asRecord(row)));
  if (Array.isArray(record.results)) return record.results.filter((row): row is Record<string, unknown> => Boolean(asRecord(row)));
  return extractHitList(unwrapped);
}

export async function runElKnowledgeIngestionAudit(
  env: Env,
  input?: {
    windowFrom?: string;
    windowTo?: string;
    persistEvents?: boolean;
    actor?: string;
    sendCorrectedEmail?: boolean;
    includeCurrentWindow?: boolean;
  },
): Promise<Record<string, unknown>> {
  const windowFrom = new Date(input?.windowFrom ?? EL_KNOWLEDGE_AUDIT_WINDOW.from);
  const windowTo = new Date(input?.windowTo ?? EL_KNOWLEDGE_AUDIT_WINDOW.to);
  const persist = input?.persistEvents !== false;
  const actor = input?.actor ?? "system:el-knowledge-ingestion-audit";

  await seedPolicyMailboxes(env.DB, COMPANY_ID);
  const ingest = await ingestApprovedOutlookAttachments(env, {
    companyId: COMPANY_ID,
    windowFrom,
    windowTo,
    actor,
    recoverExisting: true,
  });
  const retrievalProof = await proveAttachmentKnowledgeRetrieval(env, ingest, actor);
  const outlook = await auditOutlookMailboxes(env, windowFrom, windowTo, false, actor);
  const files = await auditDriveCatalogue(env, windowFrom, windowTo, persist, actor);
  const mcpIndex = await auditMcpIndex(env, windowFrom, windowTo, actor);
  const report = await queryKnowledgeIngestionActivity(env, {
    companyId: COMPANY_ID,
    windowFrom,
    windowTo,
  });

  const sourceCandidates = outlook.attachments + files.onedriveInWindow + files.sharepointInWindow;
  const discovered = report.discoveredCount;
  const indexed = report.indexedCount;
  const missed = outlook.missed + files.onedriveMissed + files.sharepointMissed;

  let currentWindow: Record<string, unknown> | null = null;
  if (input?.includeCurrentWindow !== false) {
    const currentTo = new Date();
    const currentReport = await queryKnowledgeIngestionActivity(env, {
      companyId: COMPANY_ID,
      windowFrom: windowTo,
      windowTo: currentTo,
    });
    currentWindow = {
      windowFrom: windowTo.toISOString(),
      windowTo: currentTo.toISOString(),
      discoveredCount: currentReport.discoveredCount,
      indexedCount: currentReport.indexedCount,
      updatedCount: currentReport.updatedCount,
      sourceObservedCount: currentReport.sourceObservedCount,
      missedCount: currentReport.missedCount,
      failedCount: currentReport.failedCount,
      sourceCounts: currentReport.sourceCounts,
      emailed: false,
    };
  }

  const payload: Record<string, unknown> = {
    companyId: COMPANY_ID,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    timezone: TIMEZONE,
    outlook,
    onedrive: {
      createdOrModifiedInWindow: files.onedriveInWindow,
      discovered: files.onedriveDiscovered,
      indexedOrReindexed: files.onedriveIndexed,
      missed: files.onedriveMissed,
      newestIndexedModifiedAt: files.onedriveNewestModified,
      catalogueInWindow: mcpIndex.onedriveInWindow,
      catalogueTotal: mcpIndex.onedriveTotal,
      staffOwners: mcpIndex.staffOwners ?? [],
    },
    sharepoint: {
      createdOrModifiedInWindow: files.sharepointInWindow,
      discovered: files.sharepointDiscovered,
      indexedOrReindexed: files.sharepointIndexed,
      missed: files.sharepointMissed,
      catalogueStatus: files.sharepointStatus,
      catalogueInWindow: mcpIndex.sharepointInWindow,
      catalogueTotal: mcpIndex.sharepointTotal,
    },
    otherM365: { teams: "not_a_configured_source", personalDrivesOutsideCatalogue: files.otherPersonalNote },
    totals: {
      sourceCandidates,
      discovered,
      extracted: report.documents.filter((row) => row.extracted).length,
      indexed,
      chunks: report.chunkTotal,
      updatedReindexed: report.updatedCount,
      skipped: report.duplicateCount,
      failed: report.failedCount,
      missed,
    },
    report,
    mcpIndex,
    currentWindow,
    pipeline: {
      emailAttachmentAutoIngest: "YES_APPROVED_MAILBOXES",
      sharepointAutoIngest: "PARTIAL",
      onedriveAutoIngest: "PARTIAL",
      ingestCounts: ingest.counts,
      namedPeople: ingest.namedPeople,
      registry: ingest.registry.map((row) => ({
        mailboxAddress: row.mailbox_address,
        mailboxType: row.mailbox_type,
        enabledForMailSearch: row.enabled_for_mail_search === 1,
        enabledForAttachmentIngestion: row.enabled_for_attachment_ingestion === 1,
        sensitivity: row.sensitivity,
        status: row.status,
        lastCheckpoint: row.last_checkpoint,
        lastSuccessfulSync: row.last_successful_sync,
        graphAccessible: row.graph_accessible,
        lastError: row.last_error,
      })),
      notes: [
        "EL mailbox attachment ingestion default is INCLUDE. William and Ella are explicit exclusions.",
        "Lauren and future EL users inherit INCLUDE automatically. Shared mailboxes stay included.",
        "Portal chat search of personal work inboxes stays off (RBAC unchanged).",
        "Email bodies are not auto-vectorised. OneDrive catalogue is still the Sharon snapshot unless owner metadata says otherwise.",
      ],
    },
    allowlistedMailboxes: [...ELVEX_INFO_MAILBOXES, ...ELVEX_FINANCE_MAILBOXES],
    auditedMailboxes: ingest.mailboxes.map((row) => row.mailboxAddress),
    ingest,
    retrievalProof,
  };

  if (input?.sendCorrectedEmail) {
    payload.correctedEmail = await sendElKnowledgeCorrectedTestEmail(env, {
      report,
      windowFrom,
      windowTo,
      outlook,
      ingest,
    });
  }

  return payload;
}

export async function sendElKnowledgeCorrectedTestEmail(
  env: Env,
  input: {
    report: Awaited<ReturnType<typeof queryKnowledgeIngestionActivity>>;
    windowFrom: Date;
    windowTo: Date;
    outlook: Record<string, unknown>;
    ingest?: Awaited<ReturnType<typeof ingestApprovedOutlookAttachments>>;
  },
): Promise<Record<string, unknown>> {
  const existing = await env.DB.prepare(
    `SELECT id, status FROM email_outbox
     WHERE company_id = ? AND subject = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(COMPANY_ID, EL_KNOWLEDGE_CORRECTED_SUBJECT)
    .first<{ id: string; status: string }>();
  if (existing?.id && (existing.status === "sent" || existing.status === "sending")) {
    return { sent: false, skipped: true, reason: "already_sent", emailId: existing.id };
  }

  const company = await getCompanyById(env.DB, COMPANY_ID);
  const automation = await getAutomationDefinition(env.DB, COMPANY_ID, AUTOMATION_ID);
  const recipient = automationRecipientEmailOf(automation?.configuration ?? null);
  if (!company || !recipient || !isValidRecipientEmail(recipient)) {
    return { sent: false, skipped: false, reason: "recipient_unavailable" };
  }

  const listed = capKnowledgeList(input.report.documents);
  const failures = input.report.documents.filter((item) => item.outcome === "failed");
  const windowFromLabel = formatWindowLabel(input.windowFrom.toISOString());
  const windowToLabel = formatWindowLabel(input.windowTo.toISOString());
  const outlookMessages = Number(input.ingest?.counts.messagesWithAttachments ?? input.outlook.messagesWithAttachments ?? 0);
  const legitimateSkips = input.report.documents.filter(
    (item) => item.outcome === "skipped" || item.outcome === "duplicate",
  ).length;
  const pipelineHealth = classifyKnowledgePipelineHealth({
    jobOk: true,
    discoveredCount: input.report.discoveredCount,
    indexedCount: input.report.indexedCount,
    failedCount: input.report.failedCount,
    skippedCount: input.report.duplicateCount,
    legitimateSkipCount: legitimateSkips,
  });
  const gapWarning = knowledgeIngestionGapWarning({
    discoveredCount: input.report.discoveredCount,
    indexedCount: input.report.indexedCount,
    failedCount: input.report.failedCount,
    legitimateSkipCount: legitimateSkips,
  });
  const mailboxesScanned =
    input.ingest?.mailboxes.map((row) => String(row.mailboxAddress ?? "")).filter(Boolean) ??
    [...ELVEX_INFO_MAILBOXES, ...ELVEX_FINANCE_MAILBOXES];
  const email = renderKnowledgeIngestionReportEmail({
    companyDisplayName: company.name,
    reportDateLabel: "4 September 2026",
    windowFromLabel,
    windowToLabel,
    manual: true,
    discoveredCount: input.report.discoveredCount,
    indexedCount: input.report.indexedCount,
    chunkTotal: input.report.chunkTotal,
    duplicateCount: input.report.duplicateCount,
    failedCount: input.report.failedCount,
    updatedCount: input.report.updatedCount,
    sourceObservedCount: input.report.sourceObservedCount,
    missedCount: input.report.missedCount,
    sourceCounts: input.report.sourceCounts.map((row) => ({ label: row.label, count: row.count })),
    documents: listed.items.map((item) => ({
      title: item.title,
      sourceLabel: item.sourceLabel,
      indexed: item.indexed,
      stored: item.stored,
      chunkCount: item.chunkCount,
      modifiedAt: item.modifiedAt,
      url: item.url,
      location: item.location,
      mailbox: item.mailbox,
      parentSubject: item.parentSubject,
      sender: item.sender,
      failureReason: item.failureReason,
    })),
    failures: failures.map((item) => ({
      title: item.title,
      sourceLabel: item.sourceLabel,
      indexed: item.indexed,
      chunkCount: item.chunkCount,
      modifiedAt: item.modifiedAt,
      url: item.url,
      location: item.location,
      mailbox: item.mailbox,
      parentSubject: item.parentSubject,
      sender: item.sender,
      failureReason: item.failureReason,
    })),
    omittedDocuments: listed.omitted,
    portalUrl: `${portalOrigin(env)}/portal/${company.slug}/automations`,
    subjectOverride: EL_KNOWLEDGE_CORRECTED_SUBJECT,
    correctionPreamble: `Store-first landing zone is now on the shared INFRA pipeline. Originals are saved before index. One attachment remains one document. Graph landing-zone writes stay blocked if the tenant service principal is missing; originals are still retained via the durable knowledge-store fallback. Portal chat still cannot search personal inboxes. Mailboxes scanned: ${mailboxesScanned.join(", ")}. Messages with attachments: ${outlookMessages}. Stored: ${input.ingest?.counts.attachmentsStored ?? 0}. Indexed this run: ${input.ingest?.counts.attachmentsIndexed ?? input.report.indexedCount}. Deduped: ${input.ingest?.counts.duplicates ?? 0}. Failed: ${input.ingest?.counts.failed ?? input.report.failedCount}.`,
    mailboxesScanned,
    messagesWithAttachments: outlookMessages,
    attachmentsDiscovered: input.ingest?.counts.attachmentsDiscovered ?? input.report.discoveredCount,
    attachmentsStored: input.ingest?.counts.attachmentsStored ?? 0,
    attachmentsIndexed: input.ingest?.counts.attachmentsIndexed ?? input.report.indexedCount,
    attachmentsDeduped: input.ingest?.counts.duplicates ?? 0,
    attachmentsSkipped: input.ingest?.counts.skipped ?? input.report.duplicateCount,
    attachmentsSkippedJunk: input.ingest?.counts.skippedJunk ?? 0,
    attachmentsUnsupported: input.ingest?.counts.unsupported ?? 0,
    attachmentsFailed: input.ingest?.counts.failed ?? input.report.failedCount,
    pipelineHealth,
    gapWarning,
  });

  const delivery = await sendTransactionalEmail(env, env.DB, {
    companyId: COMPANY_ID,
    type: "DOCUMENT_ACTIVITY_REPORT",
    recipient,
    subject: EL_KNOWLEDGE_CORRECTED_SUBJECT,
    bodyText: email.text,
    bodyHtml: email.html,
    actor: "system:el-knowledge-ingestion-audit",
  });

  return {
    sent: delivery.sent,
    skipped: false,
    emailId: delivery.id,
    recipient,
    subject: EL_KNOWLEDGE_CORRECTED_SUBJECT,
    error: delivery.error ?? null,
  };
}

function formatWindowLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = zonedCivilParts(date, TIMEZONE);
  const day = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${formatCivilDateLong(day)} ${time} ${TIMEZONE}`;
}

async function auditOutlookMailboxes(
  env: Env,
  windowFrom: Date,
  windowTo: Date,
  persist: boolean,
  actor: string,
) {
  const mailboxes = [];
  let messagesWithAttachments = 0;
  let attachments = 0;
  let knowledgeSuitable = 0;
  let unresolvedParts = 0;
  let indexed = 0;
  for (const mailboxAddress of MAILBOXES) {
    const listed = await executeOutlookReadTool(env, {
      companyId: COMPANY_ID,
      toolName: "outlook_list_messages",
      arguments: { mailboxAddress, limit: 50 },
      actor,
    });
    const rows = listed.ok ? extractMessages(listed.result) : [];
    const inWindow = rows.filter((row) => timestampInWindow(messageTime(row), windowFrom, windowTo));
    const withAtt = inWindow.filter((row) => Boolean(row.hasAttachments));
    const attachmentDetails: Array<Record<string, unknown>> = [];
    for (const message of withAtt) {
      const got = await executeOutlookReadTool(env, {
        companyId: COMPANY_ID,
        toolName: "outlook_get_message",
        arguments: { mailboxAddress, messageId: asText(message.id) },
        actor,
      });
      const listedAttachmentsTool = await executeOutlookReadTool(env, {
        companyId: COMPANY_ID,
        toolName: "outlook_list_attachments",
        arguments: { mailboxAddress, messageId: asText(message.id) },
        actor,
      });
      const detail = got.ok ? asRecord(got.result) : null;
      const fromGet = extractAttachments(detail ?? message);
      const fromList =
        listedAttachmentsTool.ok && asRecord(listedAttachmentsTool.result)
          ? extractAttachments(asRecord(listedAttachmentsTool.result)!)
          : [];
      const listedAttachments = fromList.length ? fromList : fromGet;
      const suitable = listedAttachments.filter(
        (item) =>
          !item.isInline &&
          isOutlookAttachmentRetrievable(asText(item.contentType) || null, asText(item.name) || asText(item.filename)),
      );
      const observedCount = listedAttachments.length || (message.hasAttachments ? 1 : 0);
      messagesWithAttachments += 1;
      attachments += observedCount;
      knowledgeSuitable += suitable.length;
      if (listedAttachments.length === 0 && message.hasAttachments) unresolvedParts += 1;
      const subject = asText(message.subject);
      if (persist && observedCount > 0) {
        await recordKnowledgeIngestionEvent(env.DB, {
          companyId: COMPANY_ID,
          sourceType: "outlook_attachments",
          eventType: "source_observed",
          providerItemId: asText(message.id),
          parentMessageId: asText(message.id),
          filename: suitable[0]
            ? asText(suitable[0].name) || asText(suitable[0].filename)
            : subject
              ? `Attachment on: ${subject}`
              : "Email attachment (name unavailable)",
          mailboxAddress,
          sourceModifiedAt: messageTime(message),
          skipReason:
            listedAttachmentsTool.ok === false
              ? "EL Outlook attachments are not auto-ingested; company MCP has no attachment list/fetch tool"
              : "EL Outlook attachments are not auto-ingested into company knowledge",
          failureCode: listedAttachmentsTool.ok ? null : asText(listedAttachmentsTool.code) || "OUTLOOK_MCP_ATTACHMENT_TOOL_MISSING",
          metadata: {
            subject,
            from: asText(message.from),
            hasAttachments: true,
            attachmentCount: listedAttachments.length,
            suitableCount: suitable.length,
            unresolvedParts: listedAttachments.length === 0 && Boolean(message.hasAttachments),
            via: "company_mcp",
            listAttachmentsCode: listedAttachmentsTool.ok ? null : listedAttachmentsTool.code,
          },
        });
      }
      attachmentDetails.push({
        messageId: asText(message.id),
        subject,
        from: asText(message.from),
        receivedDateTime: messageTime(message),
        hasAttachments: Boolean(message.hasAttachments),
        attachmentCount: listedAttachments.length,
        suitableCount: suitable.length,
        names: suitable.map((item) => asText(item.name) || asText(item.filename)).filter(Boolean),
        listAttachments:
          listedAttachmentsTool.ok === false
            ? { ok: false, code: listedAttachmentsTool.code }
            : { ok: true, count: fromList.length },
      });
    }
    mailboxes.push({
      mailboxAddress,
      ok: listed.ok,
      listedCount: rows.length,
      inWindow: inWindow.length,
      withAttachments: withAtt.length,
      attachments: attachmentDetails,
      error: listed.ok ? null : listed.message,
    });
  }
  const discovered = knowledgeSuitable + unresolvedParts;
  return {
    messagesWithAttachments,
    attachments,
    knowledgeSuitable,
    unresolvedParts,
    discovered,
    indexed,
    missed: Math.max(0, discovered - indexed),
    mailboxes,
  };
}

async function auditDriveCatalogue(
  env: Env,
  windowFrom: Date,
  windowTo: Date,
  persist: boolean,
  actor: string,
) {
  const listings = await Promise.all(
    (["onedrive", "sharepoint"] as const).map(async (source) => {
      const listed = await executeListDocuments(env, {
        companyId: COMPANY_ID,
        arguments: { source, sort: "recently_modified", limit: 20, include_descriptions: false },
        actor,
      });
      const docs = listed.ok ? listed.result.documents : [];
      const inWindow = docs.filter(
        (doc) =>
          timestampInWindow(doc.modifiedAt, windowFrom, windowTo) ||
          timestampInWindow(doc.createdAt, windowFrom, windowTo),
      );
      if (persist) {
        for (const doc of inWindow) {
          await recordKnowledgeIngestionEvent(env.DB, {
            companyId: COMPANY_ID,
            sourceType: source,
            eventType: "source_observed",
            providerItemId: doc.id,
            filename: doc.title,
            sourceModifiedAt: doc.modifiedAt,
            metadata: { url: doc.url, via: listed.ok ? listed.result.backend : [] },
          });
        }
      }
      return {
        source,
        ok: listed.ok,
        status: listed.ok ? listed.result.status : listed.code,
        total: docs.length,
        inWindow: inWindow.length,
        newestModified: docs[0]?.modifiedAt ?? null,
        titles: inWindow.map((doc) => doc.title),
      };
    }),
  );
  const onedrive = listings.find((row) => row.source === "onedrive");
  const sharepoint = listings.find((row) => row.source === "sharepoint");
  return {
    onedriveInWindow: onedrive?.inWindow ?? 0,
    onedriveDiscovered: onedrive?.inWindow ?? 0,
    onedriveIndexed: 0,
    onedriveMissed: onedrive?.inWindow ?? 0,
    onedriveNewestModified: onedrive?.newestModified ?? null,
    sharepointInWindow: sharepoint?.inWindow ?? 0,
    sharepointDiscovered: sharepoint?.inWindow ?? 0,
    sharepointIndexed: 0,
    sharepointMissed: sharepoint?.inWindow ?? 0,
    sharepointStatus: sharepoint?.status ?? "unknown",
    otherPersonalNote:
      "Megan Freeman OneDrive PO PDFs are fetchable on demand but are not in the Sharon OneDrive catalogue snapshot.",
    listings,
  };
}

async function auditMcpIndex(env: Env, windowFrom: Date, windowTo: Date, actor: string) {
  const mcp = (await listMcpEnvironments(env.DB, COMPANY_ID)).find((item) => item.enabled);
  if (!mcp) {
    return { ok: false, reason: "no_enabled_mcp" };
  }
  const sinceIso = sqlIso(windowFrom);
  const untilIso = sqlIso(windowTo);
  const sinceLite = sqlLite(windowFrom);
  const untilLite = sqlLite(windowTo);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mcp_tool_allowlist
      (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
  )
    .bind(newId("allow"), COMPANY_ID, mcp.id, ELVEX_QUERY_TOOL, now, now)
    .run();

  const runSql = async (sql: string) => {
    const execution = await executeRegisteredMcpTool(env, {
      mcpId: mcp.id,
      toolName: ELVEX_QUERY_TOOL,
      arguments: { sql, limit: 50 },
      actorUserId: "system",
      actorEmail: actor,
      sourceClient: "el-knowledge-ingestion-audit",
      skipUsageRecording: true,
    });
    if (execution.status !== 200) return [];
    return rowsFromQueryPayload("data" in execution ? execution.data?.result : execution);
  };

  const [counts, newest, sharepoint, sync, owners] = await Promise.all([
    runSql(
      `SELECT source_type, COUNT(*) AS total,
        SUM(CASE WHEN (
          (modified_at >= '${sinceIso}' AND modified_at <= '${untilIso}')
          OR (created_at >= '${sinceLite}' AND created_at <= '${untilLite}')
        ) THEN 1 ELSE 0 END) AS in_window
       FROM microsoft_index_items GROUP BY source_type`,
    ),
    runSql(`SELECT filename, source_type, modified_at, created_at, status FROM microsoft_index_items ORDER BY modified_at DESC LIMIT 3`),
    runSql(`SELECT COUNT(*) AS total FROM microsoft_index_items WHERE source_type = 'sharepoint'`),
    runSql(
      `SELECT drive_id, source_type, item_count, last_synced_at,
        CASE WHEN delta_link IS NULL OR length(delta_link) = 0 THEN 0 ELSE 1 END AS has_delta
       FROM microsoft_sync_state LIMIT 20`,
    ),
    runSql(
      `SELECT owner_upn, COUNT(*) AS total,
        SUM(CASE WHEN (
          (modified_at >= '${sinceIso}' AND modified_at <= '${untilIso}')
          OR (created_at >= '${sinceLite}' AND created_at <= '${untilLite}')
        ) THEN 1 ELSE 0 END) AS in_window
       FROM microsoft_index_items
       WHERE lower(ifnull(owner_upn,'')) LIKE '%michael%'
          OR lower(ifnull(owner_upn,'')) LIKE '%sharon%'
          OR lower(ifnull(path,'')) LIKE '%michael%'
          OR lower(ifnull(path,'')) LIKE '%sharon%'
       GROUP BY owner_upn LIMIT 20`,
    ),
  ]);

  const onedrive = counts.find((row) => asText(row.source_type) === "onedrive");
  const sharepointCount = counts.find((row) => asText(row.source_type) === "sharepoint");
  return {
    ok: true,
    onedriveTotal: Number(onedrive?.total ?? 0),
    onedriveInWindow: Number(onedrive?.in_window ?? 0),
    sharepointTotal: Number(sharepointCount?.total ?? sharepoint[0]?.total ?? 0),
    sharepointInWindow: Number(sharepointCount?.in_window ?? 0),
    newest: newest.map((row) => ({
      filename: asText(row.filename),
      sourceType: asText(row.source_type),
      modifiedAt: asText(row.modified_at),
      createdAt: asText(row.created_at),
      status: asText(row.status),
    })),
    syncState: sync.map((row) => ({
      driveId: asText(row.drive_id).slice(0, 24),
      sourceType: asText(row.source_type),
      itemCount: Number(row.item_count ?? 0),
      lastSyncedAt: asText(row.last_synced_at),
      hasDelta: Number(row.has_delta ?? 0) === 1,
    })),
    staffOwners: owners.map((row) => ({
      owner: asText(row.owner_upn),
      total: Number(row.total ?? 0),
      inWindow: Number(row.in_window ?? 0),
    })),
  };
}

async function proveAttachmentKnowledgeRetrieval(
  env: Env,
  ingest: Awaited<ReturnType<typeof ingestApprovedOutlookAttachments>>,
  actor: string,
): Promise<Record<string, unknown>> {
  const mcp = (await listMcpEnvironments(env.DB, COMPANY_ID)).find((item) => item.enabled);
  if (!mcp) return { ok: false, reason: "no_enabled_mcp" };
  const queries = [
    "Anthropic receipt 2275-0489-5290",
    "Quote request 19 Lewis Street Pentre",
  ];
  const proofs = [];
  for (const query of queries) {
    const search = await executeRegisteredMcpTool(env, {
      mcpId: mcp.id,
      toolName: "search_company_knowledge",
      arguments: { query },
      actorUserId: "system",
      actorEmail: actor,
      sourceClient: "el-outlook-attachment-ingest",
      skipUsageRecording: true,
    });
    const hits = toStandardSearchPayload("data" in search ? search.data?.result : search).results;
    proofs.push({
      query,
      hitCount: hits.length,
      top: hits.slice(0, 3).map((hit) => ({
        id: hit.id ?? null,
        title: hit.title,
        snippetChars: String(hit.snippet ?? "").length,
        hasSnippet: Boolean(hit.snippet && String(hit.snippet).trim()),
      })),
      retrieved: hits.some((hit) => Boolean(hit.snippet && String(hit.snippet).trim())),
    });
  }
  return {
    ok: true,
    indexedCount: ingest.counts.attachmentsIndexed,
    chunkCount: ingest.counts.chunksAdded,
    proofs,
    vectorRetrieval: proofs.some((row) => row.retrieved),
  };
}

function extractMessages(result: unknown): Array<Record<string, unknown>> {
  const record = asRecord(result);
  const rows = record && Array.isArray(record.messages) ? record.messages : [];
  return rows.map((row) => asRecord(row)).filter((row): row is Record<string, unknown> => Boolean(row));
}

function extractAttachments(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [result.attachments, result.attachmentList, asRecord(result.message)?.attachments];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((row) => asRecord(row)).filter((row): row is Record<string, unknown> => Boolean(row));
    }
  }
  return [];
}
