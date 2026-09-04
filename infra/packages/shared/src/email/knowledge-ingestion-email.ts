import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type KnowledgeIngestionEmailLine = {
  title: string;
  sourceLabel: string;
  indexed: boolean;
  stored?: boolean;
  chunkCount: number | null;
  modifiedAt: string | null;
  url: string | null;
  location: string | null;
  mailbox: string | null;
  parentSubject: string | null;
  sender: string | null;
  failureReason: string | null;
};

export type KnowledgeIngestionReportTemplateData = {
  companyDisplayName: string;
  reportDateLabel: string;
  windowFromLabel: string;
  windowToLabel: string;
  manual: boolean;
  discoveredCount: number;
  indexedCount: number;
  chunkTotal: number | null;
  duplicateCount: number;
  failedCount: number;
  updatedCount?: number;
  sourceObservedCount?: number;
  missedCount?: number;
  sourceCounts: Array<{ label: string; count: number }>;
  documents: KnowledgeIngestionEmailLine[];
  failures: KnowledgeIngestionEmailLine[];
  omittedDocuments: number;
  portalUrl: string;
  subjectOverride?: string;
  correctionPreamble?: string;
  mailboxesEligible?: number;
  mailboxesExcluded?: number;
  mailboxesExcludedNames?: string[];
  mailboxesScanned?: string[];
  messagesScanned?: number;
  messagesWithAttachments?: number;
  attachmentsDiscovered?: number;
  attachmentsStored?: number;
  attachmentsIndexed?: number;
  attachmentsDeduped?: number;
  attachmentsSkipped?: number;
  attachmentsSkippedJunk?: number;
  attachmentsUnsupported?: number;
  attachmentsFailed?: number;
  onedriveIndexed?: number;
  sharepointIndexed?: number;
  pipelineHealth?: "healthy" | "degraded" | "failed";
  gapWarning?: string | null;
};

function formatKnowledgeLine(item: KnowledgeIngestionEmailLine, index: number): string[] {
  const lines = [
    `${index}. ${item.title}`,
    `   Source: ${item.sourceLabel}`,
    `   Stored: ${item.stored === false ? "No" : item.stored ? "Yes" : item.indexed ? "Yes" : "Unknown"}`,
    `   Indexed: ${item.indexed ? "Yes" : "No"}`,
  ];
  if (typeof item.chunkCount === "number") lines.push(`   Chunks: ${item.chunkCount}`);
  if (item.mailbox) lines.push(`   Mailbox: ${item.mailbox}`);
  if (item.parentSubject) lines.push(`   Email: ${item.parentSubject}`);
  if (item.sender) lines.push(`   Sender: ${item.sender}`);
  if (item.location) lines.push(`   Location: ${item.location}`);
  if (item.modifiedAt) lines.push(`   Modified: ${item.modifiedAt}`);
  if (item.url) lines.push(`   Link: ${item.url}`);
  if (item.failureReason) lines.push(`   Reason: ${item.failureReason}`);
  return lines;
}

export function renderKnowledgeIngestionReportEmail(data: KnowledgeIngestionReportTemplateData) {
  const title = `${data.companyDisplayName} — Daily Knowledge Activity`;
  const datePart = data.reportDateLabel;
  const subject =
    data.subjectOverride?.trim() ||
    (data.manual
      ? `INFRA — ${data.companyDisplayName} Daily Knowledge Activity — ${datePart} (manual test)`
      : `INFRA — ${data.companyDisplayName} Daily Knowledge Activity — ${datePart}`);
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const range = `Reporting period: ${data.windowFromLabel} → ${data.windowToLabel}`;
  const empty = data.discoveredCount === 0 && (data.sourceObservedCount ?? 0) === 0 && (data.missedCount ?? 0) === 0;
  const sourceLines = data.sourceCounts.map((row) => `${row.label}: ${row.count}`);
  const documentLines = data.documents.flatMap((item, index) => [...formatKnowledgeLine(item, index + 1), ""]);
  const failureLines = data.failures.map(
    (item) => `- ${item.title}${item.failureReason ? ` — ${item.failureReason}` : ""}`,
  );
  const health = data.pipelineHealth ?? "healthy";
  const mailboxLines = (data.mailboxesScanned ?? []).map((address) => `   - ${address}`);

  const text = [
    "INFRA",
    title,
    range,
    data.manual ? "This was a manual test run. The daily schedule is unchanged." : "",
    data.correctionPreamble ? data.correctionPreamble : "",
    "",
    empty
      ? `INFRA checked ${data.companyDisplayName} knowledge sources. No new documents were added to the knowledge base during this reporting period.`
      : [
          "SUMMARY",
          "",
          `New documents discovered: ${data.discoveredCount}`,
          `Successfully indexed: ${data.indexedCount}`,
          `Updated / re-indexed: ${data.updatedCount ?? 0}`,
          `Source activity not indexed: ${data.sourceObservedCount ?? data.missedCount ?? 0}`,
          `New vector chunks: ${data.chunkTotal == null ? "not recorded" : String(data.chunkTotal)}`,
          `Duplicates/skipped: ${data.duplicateCount}`,
          `Failed ingestion: ${data.failedCount}`,
          "",
          "MAILBOX SCAN",
          "",
          `MAILBOXES ELIGIBLE: ${data.mailboxesEligible ?? (data.mailboxesScanned ?? []).length}`,
          `MAILBOXES SCANNED: ${(data.mailboxesScanned ?? []).length}`,
          `MAILBOXES EXCLUDED: ${data.mailboxesExcluded ?? 0}`,
          ...mailboxLines,
          ...(data.mailboxesExcludedNames ?? []).map((name) => `   - ${name}: excluded by policy`),
          `MESSAGES SCANNED: ${data.messagesScanned ?? 0}`,
          `Email messages with attachments: ${data.messagesWithAttachments ?? 0}`,
          `Attachments discovered: ${data.attachmentsDiscovered ?? data.discoveredCount}`,
          `Attachments stored: ${data.attachmentsStored ?? 0}`,
          `Attachments indexed: ${data.attachmentsIndexed ?? data.indexedCount}`,
          `Attachments deduped: ${data.attachmentsDeduped ?? 0}`,
          `Attachments skipped: ${data.attachmentsSkipped ?? data.duplicateCount}`,
          `Attachments skipped (junk): ${data.attachmentsSkippedJunk ?? 0}`,
          `Attachments unsupported: ${data.attachmentsUnsupported ?? 0}`,
          `Attachments failed: ${data.attachmentsFailed ?? data.failedCount}`,
          `OneDrive files indexed: ${data.onedriveIndexed ?? 0}`,
          `SharePoint files indexed: ${data.sharepointIndexed ?? 0}`,
          "",
          ...(sourceLines.length ? ["BY SOURCE", "", ...sourceLines, ""] : []),
          ...(documentLines.length ? ["NEW KNOWLEDGE", "", ...documentLines] : []),
          ...(failureLines.length ? ["FAILED / NEEDS ATTENTION", "", ...failureLines, ""] : []),
        ].join("\n"),
    "",
    data.gapWarning ? data.gapWarning : "",
    `Job run: completed. Pipeline health: ${health}.`,
    "This run completed successfully.",
    "",
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  const summaryHtml = empty
    ? `<p style="margin:0 0 16px;color:#CBD5E1;">INFRA checked ${escapeHtml(data.companyDisplayName)} knowledge sources. No new documents were added to the knowledge base during this reporting period.</p>`
    : `<p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">New documents discovered</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.discoveredCount}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Successfully indexed</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.indexedCount}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Updated / re-indexed</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.updatedCount ?? 0}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Source activity not indexed</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.sourceObservedCount ?? data.missedCount ?? 0}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">New vector chunks</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.chunkTotal == null ? "Not recorded" : data.chunkTotal}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Duplicates/skipped</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.duplicateCount}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Failed ingestion</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.failedCount}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">MAILBOXES ELIGIBLE / SCANNED / EXCLUDED</p>
    <p style="margin:0 0 12px;font-size:16px;font-weight:600;color:#F5F9FF;">${data.mailboxesEligible ?? (data.mailboxesScanned ?? []).length} / ${(data.mailboxesScanned ?? []).length} / ${data.mailboxesExcluded ?? 0}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#CBD5E1;">${escapeHtml((data.mailboxesScanned ?? []).join(", ") || "none")}</p>
    ${
      (data.mailboxesExcludedNames ?? []).length
        ? `<p style="margin:0 0 12px;font-size:13px;color:#94A3B8;">${escapeHtml(
            (data.mailboxesExcludedNames ?? []).map((name) => `${name}: excluded by policy`).join("; "),
          )}</p>`
        : ""
    }
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">MESSAGES SCANNED</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.messagesScanned ?? 0}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Email messages with attachments</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.messagesWithAttachments ?? 0}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Attachments discovered / stored / indexed / deduped / skipped / failed</p>
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#F5F9FF;">${data.attachmentsDiscovered ?? data.discoveredCount} / ${data.attachmentsStored ?? 0} / ${data.attachmentsIndexed ?? data.indexedCount} / ${data.attachmentsDeduped ?? 0} / ${data.attachmentsSkipped ?? data.duplicateCount} / ${data.attachmentsFailed ?? data.failedCount}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Junk skipped / unsupported stored</p>
    <p style="margin:0 0 12px;font-size:16px;font-weight:600;color:#F5F9FF;">${data.attachmentsSkippedJunk ?? 0} / ${data.attachmentsUnsupported ?? 0}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">OneDrive / SharePoint indexed</p>
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#F5F9FF;">${data.onedriveIndexed ?? 0} / ${data.sharepointIndexed ?? 0}</p>`;

  const sourceHtml = data.sourceCounts
    .map(
      (row) =>
        `<p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">${escapeHtml(row.label)}</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${row.count}</p>`,
    )
    .join("\n    ");

  const documentHtml = data.documents
    .map((item, index) => {
      const meta = [
        `Source: ${escapeHtml(item.sourceLabel)}`,
        `Stored: ${item.stored === false ? "No" : item.stored ? "Yes" : item.indexed ? "Yes" : "Unknown"}`,
        `Indexed: ${item.indexed ? "Yes" : "No"}`,
        typeof item.chunkCount === "number" ? `Chunks: ${item.chunkCount}` : null,
        item.mailbox ? `Mailbox: ${escapeHtml(item.mailbox)}` : null,
        item.parentSubject ? `Email: ${escapeHtml(item.parentSubject)}` : null,
        item.modifiedAt ? `Modified: ${escapeHtml(item.modifiedAt)}` : null,
        item.url
          ? `Link: <a href="${escapeHtml(item.url)}" style="color:#93C5FD;">${escapeHtml(item.url)}</a>`
          : null,
      ]
        .filter(Boolean)
        .join("<br />");
      return `<p style="margin:0 0 14px;color:#CBD5E1;"><strong style="color:#F5F9FF;">${index + 1}. ${escapeHtml(item.title)}</strong><br />${meta}</p>`;
    })
    .join("");

  const failureHtml = data.failures
    .map(
      (item) =>
        `<p style="margin:0 0 8px;color:#FCA5A5;">${escapeHtml(item.title)}${item.failureReason ? ` — ${escapeHtml(item.failureReason)}` : ""}</p>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#07111F;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0B1627;border:1px solid #203047;border-radius:12px;">
          <tr><td style="padding:24px 24px 8px;color:#94A3B8;font-size:13px;letter-spacing:0.04em;">INFRA</td></tr>
          <tr><td style="padding:0 24px 8px;color:#CBD5E1;font-size:13px;">${escapeHtml(data.companyDisplayName)}</td></tr>
          <tr><td style="padding:0 24px 8px;color:#F5F9FF;font-size:22px;font-weight:700;">${escapeHtml(title)}</td></tr>
          <tr><td style="padding:0 24px 8px;color:#94A3B8;font-size:14px;">${escapeHtml(range)}</td></tr>
          ${data.manual ? `<tr><td style="padding:0 24px 16px;color:#93C5FD;font-size:13px;">Manual test run — the daily schedule is unchanged.</td></tr>` : ""}
          ${data.correctionPreamble ? `<tr><td style="padding:0 24px 16px;color:#CBD5E1;font-size:13px;">${escapeHtml(data.correctionPreamble)}</td></tr>` : ""}
          <tr><td style="padding:0 24px;">${summaryHtml}</td></tr>
          ${sourceHtml ? `<tr><td style="padding:0 24px 8px;font-weight:600;color:#F5F9FF;">By source</td></tr><tr><td style="padding:0 24px;">${sourceHtml}</td></tr>` : ""}
          ${documentHtml ? `<tr><td style="padding:0 24px 8px;font-weight:600;color:#F5F9FF;">New knowledge</td></tr><tr><td style="padding:0 24px;">${documentHtml}</td></tr>` : ""}
          ${
            data.omittedDocuments > 0
              ? `<tr><td style="padding:0 24px 12px;color:#94A3B8;">and ${data.omittedDocuments} more</td></tr>`
              : ""
          }
          ${failureHtml ? `<tr><td style="padding:0 24px 8px;font-weight:600;color:#F5F9FF;">Failed / needs attention</td></tr><tr><td style="padding:0 24px;">${failureHtml}</td></tr>` : ""}
          ${
            data.gapWarning
              ? `<tr><td style="padding:0 24px 12px;color:#FCA5A5;font-weight:600;">${escapeHtml(data.gapWarning)}</td></tr>`
              : ""
          }
          <tr><td style="padding:8px 24px 8px;color:#CBD5E1;font-size:13px;">Job run: completed. Pipeline health: ${escapeHtml(health)}.</td></tr>
          <tr><td style="padding:0 24px 16px;color:#94A3B8;font-size:13px;">This run completed successfully.</td></tr>
          <tr><td style="padding:0 24px 8px;"><a href="${escapeHtml(data.portalUrl)}" style="display:inline-block;background:#2F80FF;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;">View Infra</a></td></tr>
          <tr><td style="padding:20px 24px 24px;color:#94A3B8;font-size:12px;">${escapeHtml(footer)}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
