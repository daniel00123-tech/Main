import { daysBetweenIso, isBeforeIsoDate, normalizeXeroDate, resolveEffectiveDate } from "./dates";

export type XeroReportRow = {
  RowType?: string;
  Title?: string;
  Cells?: Array<{ Value?: string }>;
  Rows?: XeroReportRow[];
};

export type ParsedPnlPeriod = {
  columnTitle: string | null;
  revenue: number | null;
  costOfSales: number | null;
  grossProfit: number | null;
  operatingExpenses: number | null;
  netProfit: number | null;
};

function parseAmount(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function assignMetric(target: ParsedPnlPeriod, label: string, amount: number | null): void {
  if (amount == null) return;
  const text = label.toLowerCase();
  if (["total income", "total revenue", "total trading income"].some((p) => text.includes(p))) {
    target.revenue = amount;
    return;
  }
  if (["total cost of sales", "total direct costs"].some((p) => text.includes(p)) || text === "cost of sales") {
    target.costOfSales = amount;
    return;
  }
  if (text.includes("gross profit")) {
    target.grossProfit = amount;
    return;
  }
  if (["total operating expenses", "total expenses", "total overheads"].some((p) => text.includes(p))) {
    target.operatingExpenses = amount;
    return;
  }
  if (["net profit", "net loss", "total comprehensive income", "surplus/deficit"].some((p) => text.includes(p))) {
    target.netProfit = amount;
  }
}

function walk(rows: XeroReportRow[] | undefined, periods: ParsedPnlPeriod[]): void {
  if (!rows) return;
  for (const row of rows) {
    if (row.RowType === "Section") {
      walk(row.Rows, periods);
      continue;
    }
    if (row.RowType !== "SummaryRow" && row.RowType !== "Row") continue;
    const label = row.Cells?.[0]?.Value ?? "";
    const values = row.Cells?.slice(1) ?? [];
    for (let i = 0; i < periods.length; i += 1) assignMetric(periods[i]!, label, parseAmount(values[i]?.Value));
  }
}

export function parseProfitAndLoss(body: { Reports?: Array<{ ReportName?: string; ReportDate?: string; ReportTitles?: string[]; Rows?: XeroReportRow[] }> }): {
  reportName: string | null;
  reportDate: string | null;
  periods: ParsedPnlPeriod[];
} {
  const report = body.Reports?.[0];
  if (!report) return { reportName: null, reportDate: null, periods: [] };
  const header = report.Rows?.find((row) => row.RowType === "Header");
  const titles = header?.Cells?.slice(1).map((cell, i) => cell.Value?.trim() || `Column ${i + 1}`) ?? ["Total"];
  const periods = titles.map((title) => ({
    columnTitle: title,
    revenue: null,
    costOfSales: null,
    grossProfit: null,
    operatingExpenses: null,
    netProfit: null,
  }));
  walk(report.Rows, periods);
  return { reportName: report.ReportName ?? null, reportDate: report.ReportDate ?? null, periods };
}

export function parseNamedReport(body: { Reports?: Array<{ ReportName?: string; ReportDate?: string; Rows?: XeroReportRow[] }> }): unknown {
  const report = body.Reports?.[0];
  if (!report) return { reportName: null, rows: [] };
  return {
    reportName: report.ReportName ?? null,
    reportDate: report.ReportDate ?? null,
    rows: report.Rows ?? [],
  };
}

export const EXCLUDED_INVOICE_STATUSES = new Set(["VOIDED", "DELETED", "DRAFT", "SUBMITTED"]);

export function isExcludedStatus(status: unknown): boolean {
  return EXCLUDED_INVOICE_STATUSES.has(String(status ?? "").trim().toUpperCase());
}

export function formatInvoice(invoice: Record<string, unknown>, effectiveDate?: string) {
  const effective = resolveEffectiveDate(effectiveDate);
  const dueDate = normalizeXeroDate(invoice.DueDate);
  const contact = invoice.Contact as Record<string, unknown> | undefined;
  const amountDue = Number(invoice.AmountDue ?? 0);
  const type = String(invoice.Type ?? "");
  return {
    invoiceId: invoice.InvoiceID ? String(invoice.InvoiceID) : null,
    invoiceNumber: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    documentType: type === "ACCREC" ? "sales_invoice" : type === "ACCPAY" ? "supplier_bill" : type,
    customerOrSupplier: contact?.Name ? String(contact.Name) : null,
    contactId: contact?.ContactID ? String(contact.ContactID) : null,
    date: normalizeXeroDate(invoice.Date),
    dueDate,
    status: invoice.Status ? String(invoice.Status) : null,
    total: invoice.Total != null ? Number(invoice.Total) : null,
    amountPaid: invoice.AmountPaid != null ? Number(invoice.AmountPaid) : null,
    amountDue,
    daysOverdue: dueDate && isBeforeIsoDate(dueDate, effective) ? daysBetweenIso(dueDate, effective) : 0,
    currencyCode: invoice.CurrencyCode ? String(invoice.CurrencyCode) : null,
    reference: invoice.Reference ? String(invoice.Reference) : null,
  };
}

export type AgeingBucketKey = "current" | "1-30" | "31-60" | "61-90" | "90+";

const BUCKET_LABELS: Record<AgeingBucketKey, string> = {
  current: "Current (not yet due)",
  "1-30": "1–30 days overdue",
  "31-60": "31–60 days overdue",
  "61-90": "61–90 days overdue",
  "90+": "90+ days overdue",
};

export function classifyAgeingBucket(dueDate: string | null, effectiveDate: string): AgeingBucketKey {
  if (!dueDate || !isBeforeIsoDate(dueDate, effectiveDate)) return "current";
  const days = daysBetweenIso(dueDate, effectiveDate);
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function computeAgeing(invoices: Record<string, unknown>[], reportType: "receivables" | "payables", effectiveDate?: string) {
  const effective = resolveEffectiveDate(effectiveDate);
  const expected = reportType === "receivables" ? "ACCREC" : "ACCPAY";
  const buckets = (Object.keys(BUCKET_LABELS) as AgeingBucketKey[]).map((key) => ({
    key,
    label: BUCKET_LABELS[key],
    invoiceCount: 0,
    totalAmountDue: 0,
  }));
  const lines = [];
  for (const invoice of invoices) {
    if (String(invoice.Type ?? "") !== expected) continue;
    if (isExcludedStatus(invoice.Status)) continue;
    if (Number(invoice.AmountDue ?? 0) <= 0) continue;
    const summary = formatInvoice(invoice, effective);
    const key = classifyAgeingBucket(summary.dueDate, effective);
    const bucket = buckets.find((row) => row.key === key)!;
    bucket.invoiceCount += 1;
    bucket.totalAmountDue += summary.amountDue;
    lines.push({ ...summary, ageingBucket: key, ageingBucketLabel: BUCKET_LABELS[key] });
  }
  lines.sort((a, b) => b.amountDue - a.amountDue);
  return {
    reportType,
    effectiveDate: effective,
    buckets,
    totalOutstanding: lines.reduce((sum, line) => sum + line.amountDue, 0),
    lines,
    source: "computed_from_outstanding_invoices",
  };
}

export function salesContribution(type: string, total: number): number {
  if (type === "ACCREC") return total;
  if (type === "ACCRECCREDIT") return -Math.abs(total);
  return 0;
}

export function qualifiesAsPostedSales(type: string, status: string): boolean {
  if (type !== "ACCREC" && type !== "ACCRECCREDIT") return false;
  return !["VOIDED", "DELETED", "DRAFT", "SUBMITTED"].includes(status);
}
