import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";
import {
  microsoftSyncReportSubject,
  type MicrosoftSyncReportEmailData,
} from "../automation-engine/microsoft-sync-report";

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSyncLine(item: { filename: string; source: string; whenLabel: string | null; message: string }, mark: string): string {
  const when = item.whenLabel ? ` · ${item.whenLabel}` : "";
  return `${mark} ${item.filename} · ${item.source}${when} — ${item.message}`;
}

export function renderKnowledgeIngestionReportEmail(data: MicrosoftSyncReportEmailData) {
  const title = `${data.companyDisplayName} Microsoft Sync Report`;
  const subject = microsoftSyncReportSubject(data);
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const opening =
    `INFRA checked ${data.companyDisplayName} Microsoft 365 and knowledge sources this morning. Here is a simple summary of what was found and what successfully synchronised.`;
  const approvedMailboxes = data.mailboxChecks.filter((row) => !row.excluded);
  const excludedNote =
    data.excludedNames.length > 0
      ? `${data.excludedNames.join(" and ")} ${data.excludedNames.length === 1 ? "is" : "are"} not included, as requested.`
      : "";

  const s1 =
    data.successfullySynchronised.length === 0
      ? ["None in this reporting period."]
      : data.successfullySynchronised.map((item) => formatSyncLine(item, "✅"));
  const s2 =
    data.foundNotSynchronised.length === 0
      ? ["None."]
      : data.foundNotSynchronised.map((item) => formatSyncLine(item, "⚠️"));
  const s3 = [
    ...approvedMailboxes.map((row) => row.line),
    ...(excludedNote ? [excludedNote] : []),
  ];
  const s6 = data.needsAttention;
  const technical = [
    `Window: ${data.windowFromLabel} → ${data.windowToLabel}`,
    data.runId ? `Run: ${data.runId}` : null,
    `Sources checked: ${data.sourcesChecked} of ${data.sourcesAttempted} (Outlook mailboxes, OneDrive, SharePoint)`,
    `Retries queued: ${data.retryCount}`,
  ].filter((line): line is string => Boolean(line));

  const text = [
    "INFRA",
    title,
    subject,
    data.manual ? "This is a test run. The daily 08:00 Europe/London schedule is unchanged." : "",
    "",
    opening,
    "",
    "Microsoft Sync Status",
    data.status,
    `Sources checked: ${data.sourcesChecked}`,
    `New items found: ${data.newItemsFound}`,
    `Successfully added: ${data.successfullyAdded}`,
    `Still processing: ${data.stillProcessing}`,
    `Not synchronised: ${data.notSynchronised}`,
    "",
    "S1 Successfully synchronised",
    ...s1,
    "",
    "S2 Found but not synchronised",
    ...s2,
    "",
    "S3 Mailbox check",
    ...s3,
    "",
    "S4 OneDrive / SharePoint",
    data.onedriveLine,
    data.sharepointLine,
    "",
    "S5 Knowledge base",
    data.knowledgeSummary,
    data.knowledgeDetail,
    "",
    ...(s6.length
      ? ["S6 Needs attention", ...s6.map((line) => `⚠️ ${line}`), ""]
      : []),
    "S7 Automatic actions",
    data.automaticActions,
    data.omittedDocuments > 0 ? `and ${data.omittedDocuments} more items` : "",
    "",
    "Technical details",
    ...technical,
    "",
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  const statusColor =
    data.status === "HEALTHY" ? "#86EFAC" : data.status === "FAILED" ? "#FCA5A5" : "#FCD34D";

  const listHtml = (lines: string[]) =>
    lines.map((line) => `<p style="margin:0 0 8px;color:#CBD5E1;">${escapeHtml(line)}</p>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#07111F;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0B1627;border:1px solid #203047;border-radius:12px;">
          <tr><td style="padding:24px 24px 8px;color:#94A3B8;font-size:13px;letter-spacing:0.04em;">INFRA</td></tr>
          <tr><td style="padding:0 24px 8px;color:#F5F9FF;font-size:22px;font-weight:700;">${escapeHtml(title)}</td></tr>
          ${
            data.manual
              ? `<tr><td style="padding:0 24px 12px;color:#93C5FD;font-size:13px;">This is a test run. The daily 08:00 Europe/London schedule is unchanged.</td></tr>`
              : ""
          }
          <tr><td style="padding:0 24px 16px;color:#CBD5E1;font-size:14px;">${escapeHtml(opening)}</td></tr>
          <tr><td style="padding:0 24px 4px;color:#94A3B8;font-size:13px;">Microsoft Sync Status</td></tr>
          <tr><td style="padding:0 24px 12px;color:${statusColor};font-size:20px;font-weight:700;">${escapeHtml(data.status)}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#CBD5E1;font-size:14px;">
            Sources checked: ${data.sourcesChecked}<br />
            New items found: ${data.newItemsFound}<br />
            Successfully added: ${data.successfullyAdded}<br />
            Still processing: ${data.stillProcessing}<br />
            Not synchronised: ${data.notSynchronised}
          </td></tr>
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Successfully synchronised</td></tr>
          <tr><td style="padding:0 24px 12px;">${listHtml(s1)}</td></tr>
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Found but not synchronised</td></tr>
          <tr><td style="padding:0 24px 12px;">${listHtml(s2)}</td></tr>
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Mailbox check</td></tr>
          <tr><td style="padding:0 24px 12px;">${listHtml(s3)}</td></tr>
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">OneDrive / SharePoint</td></tr>
          <tr><td style="padding:0 24px 12px;">${listHtml([data.onedriveLine, data.sharepointLine])}</td></tr>
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Knowledge base</td></tr>
          <tr><td style="padding:0 24px 12px;color:#CBD5E1;">${escapeHtml(data.knowledgeSummary)}<br />${escapeHtml(data.knowledgeDetail)}</td></tr>
          ${
            s6.length
              ? `<tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Needs attention</td></tr>
          <tr><td style="padding:0 24px 12px;">${listHtml(s6.map((line) => `⚠️ ${line}`))}</td></tr>`
              : ""
          }
          <tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">Automatic actions</td></tr>
          <tr><td style="padding:0 24px 16px;color:#CBD5E1;">${escapeHtml(data.automaticActions)}</td></tr>
          <tr><td style="padding:0 24px 4px;color:#94A3B8;font-size:12px;">Technical details</td></tr>
          <tr><td style="padding:0 24px 16px;color:#94A3B8;font-size:12px;">${technical.map((line) => escapeHtml(line)).join("<br />")}</td></tr>
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
