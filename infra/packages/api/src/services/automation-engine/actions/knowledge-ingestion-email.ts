/**
 * Daily knowledge-ingestion email — read-only INFRA/MCP records + transactional email.
 */

import {
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  capKnowledgeList,
  classifyKnowledgePipelineHealth,
  formatCivilDateLong,
  isManualAutomationRunTrigger,
  isValidRecipientEmail,
  knowledgeIngestionGapWarning,
  renderKnowledgeIngestionReportEmail,
  resolveKnowledgeIngestionWindow,
  zonedCivilParts,
} from "@infra/shared";
import type { Env } from "../../../env";
import { getCompanyById } from "../../control-plane";
import { sendTransactionalEmail } from "../../email/send-transactional";
import { portalOrigin } from "../../public-urls";
import { recordUsageEvent } from "../../usage";
import { queryKnowledgeIngestionActivity } from "../knowledge-ingestion-query";
import { getAutomationRun, listAutomationRuns } from "../store";
import { listApprovedAttachmentMailboxes, listExcludedAttachmentMailboxes } from "../../mailbox-registry";
import { AutomationActionError } from "./errors";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

async function mailboxPolicySnapshot(
  db: D1Database | undefined,
  companyId: string,
): Promise<{ eligible: number; excluded: number; excludedNames: string[] }> {
  if (!db) return { eligible: 0, excluded: 0, excludedNames: [] };
  try {
    const [eligible, excluded] = await Promise.all([
      listApprovedAttachmentMailboxes(db, companyId),
      listExcludedAttachmentMailboxes(db, companyId),
    ]);
    return {
      eligible: eligible.length,
      excluded: excluded.length,
      excludedNames: excluded
        .map((row) => row.display_name || row.mailbox_address)
        .filter((value): value is string => Boolean(value)),
    };
  } catch {
    return { eligible: 0, excluded: 0, excludedNames: [] };
  }
}

const STORE_FAILURE_MESSAGE = "We couldn't retrieve knowledge ingestion activity.";
const EMAIL_FAILURE_MESSAGE = "We couldn't send the knowledge activity email.";

function formatWindowLabel(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = zonedCivilParts(date, timeZone);
  const day = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${formatCivilDateLong(day)} ${time} ${timeZone}`;
}

export async function executeKnowledgeIngestionDailyEmail(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  const recipient = automationRecipientEmailOf(ctx.automation.configuration);
  if (!recipient || !isValidRecipientEmail(recipient)) {
    throw new AutomationActionError(
      "A valid recipient email is required.",
      false,
      "RECIPIENT_REQUIRED",
    );
  }

  const company = await getCompanyById(env.DB, ctx.companyId);
  if (!company) {
    throw new AutomationActionError("Company not found", false, "COMPANY_NOT_FOUND");
  }

  const current = await getAutomationRun(env.DB, ctx.companyId, ctx.runId);
  const triggerType = current?.triggerType ?? "schedule";
  const manual = isManualAutomationRunTrigger(triggerType);
  const priorRuns = await listAutomationRuns(env.DB, ctx.companyId, ctx.automation.id, 50);
  const lastSuccessful = priorRuns.find((run) => {
    if (run.id === ctx.runId) return false;
    if (run.status !== "completed") return false;
    const result = run.result ?? {};
    return result.emailSent === true && result.companyId === ctx.companyId;
  });
  const now = new Date();
  const window = resolveKnowledgeIngestionWindow(now, {
    windowTo: typeof lastSuccessful?.result?.windowTo === "string" ? lastSuccessful.result.windowTo : null,
    completedAt: lastSuccessful?.completedAt ?? null,
  });

  let report;
  try {
    report = await queryKnowledgeIngestionActivity(env, {
      companyId: ctx.companyId,
      windowFrom: window.from,
      windowTo: window.to,
      initialLookback: window.initialLookback,
    });
  } catch {
    throw new AutomationActionError(STORE_FAILURE_MESSAGE, false, "DOCUMENT_STORE_UNAVAILABLE", {
      handler: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
      templateKey: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
      companyId: ctx.companyId,
      emailSent: false,
      customerSummary: "Couldn't retrieve knowledge activity",
    });
  }

  await recordUsageEvent(env.DB, {
    companyId: ctx.companyId,
    actorEmail: ctx.initiatedBy ?? "system:automation-engine",
    resourceType: "automation",
    resourceId: ctx.automation.id,
    action: "knowledge.ingestion.summary",
    toolName: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
    quantity: 1,
    unit: "request",
    success: true,
    sourceClient: "automation-engine",
    correlationId: `${ctx.runId}:knowledge`,
    requestId: `automation_knowledge_${ctx.runId}`,
    metadata: {
      readOnly: true,
      triggeredProviderScan: false,
      windowFrom: report.windowFrom,
      windowTo: report.windowTo,
      trigger: triggerType,
      discoveredCount: report.discoveredCount,
      indexedCount: report.indexedCount,
      failedCount: report.failedCount,
    },
  });

  const timeZone = ctx.automation.timezone || "Europe/London";
  const parts = zonedCivilParts(now, timeZone);
  const reportDateLabel = formatCivilDateLong(
    `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
  );
  const listed = capKnowledgeList(report.documents);
  const failures = report.documents.filter((item) => item.outcome === "failed");
  const outlookDocs = report.documents.filter((item) => item.sourceKey === "outlook_attachments");
  const legitimateSkips = report.documents.filter(
    (item) =>
      item.outcome === "skipped" ||
      item.outcome === "duplicate" ||
      item.failureReason === "UNSUPPORTED_TYPE" ||
      item.failureReason === "unsupported format",
  ).length;
  const pipelineHealth = classifyKnowledgePipelineHealth({
    jobOk: true,
    discoveredCount: report.discoveredCount,
    indexedCount: report.indexedCount,
    failedCount: report.failedCount,
    skippedCount: report.duplicateCount,
    legitimateSkipCount: legitimateSkips,
  });
  const gapWarning = knowledgeIngestionGapWarning({
    discoveredCount: report.discoveredCount,
    indexedCount: report.indexedCount,
    failedCount: report.failedCount,
    legitimateSkipCount: legitimateSkips,
  });
  const mailboxesScanned = [
    ...new Set(report.documents.map((item) => item.mailbox).filter((item): item is string => Boolean(item))),
  ];
  const mailboxPolicy = await mailboxPolicySnapshot(env.DB, ctx.companyId);
  const portalUrl = `${portalOrigin(env)}/portal/${company.slug}/automations`;
  const email = renderKnowledgeIngestionReportEmail({
    companyDisplayName: company.name,
    reportDateLabel,
    windowFromLabel: formatWindowLabel(report.windowFrom, timeZone),
    windowToLabel: formatWindowLabel(report.windowTo, timeZone),
    manual,
    discoveredCount: report.discoveredCount,
    indexedCount: report.indexedCount,
    chunkTotal: report.chunkTotal,
    duplicateCount: report.duplicateCount,
    failedCount: report.failedCount,
    updatedCount: report.updatedCount,
    sourceObservedCount: report.sourceObservedCount,
    missedCount: report.missedCount,
    sourceCounts: report.sourceCounts.map((row) => ({ label: row.label, count: row.count })),
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
    portalUrl,
    mailboxesEligible: mailboxPolicy.eligible,
    mailboxesExcluded: mailboxPolicy.excluded,
    mailboxesExcludedNames: mailboxPolicy.excludedNames,
    mailboxesScanned,
    messagesScanned: 0,
    messagesWithAttachments: report.documents.filter((item) => item.sourceKey === "outlook_attachments").length,
    attachmentsDiscovered: outlookDocs.length,
    attachmentsStored: outlookDocs.filter((item) => item.stored).length,
    attachmentsIndexed: outlookDocs.filter((item) => item.indexed).length,
    attachmentsDeduped: outlookDocs.filter((item) => item.outcome === "duplicate").length,
    attachmentsSkipped: outlookDocs.filter((item) => item.outcome === "skipped" || item.outcome === "duplicate").length,
    attachmentsSkippedJunk: outlookDocs.filter((item) => item.outcome === "skipped" && !item.stored).length,
    attachmentsUnsupported: outlookDocs.filter(
      (item) => item.stored && (item.failureReason === "UNSUPPORTED_TYPE" || item.failureReason === "unsupported format"),
    ).length,
    attachmentsFailed: outlookDocs.filter((item) => item.outcome === "failed").length,
    onedriveIndexed: report.documents.filter((item) => item.sourceKey === "onedrive" && item.indexed).length,
    sharepointIndexed: report.documents.filter((item) => item.sourceKey === "sharepoint" && item.indexed).length,
    pipelineHealth,
    gapWarning,
  });

  const resultBase = {
    handler: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
    templateKey: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
    companyId: ctx.companyId,
    trigger: triggerType,
    manual,
    windowFrom: report.windowFrom,
    windowTo: report.windowTo,
    initialLookback: report.initialLookback,
    sourceCounts: report.sourceCounts,
    discoveredCount: report.discoveredCount,
    indexedCount: report.indexedCount,
    chunkTotal: report.chunkTotal,
    duplicateCount: report.duplicateCount,
    failedCount: report.failedCount,
    updatedCount: report.updatedCount,
    sourceObservedCount: report.sourceObservedCount,
    missedCount: report.missedCount,
    scannedSourceTypes: report.scannedSourceTypes,
    sourcesQueried: report.sourcesQueried,
    recipientEmail: recipient,
    triggeredProviderScan: false,
    emailSent: false,
    customerSummary: "Knowledge activity report generated",
  };

  const delivery = await sendTransactionalEmail(env, env.DB, {
    companyId: ctx.companyId,
    type: "DOCUMENT_ACTIVITY_REPORT",
    recipient,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
    actor: `automation:${ctx.runId}`,
  });

  if (!delivery.sent) {
    throw new AutomationActionError(EMAIL_FAILURE_MESSAGE, false, "EMAIL_DELIVERY_FAILED", {
      ...resultBase,
      emailId: delivery.id,
      emailError: delivery.error,
      customerSummary: "Knowledge activity report generated, email not sent",
    });
  }

  return {
    summary: manual ? "Knowledge activity report sent (manual test)" : "Knowledge activity report sent",
    result: {
      ...resultBase,
      emailSent: true,
      emailId: delivery.id,
      emailSubject: email.subject,
      customerSummary: manual
        ? "Knowledge activity report sent (manual test)"
        : "Knowledge activity report sent",
    },
  };
}
