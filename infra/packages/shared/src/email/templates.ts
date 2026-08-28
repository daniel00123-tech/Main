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
}): { subject: string; text: string; html: string } {
  const company = input.companyDisplayName.trim();
  const subject = `${company} — ${input.title}`;
  const text = [
    company,
    "",
    input.title,
    "",
    input.bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    "",
    `${input.ctaLabel}: ${input.ctaUrl}`,
    "",
    input.footerNote ?? "",
    "",
    `Sent by INFRA for ${company}.`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827;margin:0;padding:24px;background:#f8fafc;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${escapeHtml(company)}</p>
    <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(input.title)}</h1>
    ${input.bodyHtml}
    <p style="margin:24px 0;">
      <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">${escapeHtml(input.ctaLabel)}</a>
    </p>
    ${input.footerNote ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280;">${escapeHtml(input.footerNote)}</p>` : ""}
    <p style="margin:0;font-size:12px;color:#9ca3af;">Sent by INFRA for ${escapeHtml(company)}.</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

export function renderPasswordResetEmail(data: PasswordResetTemplateData) {
  return emailShell({
    companyDisplayName: data.companyDisplayName,
    title: "Reset your password",
    bodyHtml:
      "<p style=\"margin:0 0 12px;\">We received a request to reset the password for your INFRA account.</p>",
    ctaLabel: "Reset password",
    ctaUrl: data.resetUrl,
    footerNote: `This link expires ${data.expiresLabel}. If you didn't request this, you can ignore this email.`,
  });
}

export function renderUserInvitationEmail(data: UserInvitationTemplateData) {
  return emailShell({
    companyDisplayName: data.companyDisplayName,
    title: "You've been invited to INFRA",
    bodyHtml: `<p style="margin:0 0 12px;">You've been invited to access the ${escapeHtml(data.companyDisplayName)} company portal.</p>`,
    ctaLabel: "Set up your account",
    ctaUrl: data.setupUrl,
    footerNote: `This invitation expires ${data.expiresLabel}.`,
  });
}

export function renderTestEmail(data: TestEmailTemplateData) {
  return emailShell({
    companyDisplayName: data.companyDisplayName,
    title: "Test email",
    bodyHtml: `<p style="margin:0 0 12px;">This is a safe test message from INFRA transactional email (${escapeHtml(data.sentAtLabel)}).</p>`,
    ctaLabel: "Open company portal",
    ctaUrl: "#",
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
  const text = [
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
    `View INFRA: ${data.portalUrl}`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827;margin:0;padding:24px;background:#f8fafc;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${escapeHtml(data.companyDisplayName)}</p>
    <h1 style="margin:0 0 8px;font-size:22px;">${escapeHtml(title)}</h1>
    <p style="margin:0 0 20px;color:#6b7280;">${escapeHtml(range)}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Sales</p>
    <p style="margin:0 0 16px;font-size:28px;font-weight:700;">${escapeHtml(data.salesLabel)}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">${escapeHtml(invoiceLabel)}</p>
    <p style="margin:0 0 20px;font-size:20px;font-weight:600;">${escapeHtml(String(data.invoiceCount))}</p>
    <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">As of ${escapeHtml(data.asOfLabel)}.</p>
    <p style="margin:0 0 16px;">
      <a href="${escapeHtml(data.portalUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">View INFRA</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af;">Sent by INFRA for ${escapeHtml(data.companyDisplayName)}.</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}
