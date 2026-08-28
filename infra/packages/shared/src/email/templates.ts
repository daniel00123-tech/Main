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
    data.companyDisplayName,
    "",
    title,
    "",
    "Documents available to INFRA",
    "",
    ...sourceLines,
    "Total",
    String(data.totalCount),
    "",
    ...activityBlock,
    `As of ${data.asOfLabel}.`,
    "",
    `View INFRA: ${data.portalUrl}`,
  ].join("\n");

  const htmlLines = (items: DocumentActivityLine[], omitted: number) =>
    `<ul style="margin:0 0 16px;padding-left:18px;">${items
      .map(
        (item) =>
          `<li style="margin:0 0 6px;">${escapeHtml(item.title)} — ${escapeHtml(item.sourceLabel)}</li>`,
      )
      .join("")}${
      omitted > 0 ? `<li style="margin:0 0 6px;color:#6b7280;">and ${omitted} more</li>` : ""
    }</ul>`;

  let activityHtml: string;
  if (data.newCount === 0 && data.updatedCount === 0) {
    activityHtml =
      "<p style=\"margin:0 0 20px;color:#6b7280;\">No new or updated documents were detected in the last 24 hours.</p>";
  } else if (data.combinedActivity) {
    activityHtml = `<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Documents added or updated in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;">${data.newCount + data.updatedCount}</p>
    ${htmlLines([...data.newDocuments, ...data.updatedDocuments], (data.omittedNew ?? 0) + (data.omittedUpdated ?? 0))}`;
  } else {
    activityHtml = `<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">New in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;">${data.newCount}</p>
    ${data.newCount === 0 ? "<p style=\"margin:0 0 16px;color:#6b7280;\">None</p>" : htmlLines(data.newDocuments, data.omittedNew ?? 0)}
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Updated in the last 24 hours</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;">${data.updatedCount}</p>
    ${data.updatedCount === 0 ? "<p style=\"margin:0 0 16px;color:#6b7280;\">None</p>" : htmlLines(data.updatedDocuments, data.omittedUpdated ?? 0)}`;
  }

  const sourceHtml = data.sourceCounts
    .map(
      (row) =>
        `<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">${escapeHtml(row.label)}</p>
    <p style="margin:0 0 12px;font-size:20px;font-weight:600;">${row.count}</p>`,
    )
    .join("\n    ");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827;margin:0;padding:24px;background:#f8fafc;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${escapeHtml(data.companyDisplayName)}</p>
    <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(title)}</h1>
    <p style="margin:0 0 12px;font-weight:600;">Documents available to INFRA</p>
    ${sourceHtml}
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Total</p>
    <p style="margin:0 0 20px;font-size:28px;font-weight:700;">${data.totalCount}</p>
    ${activityHtml}
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
