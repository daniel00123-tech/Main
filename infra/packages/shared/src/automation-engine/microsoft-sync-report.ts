/**
 * Customer-facing Microsoft sync report: FOUND → STORED → INDEXED
 * and plain-English status. Internal codes stay out of the main email.
 */

import { formatCivilDateLong } from "./month-to-date";
import type {
  KnowledgeIngestionActivityKind,
  KnowledgeIngestionDocument,
  KnowledgeIngestionOutcome,
} from "./knowledge-ingestion";

export const KNOWLEDGE_RECONCILIATION_STAGES = ["FOUND", "STORED", "INDEXED"] as const;
export type KnowledgeReconciliationStage = (typeof KNOWLEDGE_RECONCILIATION_STAGES)[number];

export const MICROSOFT_SYNC_REPORT_STATUSES = ["HEALTHY", "NEEDS ATTENTION", "FAILED"] as const;
export type MicrosoftSyncReportStatus = (typeof MICROSOFT_SYNC_REPORT_STATUSES)[number];

export const FORBIDDEN_CUSTOMER_JARGON =
  /\bAADSTS\d+\b|\bATTACHMENT_ENUM_FAILED\b|\bMICROSOFT_TOKEN_DENIED\b|\bMCP_EMPTY_UNPROVEN\b|\bvector(?:ised|ized|s|isation|ization)?\b|\bD1\b|\bMCP\b|\b7000229\b/i;

export const FRIENDLY_INGESTION_REASONS = {
  downloadFailed: "INFRA found the attachment but could not download it.",
  sourceNotChecked: "Could not complete this source check.",
  unsupported: "This file type is not supported yet.",
  duplicate: "This file is already in INFRA knowledge.",
  retry: "A temporary problem occurred. INFRA will retry automatically.",
  stillProcessing: "Still processing.",
  indexFailed: "INFRA saved the file but could not add it to knowledge yet.",
  skipped: "This item was skipped.",
  generic: "INFRA could not finish synchronising this item.",
} as const;

export type MicrosoftSyncMailboxFolderCheck = {
  name: string;
  checked: boolean;
  failed: boolean;
};

export type MicrosoftSyncMailboxCheck = {
  name: string;
  address?: string | null;
  approved: boolean;
  excluded: boolean;
  checked: boolean;
  failed: boolean;
  rawError?: string | null;
  folders?: MicrosoftSyncMailboxFolderCheck[];
};

export type MicrosoftSyncDriveCheck = {
  configured: boolean;
  checked: boolean;
  failed: boolean;
  /** Null when the source was not successfully checked — never invent zero. */
  newItemCount: number | null;
};

export type MicrosoftSyncItemInput = {
  title: string;
  sourceLabel: string;
  sourceKey?: string | null;
  indexed: boolean;
  stored?: boolean;
  extracted?: boolean;
  outcome?: KnowledgeIngestionOutcome;
  failureReason?: string | null;
  modifiedAt?: string | null;
  discoveredAt?: string | null;
  mailbox?: string | null;
  parentSubject?: string | null;
  activityKind?: KnowledgeIngestionActivityKind;
  retryCount?: number | null;
  chunkCount?: number | null;
};

export type MicrosoftSyncLine = {
  filename: string;
  source: string;
  whenLabel: string | null;
  message: string;
};

export type MicrosoftSyncReportEmailData = {
  companyDisplayName: string;
  reportDateLabel: string;
  windowFromLabel: string;
  windowToLabel: string;
  manual: boolean;
  runId?: string | null;
  portalUrl: string;
  status: MicrosoftSyncReportStatus;
  sourcesChecked: number;
  sourcesAttempted: number;
  newItemsFound: number;
  successfullyAdded: number;
  stillProcessing: number;
  notSynchronised: number;
  successfullySynchronised: MicrosoftSyncLine[];
  foundNotSynchronised: MicrosoftSyncLine[];
  mailboxChecks: Array<{
    name: string;
    checked: boolean;
    excluded: boolean;
    line: string;
  }>;
  excludedNames: string[];
  onedriveLine: string;
  sharepointLine: string;
  onedriveFailed: boolean;
  sharepointFailed: boolean;
  knowledgeSummary: string;
  knowledgeDetail: string;
  needsAttention: string[];
  automaticActions: string;
  retryCount: number;
  omittedDocuments: number;
  subjectOverride?: string;
};

export function classifyReconciliationStage(input: {
  indexed?: boolean;
  stored?: boolean;
  extracted?: boolean;
  outcome?: KnowledgeIngestionOutcome | null;
}): KnowledgeReconciliationStage {
  if (input.indexed === true || input.outcome === "indexed") return "INDEXED";
  if (
    input.stored === true ||
    input.extracted === true ||
    input.outcome === "extracted"
  ) {
    return "STORED";
  }
  return "FOUND";
}

export function friendlyIngestionReason(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return FRIENDLY_INGESTION_REASONS.stillProcessing;
  const lower = text.toLowerCase();
  if (
    /aadsts|7000229|microsoft_token_denied|token.?denied|mcp_empty_unproven|graph_discover|source.?not.?checked|could not complete this source/i.test(
      text,
    )
  ) {
    return FRIENDLY_INGESTION_REASONS.sourceNotChecked;
  }
  if (
    /attachment_enum|could not (list|download|fetch)|bytes not available|enum_failed|download fail/i.test(
      text,
    )
  ) {
    return FRIENDLY_INGESTION_REASONS.downloadFailed;
  }
  if (/unsupported/.test(lower)) return FRIENDLY_INGESTION_REASONS.unsupported;
  if (/duplicate/.test(lower)) return FRIENDLY_INGESTION_REASONS.duplicate;
  if (/retry|temporary|failed_retryable|still processing/.test(lower)) {
    return /still processing/.test(lower)
      ? FRIENDLY_INGESTION_REASONS.stillProcessing
      : FRIENDLY_INGESTION_REASONS.retry;
  }
  if (/pending|discovered|extracted/.test(lower) && !/fail/.test(lower)) {
    return FRIENDLY_INGESTION_REASONS.stillProcessing;
  }
  if (/empty content|indexing failure|stored_not_indexed|index failed|extraction failed/.test(lower)) {
    return FRIENDLY_INGESTION_REASONS.indexFailed;
  }
  if (/skipped|excluded|protected|junk/.test(lower)) return FRIENDLY_INGESTION_REASONS.skipped;
  if (FORBIDDEN_CUSTOMER_JARGON.test(text)) return FRIENDLY_INGESTION_REASONS.sourceNotChecked;
  return FRIENDLY_INGESTION_REASONS.generic;
}

export function customerCopyContainsForbiddenJargon(text: string): boolean {
  return FORBIDDEN_CUSTOMER_JARGON.test(text);
}

export function classifyMicrosoftSyncStatus(input: {
  jobOk: boolean;
  mailboxChecks: MicrosoftSyncMailboxCheck[];
  onedrive: MicrosoftSyncDriveCheck;
  sharepoint: MicrosoftSyncDriveCheck;
  notSynchronisedFailed: number;
  stillProcessing: number;
}): MicrosoftSyncReportStatus {
  if (!input.jobOk) return "FAILED";
  const approved = input.mailboxChecks.filter((row) => row.approved && !row.excluded);
  const mailboxesFailed = approved.length > 0 && approved.every((row) => row.failed || !row.checked);
  const drivesFailed =
    (input.onedrive.failed || !input.onedrive.checked) &&
    (input.sharepoint.failed || !input.sharepoint.checked);
  if (mailboxesFailed && drivesFailed) return "FAILED";
  const anySourceGap =
    approved.some((row) => row.failed || !row.checked) ||
    input.onedrive.failed ||
    !input.onedrive.checked ||
    input.sharepoint.failed ||
    !input.sharepoint.checked;
  if (anySourceGap || input.notSynchronisedFailed > 0 || input.stillProcessing > 0) {
    return "NEEDS ATTENTION";
  }
  return "HEALTHY";
}

export function friendlySourceActivityLine(input: {
  label: string;
  check: MicrosoftSyncDriveCheck;
}): string {
  if (input.check.failed || !input.check.checked) {
    return `⚠️ ${input.label}: Could not complete this source check. INFRA will retry automatically.`;
  }
  if (input.check.newItemCount == null) {
    return `✅ ${input.label}: Checked.`;
  }
  if (input.check.newItemCount === 0) {
    return `✅ ${input.label}: Checked — no new files.`;
  }
  const noun = input.check.newItemCount === 1 ? "new file" : "new files";
  return `✅ ${input.label}: Checked — ${input.check.newItemCount} ${noun} found.`;
}

export function friendlyMailboxLine(input: MicrosoftSyncMailboxCheck): string {
  if (input.excluded) {
    return `${input.name}: Not included (by policy).`;
  }
  const folders = input.folders ?? [];
  if (folders.length > 0) {
    const ok = folders.filter((folder) => folder.checked && !folder.failed);
    const bad = folders.filter((folder) => folder.failed || !folder.checked);
    const lines: string[] = [];
    if (ok.length) {
      lines.push(`${input.name} — Checked:`);
      for (const folder of ok) lines.push(folder.name);
    }
    for (const folder of bad) {
      lines.push(
        `⚠️ ${input.name} — ${folder.name}: Could not be fully checked. ${FRIENDLY_INGESTION_REASONS.sourceNotChecked} INFRA will retry automatically.`,
      );
    }
    if (lines.length) return lines.join("\n");
  }
  if (input.checked && !input.failed) {
    return `✅ ${input.name}: Checked`;
  }
  return `⚠️ ${input.name}: Could not be fully checked. ${FRIENDLY_INGESTION_REASONS.sourceNotChecked} INFRA will retry automatically.`;
}

function whenLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  try {
    return formatCivilDateLong(day);
  } catch {
    return value;
  }
}

function itemKind(item: MicrosoftSyncItemInput):
  | "synced"
  | "duplicate"
  | "unsupported"
  | "download"
  | "retry"
  | "processing"
  | "failed" {
  const stage = classifyReconciliationStage(item);
  if (stage === "INDEXED") return "synced";
  const raw = `${item.failureReason ?? ""} ${item.outcome ?? ""}`;
  const lower = raw.toLowerCase();
  if (item.outcome === "duplicate" || /duplicate/.test(lower)) return "duplicate";
  if (/unsupported/.test(lower)) return "unsupported";
  if (/attachment_enum|could not (list|download|fetch)|bytes not available|enum_failed|download fail/i.test(raw)) {
    return "download";
  }
  if ((item.retryCount ?? 0) > 0 || /retry|failed_retryable|temporary/.test(lower)) return "retry";
  if (
    item.outcome === "discovered" ||
    item.outcome === "extracted" ||
    /pending|still processing/.test(lower)
  ) {
    return "processing";
  }
  if (item.outcome === "failed" || /fail|error/.test(lower)) return "failed";
  if (stage === "STORED") return "failed";
  return "processing";
}

function notSyncedMessage(kind: ReturnType<typeof itemKind>, item: MicrosoftSyncItemInput): string {
  if (kind === "download") return FRIENDLY_INGESTION_REASONS.downloadFailed;
  if (kind === "unsupported") return FRIENDLY_INGESTION_REASONS.unsupported;
  if (kind === "duplicate") return FRIENDLY_INGESTION_REASONS.duplicate;
  if (kind === "retry") return FRIENDLY_INGESTION_REASONS.retry;
  if (kind === "processing") return FRIENDLY_INGESTION_REASONS.stillProcessing;
  return friendlyIngestionReason(item.failureReason);
}

export function buildMicrosoftSyncReportEmailData(input: {
  companyDisplayName: string;
  reportDateLabel: string;
  windowFromLabel: string;
  windowToLabel: string;
  manual: boolean;
  runId?: string | null;
  portalUrl: string;
  jobOk?: boolean;
  documents: Array<MicrosoftSyncItemInput | KnowledgeIngestionDocument>;
  mailboxChecks: MicrosoftSyncMailboxCheck[];
  onedrive: MicrosoftSyncDriveCheck;
  sharepoint: MicrosoftSyncDriveCheck;
  chunkTotal?: number | null;
  omittedDocuments?: number;
  subjectOverride?: string;
}): MicrosoftSyncReportEmailData {
  const items = input.documents.map((doc) => ({
    title: doc.title,
    sourceLabel: doc.sourceLabel,
    sourceKey: "sourceKey" in doc ? doc.sourceKey : null,
    indexed: doc.indexed,
    stored: doc.stored,
    extracted: "extracted" in doc ? doc.extracted : undefined,
    outcome: doc.outcome,
    failureReason: doc.failureReason,
    modifiedAt: doc.modifiedAt,
    discoveredAt: "discoveredAt" in doc ? doc.discoveredAt : null,
    mailbox: doc.mailbox,
    parentSubject: doc.parentSubject,
    activityKind: doc.activityKind,
    retryCount: "retryCount" in doc ? doc.retryCount : null,
    chunkCount: doc.chunkCount,
  }));

  const successfullySynchronised: MicrosoftSyncLine[] = [];
  const foundNotSynchronised: MicrosoftSyncLine[] = [];
  let stillProcessing = 0;
  let notSynchronisedFailed = 0;
  let newCount = 0;
  let updatedCount = 0;
  let retryCount = 0;

  for (const item of items) {
    const kind = itemKind(item);
    const when = whenLabel(item.modifiedAt || item.discoveredAt);
    const filename = item.title || item.parentSubject || "Untitled item";
    retryCount += item.retryCount ?? 0;
    if (kind === "synced") {
      const updated = item.activityKind === "updated";
      if (updated) updatedCount += 1;
      else newCount += 1;
      successfullySynchronised.push({
        filename,
        source: item.sourceLabel,
        whenLabel: when,
        message: updated ? "Updated in INFRA knowledge" : "Added to INFRA knowledge",
      });
      continue;
    }
    if (kind === "processing" || kind === "retry") stillProcessing += 1;
    if (kind === "failed" || kind === "download") notSynchronisedFailed += 1;
    foundNotSynchronised.push({
      filename,
      source: item.sourceLabel,
      whenLabel: when,
      message: notSyncedMessage(kind, item),
    });
  }

  const approved = input.mailboxChecks.filter((row) => row.approved && !row.excluded);
  const mailboxLines = input.mailboxChecks.map((row) => ({
    name: row.name,
    checked: row.checked && !row.failed,
    excluded: row.excluded,
    line: friendlyMailboxLine(row),
  }));
  const excludedNames = input.mailboxChecks
    .filter((row) => row.excluded)
    .map((row) => row.name)
    .filter(Boolean);

  const onedriveLine = friendlySourceActivityLine({ label: "OneDrive", check: input.onedrive });
  const sharepointLine = friendlySourceActivityLine({ label: "SharePoint", check: input.sharepoint });

  const sourcesAttempted = approved.length + 2;
  const sourcesChecked =
    approved.filter((row) => row.checked && !row.failed).length +
    (input.onedrive.checked && !input.onedrive.failed ? 1 : 0) +
    (input.sharepoint.checked && !input.sharepoint.failed ? 1 : 0);

  const status = classifyMicrosoftSyncStatus({
    jobOk: input.jobOk !== false,
    mailboxChecks: input.mailboxChecks,
    onedrive: input.onedrive,
    sharepoint: input.sharepoint,
    notSynchronisedFailed,
    stillProcessing,
  });

  const knowledgeTotal = newCount + updatedCount;
  const knowledgeSummary = `INFRA knowledge now contains ${knowledgeTotal} new/updated document${
    knowledgeTotal === 1 ? "" : "s"
  } from this reporting period.`;
  const section =
    typeof input.chunkTotal === "number"
      ? ` Searchable sections added: ${input.chunkTotal}.`
      : "";
  const knowledgeDetail = `New: ${newCount}. Updated: ${updatedCount}.${section}`;

  const needsAttention: string[] = [];
  for (const row of approved) {
    if (row.failed || !row.checked) {
      needsAttention.push(`${row.name} could not be fully checked.`);
    }
  }
  if (input.onedrive.failed || !input.onedrive.checked) {
    needsAttention.push("OneDrive could not be fully checked.");
  }
  if (input.sharepoint.failed || !input.sharepoint.checked) {
    needsAttention.push("SharePoint could not be fully checked.");
  }
  for (const item of foundNotSynchronised) {
    if (
      item.message === FRIENDLY_INGESTION_REASONS.downloadFailed ||
      item.message === FRIENDLY_INGESTION_REASONS.indexFailed ||
      item.message === FRIENDLY_INGESTION_REASONS.generic ||
      item.message === FRIENDLY_INGESTION_REASONS.retry
    ) {
      needsAttention.push(`${item.filename} was found but not synchronised.`);
    }
  }

  const retriesQueued = stillProcessing + retryCount + needsAttention.filter((line) => /could not be fully checked/.test(line)).length;
  const automaticActions =
    retriesQueued > 0 || status !== "HEALTHY"
      ? "INFRA will automatically retry the items and sources that could not be completed."
      : "No action is required. INFRA will check again at the next scheduled time.";

  return {
    companyDisplayName: input.companyDisplayName,
    reportDateLabel: input.reportDateLabel,
    windowFromLabel: input.windowFromLabel,
    windowToLabel: input.windowToLabel,
    manual: input.manual,
    runId: input.runId ?? null,
    portalUrl: input.portalUrl,
    status,
    sourcesChecked,
    sourcesAttempted,
    newItemsFound: items.length,
    successfullyAdded: successfullySynchronised.length,
    stillProcessing,
    notSynchronised: foundNotSynchronised.length,
    successfullySynchronised,
    foundNotSynchronised,
    mailboxChecks: mailboxLines,
    excludedNames,
    onedriveLine,
    sharepointLine,
    onedriveFailed: input.onedrive.failed || !input.onedrive.checked,
    sharepointFailed: input.sharepoint.failed || !input.sharepoint.checked,
    knowledgeSummary,
    knowledgeDetail,
    needsAttention: status === "HEALTHY" ? [] : [...new Set(needsAttention)],
    automaticActions,
    retryCount: retriesQueued,
    omittedDocuments: input.omittedDocuments ?? 0,
    subjectOverride: input.subjectOverride,
  };
}

export function microsoftSyncReportSubject(data: Pick<
  MicrosoftSyncReportEmailData,
  "companyDisplayName" | "reportDateLabel" | "manual" | "subjectOverride"
>): string {
  if (data.subjectOverride?.trim()) return data.subjectOverride.trim();
  if (data.manual) return `INFRA — ${data.companyDisplayName} Microsoft Sync Report — Test`;
  return `INFRA — ${data.companyDisplayName} Microsoft Sync Report — ${data.reportDateLabel}`;
}
