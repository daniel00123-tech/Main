/**
 * Daily Microsoft sync / knowledge-ingestion email.
 * Same automation identity and 08:00 Europe/London schedule.
 */

import {
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  buildMicrosoftSyncReportEmailData,
  capKnowledgeList,
  formatCivilDateLong,
  isManualAutomationRunTrigger,
  isValidRecipientEmail,
  renderKnowledgeIngestionReportEmail,
  resolveKnowledgeIngestionWindow,
  zonedCivilParts,
  type MicrosoftSyncDriveCheck,
  type MicrosoftSyncMailboxCheck,
} from "@infra/shared";
import type { Env } from "../../../env";
import { getCompanyById } from "../../control-plane";
import { sendTransactionalEmail } from "../../email/send-transactional";
import { portalOrigin } from "../../public-urls";
import { recordUsageEvent } from "../../usage";
import { queryKnowledgeIngestionActivity } from "../knowledge-ingestion-query";
import { getAutomationRun, listAutomationRuns } from "../store";
import {
  listApprovedAttachmentMailboxes,
  listCompanyMailboxRegistry,
  listExcludedAttachmentMailboxes,
} from "../../mailbox-registry";
import { mailboxScanHealth } from "../../mailbox-scan-status";
import { ingestApprovedOutlookAttachments } from "../../outlook-attachment-ingest";
import { listMicrosoftSources } from "../../microsoft-sync";
import { AutomationActionError } from "./errors";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

async function collectMailboxChecks(
  db: D1Database | undefined,
  companyId: string,
  ingest: Awaited<ReturnType<typeof ingestApprovedOutlookAttachments>> | null,
): Promise<MicrosoftSyncMailboxCheck[]> {
  if (!db) return [];
  try {
    const [approved, excluded, registry] = await Promise.all([
      listApprovedAttachmentMailboxes(db, companyId),
      listExcludedAttachmentMailboxes(db, companyId),
      listCompanyMailboxRegistry(db, companyId),
    ]);
    const ingestByAddress = new Map<string, Record<string, unknown>>();
    for (const row of ingest?.mailboxes ?? []) {
      const address = typeof row.mailboxAddress === "string" ? row.mailboxAddress.toLowerCase() : "";
      if (address) ingestByAddress.set(address, row);
    }
    const seen = new Set<string>();
    const rows = [...approved, ...excluded, ...registry];
    const checks: MicrosoftSyncMailboxCheck[] = [];
    for (const row of rows) {
      const address = row.mailbox_address.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      const ingestRow = ingestByAddress.get(address);
      const excludedRow = row.enabled_for_attachment_ingestion !== 1;
      const ingestFailed = ingestRow?.scanStatus === "FAILED" || (Boolean(ingestRow?.scanFailed) && ingestRow?.scanStatus !== "DEGRADED" && ingestRow?.scanStatus !== "HEALTHY");
      const registryFailed = row.status === "error" && !String(row.last_error ?? "").startsWith("DEGRADED");
      const health = mailboxScanHealth({
        excluded: excludedRow,
        scanned: Boolean(ingestRow) || Boolean(row.last_attachment_scan_at),
        scanFailed: ingestFailed || (!ingestRow && registryFailed),
        lastScanAt: row.last_attachment_scan_at,
        graphFailed: row.graph_accessible === 0,
        failures: Number(ingestRow?.failed ?? 0),
        fetchFailed: Number(ingestRow?.failed ?? 0) > 0,
      });
      const failed = !excludedRow && (health === "FAILED" || health === "COVERAGE_GAP");
      const checked = !excludedRow && !failed && (Boolean(ingestRow) || Boolean(row.last_attachment_scan_at));
      const folders = Array.isArray(ingestRow?.folders)
        ? ingestRow!.folders
            .map((item) => {
              const folder = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
              const name = typeof folder?.name === "string" ? folder.name : "";
              if (!name) return null;
              return {
                name,
                checked: folder?.checked === true,
                failed: folder?.failed === true,
              };
            })
            .filter((item): item is { name: string; checked: boolean; failed: boolean } => Boolean(item))
        : [];
      checks.push({
        name: row.display_name || row.mailbox_address,
        address: row.mailbox_address,
        approved: !excludedRow,
        excluded: excludedRow,
        checked,
        failed: failed || folders.some((folder) => folder.failed),
        degraded: health === "DEGRADED",
        filesFound: ingestRow?.attachmentsDiscovered != null ? Number(ingestRow.attachmentsDiscovered) : Number(ingestRow?.failed ?? 0) + Number(ingestRow?.attachmentsIndexed ?? 0) || null,
        filesAdded: ingestRow?.attachmentsIndexed != null ? Number(ingestRow.attachmentsIndexed) : null,
        filesRetrying: Number(ingestRow?.failed ?? 0) || null,
        rawError: excludedRow ? null : row.last_error,
        folders,
      });
    }
    return checks;
  } catch {
    return [];
  }
}

async function collectDriveChecks(
  db: D1Database | undefined,
  companyId: string,
  documents: Array<{ sourceKey: string }>,
): Promise<{ onedrive: MicrosoftSyncDriveCheck; sharepoint: MicrosoftSyncDriveCheck }> {
  const empty = (failed: boolean): MicrosoftSyncDriveCheck => ({
    configured: true,
    checked: false,
    failed,
    newItemCount: null,
  });
  if (!db) return { onedrive: empty(true), sharepoint: empty(true) };
  try {
    const sources = await listMicrosoftSources(db, companyId);
    const summarise = (type: "onedrive" | "sharepoint"): MicrosoftSyncDriveCheck => {
      const rows = sources.filter(
        (row) => row.sourceType === type && row.inclusionStatus === "included",
      );
      const inWindow = documents.filter((doc) => doc.sourceKey === type).length;
      if (rows.length === 0) {
        return { configured: false, checked: false, failed: true, newItemCount: null };
      }
      const anyError = rows.some((row) => row.syncStatus === "error" || Boolean(row.lastError));
      const anySynced = rows.some((row) => Boolean(row.lastSyncAt) && row.syncStatus !== "error");
      if (anyError && !anySynced) {
        return { configured: true, checked: false, failed: true, newItemCount: null };
      }
      if (!anySynced) {
        return { configured: true, checked: false, failed: true, newItemCount: null };
      }
      return {
        configured: true,
        checked: true,
        failed: anyError,
        newItemCount: anyError ? null : inWindow,
      };
    };
    return { onedrive: summarise("onedrive"), sharepoint: summarise("sharepoint") };
  } catch {
    return { onedrive: empty(true), sharepoint: empty(true) };
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

  let ingest: Awaited<ReturnType<typeof ingestApprovedOutlookAttachments>> | null = null;
  try {
    ingest = await ingestApprovedOutlookAttachments(env, {
      companyId: ctx.companyId,
      windowFrom: window.from,
      windowTo: window.to,
      actor: `automation:${ctx.runId}:knowledge-intake`,
    });
  } catch {
    ingest = null;
  }

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
      readOnly: false,
      triggeredProviderScan: Boolean(ingest),
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
  const mailboxChecks = await collectMailboxChecks(env.DB, ctx.companyId, ingest);
  const drives = await collectDriveChecks(env.DB, ctx.companyId, report.documents);
  const portalUrl = `${portalOrigin(env)}/portal/${company.slug}/automations`;
  const emailData = buildMicrosoftSyncReportEmailData({
    companyDisplayName: company.name,
    reportDateLabel,
    windowFromLabel: formatWindowLabel(report.windowFrom, timeZone),
    windowToLabel: formatWindowLabel(report.windowTo, timeZone),
    manual,
    runId: ctx.runId,
    portalUrl,
    jobOk: true,
    documents: listed.items,
    mailboxChecks,
    onedrive: drives.onedrive,
    sharepoint: drives.sharepoint,
    chunkTotal: report.chunkTotal,
    omittedDocuments: listed.omitted,
  });
  const email = renderKnowledgeIngestionReportEmail(emailData);

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
    triggeredProviderScan: Boolean(ingest),
    microsoftSyncStatus: emailData.status,
    sourcesChecked: emailData.sourcesChecked,
    successfullyAdded: emailData.successfullyAdded,
    stillProcessing: emailData.stillProcessing,
    notSynchronised: emailData.notSynchronised,
    retriesQueued: emailData.retryCount,
    emailSent: false,
    customerSummary: "Microsoft sync report generated",
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
      customerSummary: "Microsoft sync report generated, email not sent",
    });
  }

  return {
    summary: manual ? "Microsoft sync report sent (manual test)" : "Microsoft sync report sent",
    result: {
      ...resultBase,
      emailSent: true,
      emailId: delivery.id,
      emailSubject: email.subject,
      customerSummary: manual
        ? "Microsoft sync report sent (manual test)"
        : "Microsoft sync report sent",
    },
  };
}
