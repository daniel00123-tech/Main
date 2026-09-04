import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const EL_MAILBOX_SCAN_REPAIR_SUBJECT =
  "INFRA — EL Mailbox Discovery & Attachment Ingestion Repair — Results";

export type MailboxScanRepairEmailData = {
  overall: string;
  sections: Array<{ key: string; title: string; body: string }>;
  portalUrl: string;
};

export function renderMailboxScanRepairEmail(data: MailboxScanRepairEmailData): {
  subject: string;
  text: string;
  html: string;
} {
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const text = [
    "INFRA",
    EL_MAILBOX_SCAN_REPAIR_SUBJECT,
    "",
    data.overall,
    "",
    ...data.sections.flatMap((section) => [section.title, section.body, ""]),
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  const sectionHtml = data.sections
    .map(
      (section) =>
        `<tr><td style="padding:8px 24px 4px;font-weight:600;color:#F5F9FF;">${escapeHtml(section.title)}</td></tr>
          <tr><td style="padding:0 24px 12px;color:#CBD5E1;font-size:13px;white-space:pre-wrap;">${escapeHtml(section.body)}</td></tr>`,
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
          <tr><td style="padding:0 24px 8px;color:#F5F9FF;font-size:20px;font-weight:700;">EL Mailbox Discovery & Attachment Ingestion Repair</td></tr>
          <tr><td style="padding:0 24px 16px;color:#CBD5E1;font-size:14px;">${escapeHtml(data.overall)}</td></tr>
          ${sectionHtml}
          <tr><td style="padding:8px 24px 16px;"><a href="${escapeHtml(data.portalUrl)}" style="display:inline-block;background:#2F80FF;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;">View Infra</a></td></tr>
          <tr><td style="padding:0 24px 24px;color:#94A3B8;font-size:12px;">${escapeHtml(footer)}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: EL_MAILBOX_SCAN_REPAIR_SUBJECT, text, html };
}
