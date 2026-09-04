/**
 * Forensic EL knowledge ingestion audit for a frozen reporting window.
 * Reads Graph/MCP source activity and INFRA/MCP index metadata. No secret output.
 */

import { ELVEX_INFO_MAILBOXES, timestampInWindow } from "@infra/shared";
import type { Env } from "../env";
import { queryKnowledgeIngestionActivity } from "./automation-engine/knowledge-ingestion-query";
import { executeListDocuments } from "./document-catalogue";
import { recordKnowledgeIngestionEvent } from "./knowledge-ingestion-events";
import { executeOutlookReadTool } from "./microsoft-outlook-read";
import { isOutlookAttachmentRetrievable } from "./microsoft-outlook-graph";

export const EL_KNOWLEDGE_AUDIT_WINDOW = {
  from: "2026-09-03T17:39:03.388Z",
  to: "2026-09-04T17:39:03.388Z",
} as const;

const COMPANY_ID = "co_el";
const MAILBOXES = ["info@elvexpropertyservices.com", "finance@elvexpropertyservices.com"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function messageTime(row: Record<string, unknown>): string | null {
  return asText(row.receivedDateTime) || asText(row.sentDateTime) || asText(row.date) || null;
}

export async function runElKnowledgeIngestionAudit(
  env: Env,
  input?: { windowFrom?: string; windowTo?: string; persistEvents?: boolean; actor?: string },
): Promise<Record<string, unknown>> {
  const windowFrom = new Date(input?.windowFrom ?? EL_KNOWLEDGE_AUDIT_WINDOW.from);
  const windowTo = new Date(input?.windowTo ?? EL_KNOWLEDGE_AUDIT_WINDOW.to);
  const persist = input?.persistEvents !== false;
  const actor = input?.actor ?? "system:el-knowledge-ingestion-audit";

  const outlook = await auditOutlookMailboxes(env, windowFrom, windowTo, persist, actor);
  const files = await auditDriveCatalogue(env, windowFrom, windowTo, persist, actor);
  const report = await queryKnowledgeIngestionActivity(env, {
    companyId: COMPANY_ID,
    windowFrom,
    windowTo,
  });

  const sourceCandidates =
    outlook.attachments + files.onedriveInWindow + files.sharepointInWindow;
  const discovered = report.discoveredCount;
  const indexed = report.indexedCount;
  const missed = Math.max(0, outlook.knowledgeSuitable - outlook.indexed) + files.onedriveMissed + files.sharepointMissed;

  return {
    companyId: COMPANY_ID,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    timezone: "Europe/London",
    outlook,
    onedrive: {
      createdOrModifiedInWindow: files.onedriveInWindow,
      discovered: files.onedriveDiscovered,
      indexedOrReindexed: files.onedriveIndexed,
      missed: files.onedriveMissed,
      newestIndexedModifiedAt: files.onedriveNewestModified,
    },
    sharepoint: {
      createdOrModifiedInWindow: files.sharepointInWindow,
      discovered: files.sharepointDiscovered,
      indexedOrReindexed: files.sharepointIndexed,
      missed: files.sharepointMissed,
      catalogueStatus: files.sharepointStatus,
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
    pipeline: {
      emailAttachmentAutoIngest: "NO",
      sharepointAutoIngest: files.sharepointStatus === "connected_empty" ? "PARTIAL" : "PARTIAL",
      onedriveAutoIngest: "PARTIAL",
      infraMicrosoftSourcesForEl: 0,
      elMcpVectorize: "not_provisioned",
      elMcpR2: "not_provisioned",
      notes: [
        "EL Outlook read uses company MCP. INFRA microsoft_connector_sources has no co_el rows, so the 6-hour INFRA ingest cron never runs for EL.",
        "EL OneDrive catalogue last source-modified row is 2026-08-18. Main drive last_synced_at 2026-08-30 with no delta_link.",
        "SharePoint drives have delta checkpoints but item_count 0 and no microsoft_index_items rows.",
        "Approved attachment types: pdf/docx/xlsx/txt/csv. Inline images and signatures are excluded.",
      ],
    },
    allowlistedMailboxes: [...ELVEX_INFO_MAILBOXES],
  };
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
      const detail = got.ok ? asRecord(got.result) : null;
      const listedAttachments = extractAttachments(detail ?? message);
      const suitable = listedAttachments.filter((item) =>
        isOutlookAttachmentRetrievable(asText(item.contentType) || null, asText(item.name) || asText(item.filename)),
      );
      messagesWithAttachments += 1;
      attachments += listedAttachments.length || (message.hasAttachments ? 1 : 0);
      knowledgeSuitable += suitable.length || (listedAttachments.length === 0 && message.hasAttachments ? 0 : 0);
      if (persist && (suitable.length > 0 || (message.hasAttachments && listedAttachments.length === 0))) {
        await recordKnowledgeIngestionEvent(env.DB, {
          companyId: COMPANY_ID,
          sourceType: "outlook_attachments",
          eventType: "source_observed",
          providerItemId: asText(message.id),
          parentMessageId: asText(message.id),
          filename: suitable[0] ? asText(suitable[0].name) || asText(suitable[0].filename) : null,
          mailboxAddress,
          sourceModifiedAt: messageTime(message),
          skipReason: "EL Outlook attachments are not auto-ingested into company knowledge",
          metadata: {
            subject: asText(message.subject),
            hasAttachments: true,
            attachmentCount: listedAttachments.length,
            suitableCount: suitable.length,
            via: "company_mcp",
          },
        });
      }
      attachmentDetails.push({
        messageId: asText(message.id),
        subject: asText(message.subject),
        from: asText(message.from),
        receivedDateTime: messageTime(message),
        hasAttachments: Boolean(message.hasAttachments),
        attachmentCount: listedAttachments.length,
        suitableCount: suitable.length,
        names: suitable.map((item) => asText(item.name) || asText(item.filename)).filter(Boolean),
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
  return {
    messagesWithAttachments,
    attachments,
    knowledgeSuitable,
    discovered: knowledgeSuitable,
    indexed,
    missed: Math.max(0, knowledgeSuitable - indexed),
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
