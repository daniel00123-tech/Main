import { PLATFORM_EMAIL_NO_REPLY_FOOTER } from "./identity";

export type PasswordResetTemplateData = {
  companyDisplayName: string;
  resetUrl: string;
  expiresLabel: string;
};

export type UserInvitationTemplateData = {
  companyDisplayName: string;
  setupUrl: string;
  expiresLabel: string;
};

export type TestEmailTemplateData = {
  companyDisplayName: string;
  sentAtLabel: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailShell(input: {
  companyDisplayName: string;
  title: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  footerNote?: string;
  subject?: string;
}): { subject: string; text: string; html: string } {
  const company = input.companyDisplayName.trim();
  const subject = input.subject ?? input.title;
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const text = [
    "Infra",
    "",
    input.title,
    "",
    input.bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    "",
    `${input.ctaLabel}: ${input.ctaUrl}`,
    "",
    input.footerNote ?? "",
    "",
    footer,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#07111F;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0B1627;border:1px solid #203047;border-radius:12px;">
          <tr>
            <td style="padding:24px 24px 8px;color:#94A3B8;font-size:13px;letter-spacing:0.04em;">INFRA</td>
          </tr>
          <tr>
            <td style="padding:0 24px 8px;color:#CBD5E1;font-size:13px;">${escapeHtml(company)}</td>
          </tr>
          <tr>
            <td style="padding:0 24px 16px;color:#F5F9FF;font-size:22px;font-weight:700;">${escapeHtml(input.title)}</td>
          </tr>
          <tr>
            <td style="padding:0 24px 8px;color:#CBD5E1;font-size:15px;line-height:1.5;">${input.bodyHtml}</td>
          </tr>
          <tr>
            <td style="padding:16px 24px 8px;">
              <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#2F80FF;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;">${escapeHtml(input.ctaLabel)}</a>
            </td>
          </tr>
          ${
            input.footerNote
              ? `<tr><td style="padding:8px 24px 0;color:#94A3B8;font-size:13px;">${escapeHtml(input.footerNote)}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:20px 24px 24px;color:#94A3B8;font-size:12px;">${escapeHtml(footer)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

export function renderPasswordResetEmail(data: PasswordResetTemplateData) {
  const company = data.companyDisplayName.trim();
  return emailShell({
    companyDisplayName: company,
    title: "Reset your Infra password",
    subject: `Reset your Infra password — ${company}`,
    bodyHtml: `<p style="margin:0 0 12px;color:#CBD5E1;">We received a request to reset the password for your Infra account at ${escapeHtml(company)}.</p>`,
    ctaLabel: "Reset password",
    ctaUrl: data.resetUrl,
    footerNote: `This link expires ${data.expiresLabel}. If you didn't request this, you can ignore this email.`,
  });
}

export function renderUserInvitationEmail(data: UserInvitationTemplateData) {
  const company = data.companyDisplayName.trim();
  return emailShell({
    companyDisplayName: company,
    title: `You've been invited to ${company}`,
    subject: `You've been invited to access ${company} in Infra`,
    bodyHtml: `<p style="margin:0 0 12px;color:#CBD5E1;">You have been invited to access ${escapeHtml(company)} in Infra.</p>`,
    ctaLabel: "Set up your account",
    ctaUrl: data.setupUrl,
    footerNote: `This invitation expires ${data.expiresLabel}.`,
  });
}

export function renderTestEmail(data: TestEmailTemplateData) {
  const company = data.companyDisplayName.trim();
  return emailShell({
    companyDisplayName: company,
    title: "Infra test email",
    subject: `Infra test email — ${company}`,
    bodyHtml: `<p style="margin:0 0 12px;color:#CBD5E1;">This is a safe test message from Infra transactional email (${escapeHtml(data.sentAtLabel)}).</p>`,
    ctaLabel: "Open Infra",
    ctaUrl: "https://app.infrastack.app",
    footerNote: "No action is required.",
  });
}

export type XeroSalesReportTemplateData = {
  companyDisplayName: string;
  fromDateLabel: string;
  toDateLabel: string;
  salesLabel: string;
  invoiceCount: number;
  asOfLabel: string;
  portalUrl: string;
};

export function renderXeroSalesReportEmail(data: XeroSalesReportTemplateData) {
  const title = "Month-to-date sales";
  const subject = `${data.companyDisplayName} — Month-to-date sales: ${data.salesLabel}`;
  const range = `${data.fromDateLabel} – ${data.toDateLabel}`;
  const invoiceLabel = data.invoiceCount === 1 ? "Sales invoice" : "Sales invoices";
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const text = [
    "Infra",
    data.companyDisplayName,
    "",
    title,
    "",
    range,
    "",
    `Sales`,
    data.salesLabel,
    "",
    invoiceLabel,
    String(data.invoiceCount),
    "",
    `As of ${data.asOfLabel}.`,
    "",
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ].join("\n");

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
          <tr><td style="padding:0 24px 16px;color:#94A3B8;font-size:14px;">${escapeHtml(range)}</td></tr>
          <tr><td style="padding:0 24px 4px;color:#94A3B8;font-size:13px;">Sales</td></tr>
          <tr><td style="padding:0 24px 16px;color:#F5F9FF;font-size:28px;font-weight:700;">${escapeHtml(data.salesLabel)}</td></tr>
          <tr><td style="padding:0 24px 4px;color:#94A3B8;font-size:13px;">${escapeHtml(invoiceLabel)}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#F5F9FF;font-size:20px;font-weight:600;">${escapeHtml(String(data.invoiceCount))}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#94A3B8;font-size:13px;">As of ${escapeHtml(data.asOfLabel)}.</td></tr>
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

export type DocumentActivityLine = {
  title: string;
  sourceLabel: string;
};

export type DocumentActivityReportTemplateData = {
  companyDisplayName: string;
  asOfLabel: string;
  sourceCounts: Array<{ label: string; count: number }>;
  totalCount: number;
  newDocuments: DocumentActivityLine[];
  updatedDocuments: DocumentActivityLine[];
  newCount: number;
  updatedCount: number;
  combinedActivity: boolean;
  omittedNew?: number;
  omittedUpdated?: number;
  portalUrl: string;
};

export function renderDocumentActivityReportEmail(data: DocumentActivityReportTemplateData) {
  const title = "Daily document update";
  const subject = `${data.companyDisplayName} — Daily document update`;
  const footer = PLATFORM_EMAIL_NO_REPLY_FOOTER;
  const sourceLines = data.sourceCounts.flatMap((row) => [row.label, String(row.count), ""]);
  const listLines = (items: DocumentActivityLine[], omitted: number) => [
    ...items.map((item) => `${item.title} — ${item.sourceLabel}`),
    ...(omitted > 0 ? [`and ${omitted} more`] : []),
  ];

  let activityBlock: string[];
  if (data.combinedActivity) {
    const combined = [...data.newDocuments, ...data.updatedDocuments];
    activityBlock =
      combined.length === 0
        ? ["No new or updated documents were detected in the last 24 hours.", ""]
        : [
            "Documents added or updated in the last 24 hours",
            String(data.newCount + data.updatedCount),
            "",
            ...listLines(combined, (data.omittedNew ?? 0) + (data.omittedUpdated ?? 0)),
            "",
          ];
  } else if (data.newCount === 0 && data.updatedCount === 0) {
    activityBlock = ["No new or updated documents were detected in the last 24 hours.", ""];
  } else {
    activityBlock = [
      "New in the last 24 hours",
      String(data.newCount),
      "",
      ...(data.newCount === 0 ? ["None", ""] : [...listLines(data.newDocuments, data.omittedNew ?? 0), ""]),
      "Updated in the last 24 hours",
      String(data.updatedCount),
      "",
      ...(data.updatedCount === 0
        ? ["None", ""]
        : [...listLines(data.updatedDocuments, data.omittedUpdated ?? 0), ""]),
    ];
  }

  const text = [
    "Infra",
    data.companyDisplayName,
    "",
    title,
    "",
    "Documents available to Infra",
    "",
    ...sourceLines,
    "Total",
    String(data.totalCount),
    "",
    ...activityBlock,
    `As of ${data.asOfLabel}.`,
    "",
    `View Infra: ${data.portalUrl}`,
    "",
    footer,
  ].join("\n");

  const htmlLines = (items: DocumentActivityLine[], omitted: number) =>
    `<ul style="margin:0 0 16px;padding-left:18px;color:#CBD5E1;">${items
      .map(
        (item) =>
          `<li style="margin:0 0 6px;">${escapeHtml(item.title)} — ${escapeHtml(item.sourceLabel)}</li>`,
      )
      .join("")}${
      omitted > 0 ? `<li style="margin:0 0 6px;color:#94A3B8;">and ${omitted} more</li>` : ""
    }</ul>`;

  let activityHtml: string;
  if (data.newCount === 0 && data.updatedCount === 0) {
    activityHtml =
      "<p style=\"margin:0 0 20px;color:#94A3B8;\">No new or updated documents were detected in the last 24 hours.</p>";
  } else if (data.combinedActivity) {
    activityHtml = `<p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Documents added or updated in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.newCount + data.updatedCount}</p>
    ${htmlLines([...data.newDocuments, ...data.updatedDocuments], (data.omittedNew ?? 0) + (data.omittedUpdated ?? 0))}`;
  } else {
    activityHtml = `<p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">New in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.newCount}</p>
    ${data.newCount === 0 ? "<p style=\"margin:0 0 16px;color:#94A3B8;\">None</p>" : htmlLines(data.newDocuments, data.omittedNew ?? 0)}
    <p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">Updated in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${data.updatedCount}</p>
    ${data.updatedCount === 0 ? "<p style=\"margin:0 0 16px;color:#94A3B8;\">None</p>" : htmlLines(data.updatedDocuments, data.omittedUpdated ?? 0)}`;
  }

  const sourceHtml = data.sourceCounts
    .map(
      (row) =>
        `<p style="margin:0 0 4px;font-size:13px;color:#94A3B8;">${escapeHtml(row.label)}</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;color:#F5F9FF;">${row.count}</p>`,
    )
    .join("\n    ");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#07111F;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0B1627;border:1px solid #203047;border-radius:12px;">
          <tr><td style="padding:24px 24px 8px;color:#94A3B8;font-size:13px;letter-spacing:0.04em;">INFRA</td></tr>
          <tr><td style="padding:0 24px 8px;color:#CBD5E1;font-size:13px;">${escapeHtml(data.companyDisplayName)}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#F5F9FF;font-size:22px;font-weight:700;">${escapeHtml(title)}</td></tr>
          <tr><td style="padding:0 24px 12px;font-weight:600;color:#F5F9FF;">Documents available to Infra</td></tr>
          <tr><td style="padding:0 24px;">${sourceHtml}</td></tr>
          <tr><td style="padding:0 24px 4px;color:#94A3B8;font-size:13px;">Total</td></tr>
          <tr><td style="padding:0 24px 20px;color:#F5F9FF;font-size:28px;font-weight:700;">${data.totalCount}</td></tr>
          <tr><td style="padding:0 24px;">${activityHtml}</td></tr>
          <tr><td style="padding:0 24px 16px;color:#94A3B8;font-size:13px;">As of ${escapeHtml(data.asOfLabel)}.</td></tr>
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
