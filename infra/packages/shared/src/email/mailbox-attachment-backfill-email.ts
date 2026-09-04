import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT =
  "INFRA — EL Business 7-Day Mailbox Attachment Backfill Results";

export type MailboxBackfillPersonLine = {
  name: string;
  mailboxAddress?: string | null;
  excluded?: boolean;
  messagesScanned?: number;
  attachments?: number;
  indexed?: number;
  failed?: number;
};

export type MailboxBackfillEmailData = {
  windowFromLabel: string;
  windowToLabel: string;
  windowFromIso: string;
  windowToIso: string;
  graphAuth: "PASS" | "FAIL";
  graphDetail: string;
  defaultPolicy: string;
  exclusions: string[];
  mailboxesDiscovered: number;
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
  duplicates: number;
  skipped: number;
  failed: number;
  retrievalProof: string;
  landingZone: string;
  remainingIssues: string[];
  people: MailboxBackfillPersonLine[];
  portalUrl: string;
};

export function renderMailboxAttachmentBackfillEmail(data: MailboxBackfillEmailData): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT;
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const personLines = data.people.flatMap((person) => {
    if (person.excluded) {
      return [`${person.name}`, "Excluded", ""];
    }
    return [
      person.name,
      `Messages scanned: ${person.messagesScanned ?? 0}`,
      `Attachments: ${person.attachments ?? 0}`,
      `Indexed: ${person.indexed ?? 0}`,
      `Failed: ${person.failed ?? 0}`,
      "",
    ];
  });
  const remaining = data.remainingIssues.length
    ? data.remainingIssues.map((item) => `- ${item}`)
    : ["- None recorded"];

  const text = [
    "INFRA",
    "EL Business — 7-day mailbox attachment backfill",
    "",
    `Backfill window: ${data.windowFromLabel} → ${data.windowToLabel}`,
    `Exact timestamps: ${data.windowFromIso} → ${data.windowToIso}`,
    `Graph auth: ${data.graphAuth}`,
    data.graphDetail,
    "",
    `Default mailbox ingestion policy: ${data.defaultPolicy}`,
    `Exclusions: ${data.exclusions.join(", ") || "none"}`,
    "",
    "SUMMARY",
    "",
    `Eligible mailboxes: ${data.mailboxesEligible}`,
    `Scanned mailboxes: ${data.mailboxesScanned}`,
    `Excluded mailboxes: ${data.mailboxesExcluded}`,
    `Total EL mailboxes discovered: ${data.mailboxesDiscovered}`,
    `Total messages scanned: ${data.messagesScanned}`,
    `Messages with attachments: ${data.messagesWithAttachments}`,
    `Attachments discovered: ${data.attachmentsDiscovered}`,
    `Fetched: ${data.attachmentsFetched}`,
    `Stored: ${data.attachmentsStored}`,
    `Extracted: ${data.attachmentsExtracted}`,
    `Indexed: ${data.attachmentsIndexed}`,
    `Chunks: ${data.chunksAdded}`,
    `Duplicates: ${data.duplicates}`,
    `Skipped: ${data.skipped}`,
    `Failures: ${data.failed}`,
    "",
    "RETRIEVAL PROOF",
    data.retrievalProof,
    "",
    `Landing zone: ${data.landingZone}`,
    "",
    "REMAINING ISSUES",
    ...remaining,
    "",
    "PER-MAILBOX",
    "",
    ...personLines,
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  const personHtml = data.people
    .map((person) => {
      if (person.excluded) {
        return `<p style="margin:0 0 12px;color:#CBD5E1;"><strong style="color:#F5F9FF;">${escapeHtml(person.name)}</strong><br />Excluded</p>`;
      }
      return `<p style="margin:0 0 12px;color:#CBD5E1;"><strong style="color:#F5F9FF;">${escapeHtml(person.name)}</strong><br />Messages scanned: ${person.messagesScanned ?? 0}<br />Attachments: ${person.attachments ?? 0}<br />Indexed: ${person.indexed ?? 0}<br />Failed: ${person.failed ?? 0}</p>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#07111F;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0B1627;border:1px solid #203047;border-radius:12px;">
          <tr><td style="padding:24px 24px 8px;color:#94A3B8;font-size:13px;letter-spacing:0.04em;">INFRA</td></tr>
          <tr><td style="padding:0 24px 8px;color:#F5F9FF;font-size:22px;font-weight:700;">EL Business 7-day mailbox attachment backfill</td></tr>
          <tr><td style="padding:0 24px 8px;color:#94A3B8;font-size:14px;">${escapeHtml(data.windowFromLabel)} → ${escapeHtml(data.windowToLabel)}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#CBD5E1;font-size:13px;">Graph auth: ${escapeHtml(data.graphAuth)}. Default policy: ${escapeHtml(data.defaultPolicy)}.</td></tr>
          <tr><td style="padding:0 24px 12px;color:#CBD5E1;font-size:14px;">Eligible ${data.mailboxesEligible} · Scanned ${data.mailboxesScanned} · Excluded ${data.mailboxesExcluded}</td></tr>
          <tr><td style="padding:0 24px 12px;color:#CBD5E1;font-size:14px;">Messages scanned ${data.messagesScanned} · With attachments ${data.messagesWithAttachments}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#F5F9FF;font-size:16px;font-weight:600;">Fetched ${data.attachmentsFetched} · Stored ${data.attachmentsStored} · Indexed ${data.attachmentsIndexed} · Failed ${data.failed}</td></tr>
          <tr><td style="padding:0 24px 12px;color:#CBD5E1;font-size:13px;">${escapeHtml(data.retrievalProof)}</td></tr>
          <tr><td style="padding:8px 24px 8px;font-weight:600;color:#F5F9FF;">Per-mailbox</td></tr>
          <tr><td style="padding:0 24px;">${personHtml}</td></tr>
          <tr><td style="padding:8px 24px 16px;"><a href="${escapeHtml(data.portalUrl)}" style="display:inline-block;background:#2F80FF;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;">View Infra</a></td></tr>
          <tr><td style="padding:0 24px 24px;color:#94A3B8;font-size:12px;">${escapeHtml(footer)}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
