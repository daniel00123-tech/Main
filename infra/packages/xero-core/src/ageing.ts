import { daysBetweenIso, isBeforeIsoDate, normalizeXeroDate, resolveEffectiveDate } from "./dates";
import {
  formatInvoiceSummary,
  invoiceHasOutstandingBalance,
  isExcludedInvoiceStatus,
  type FormattedInvoiceSummary,
} from "./invoices";

export type AgeingBucketKey = "current" | "1-30" | "31-60" | "61-90" | "90+";

export type AgeingBucket = {
  key: AgeingBucketKey;
  label: string;
  invoiceCount: number;
  totalAmountDue: number;
};

export type AgeingLine = FormattedInvoiceSummary & {
  ageingBucket: AgeingBucketKey;
  ageingBucketLabel: string;
};

export type AgeingReport = {
  reportType: "receivables" | "payables";
  effectiveDate: string;
  currencyCode: string | null;
  buckets: AgeingBucket[];
  totalOutstanding: number;
  lines: AgeingLine[];
  meta: {
    source: "computed_from_outstanding_invoices";
    note: string;
  };
};

const BUCKET_LABELS: Record<AgeingBucketKey, string> = {
  current: "Current (not yet due)",
  "1-30": "1–30 days overdue",
  "31-60": "31–60 days overdue",
  "61-90": "61–90 days overdue",
  "90+": "90+ days overdue",
};

export function classifyAgeingBucket(
  dueDate: string | null,
  effectiveDate: string,
): AgeingBucketKey {
  if (!dueDate || !isBeforeIsoDate(dueDate, effectiveDate)) return "current";
  const days = daysBetweenIso(dueDate, effectiveDate);
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function emptyAgeingBuckets(): AgeingBucket[] {
  return (Object.keys(BUCKET_LABELS) as AgeingBucketKey[]).map((key) => ({
    key,
    label: BUCKET_LABELS[key],
    invoiceCount: 0,
    totalAmountDue: 0,
  }));
}

export function computeAgeingFromInvoices(input: {
  invoices: Record<string, unknown>[];
  reportType: "receivables" | "payables";
  effectiveDate?: string;
  currencyCode?: string | null;
}): AgeingReport {
  const effectiveDate = resolveEffectiveDate(input.effectiveDate);
  const expectedType = input.reportType === "receivables" ? "ACCREC" : "ACCPAY";
  const buckets = emptyAgeingBuckets();
  const bucketIndex = new Map(buckets.map((bucket, index) => [bucket.key, index]));
  const lines: AgeingLine[] = [];

  for (const invoice of input.invoices) {
    if (String(invoice.Type ?? "") !== expectedType) continue;
    if (isExcludedInvoiceStatus(invoice.Status)) continue;
    if (!invoiceHasOutstandingBalance(invoice)) continue;

    const summary = formatInvoiceSummary(invoice, effectiveDate);
    const ageingBucket = classifyAgeingBucket(summary.dueDate, effectiveDate);
    const ageingBucketLabel = BUCKET_LABELS[ageingBucket];
    lines.push({ ...summary, ageingBucket, ageingBucketLabel });

    const idx = bucketIndex.get(ageingBucket);
    if (idx != null) {
      buckets[idx].invoiceCount += 1;
      buckets[idx].totalAmountDue += summary.amountDue;
    }
  }

  lines.sort((a, b) => b.amountDue - a.amountDue);

  return {
    reportType: input.reportType,
    effectiveDate,
    currencyCode: input.currencyCode ?? null,
    buckets,
    totalOutstanding: lines.reduce((sum, line) => sum + line.amountDue, 0),
    lines,
    meta: {
      source: "computed_from_outstanding_invoices",
      note:
        "Ageing computed from outstanding invoice/bill balances grouped by due date relative to the effective date. This replaces the Xero AgedReceivablesByContact report which requires a contactId per call.",
    },
  };
}

export function groupAgeingByContact(lines: AgeingLine[]): Array<{
  contactId: string | null;
  contactName: string;
  totalAmountDue: number;
  invoiceCount: number;
  buckets: AgeingBucket[];
}> {
  const groups = new Map<
    string,
    {
      contactId: string | null;
      contactName: string;
      totalAmountDue: number;
      invoiceCount: number;
      bucketTotals: Record<AgeingBucketKey, { count: number; amount: number }>;
    }
  >();

  for (const line of lines) {
    const key = line.contactId ?? line.customerOrSupplier ?? "unknown";
    const existing = groups.get(key) ?? {
      contactId: line.contactId,
      contactName: line.customerOrSupplier ?? "Unknown contact",
      totalAmountDue: 0,
      invoiceCount: 0,
      bucketTotals: {
        current: { count: 0, amount: 0 },
        "1-30": { count: 0, amount: 0 },
        "31-60": { count: 0, amount: 0 },
        "61-90": { count: 0, amount: 0 },
        "90+": { count: 0, amount: 0 },
      },
    };
    existing.totalAmountDue += line.amountDue;
    existing.invoiceCount += 1;
    existing.bucketTotals[line.ageingBucket].count += 1;
    existing.bucketTotals[line.ageingBucket].amount += line.amountDue;
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((group) => ({
      contactId: group.contactId,
      contactName: group.contactName,
      totalAmountDue: group.totalAmountDue,
      invoiceCount: group.invoiceCount,
      buckets: (Object.keys(BUCKET_LABELS) as AgeingBucketKey[]).map((key) => ({
        key,
        label: BUCKET_LABELS[key],
        invoiceCount: group.bucketTotals[key].count,
        totalAmountDue: group.bucketTotals[key].amount,
      })),
    }))
    .sort((a, b) => b.totalAmountDue - a.totalAmountDue);
}
