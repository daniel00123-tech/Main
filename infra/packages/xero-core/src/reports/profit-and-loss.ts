export type XeroReportCell = {
  Value?: string;
  Attributes?: unknown[];
};

export type XeroReportRow = {
  RowType?: string;
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
};

export type XeroReport = {
  ReportID?: string;
  ReportName?: string;
  ReportTitles?: string[];
  ReportDate?: string;
  Rows?: XeroReportRow[];
};

export type ParsedProfitAndLossPeriod = {
  columnTitle: string | null;
  revenue: number | null;
  costOfSales: number | null;
  grossProfit: number | null;
  operatingExpenses: number | null;
  netProfit: number | null;
};

export type ParsedProfitAndLoss = {
  reportName: string | null;
  reportDate: string | null;
  currencyCode: string | null;
  periods: ParsedProfitAndLossPeriod[];
};

function parseAmount(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLabel(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function matchLabel(label: string, patterns: string[]): boolean {
  return patterns.some((pattern) => label.includes(pattern));
}

function assignMetric(
  target: ParsedProfitAndLossPeriod,
  label: string,
  amount: number | null,
): void {
  if (amount == null) return;
  if (matchLabel(label, ["total income", "total revenue", "total trading income"])) {
    target.revenue = amount;
    return;
  }
  if (matchLabel(label, ["total cost of sales", "total direct costs", "cost of sales"])) {
    target.costOfSales = amount;
    return;
  }
  if (matchLabel(label, ["gross profit", "total gross profit"])) {
    target.grossProfit = amount;
    return;
  }
  if (
    matchLabel(label, [
      "total operating expenses",
      "total expenses",
      "total overheads",
      "total administration",
    ])
  ) {
    target.operatingExpenses = amount;
    return;
  }
  if (
    matchLabel(label, [
      "net profit",
      "net loss",
      "total comprehensive income",
      "surplus/deficit",
      "total surplus",
      "total deficit",
    ])
  ) {
    target.netProfit = amount;
  }
}

function extractColumnTitles(report: XeroReport): string[] {
  const header = report.Rows?.find((row) => row.RowType === "Header");
  if (!header?.Cells?.length) return ["Total"];
  return header.Cells.slice(1).map((cell, index) => cell.Value?.trim() || `Column ${index + 1}`);
}

function emptyPeriod(columnTitle: string | null): ParsedProfitAndLossPeriod {
  return {
    columnTitle,
    revenue: null,
    costOfSales: null,
    grossProfit: null,
    operatingExpenses: null,
    netProfit: null,
  };
}

function walkRows(rows: XeroReportRow[] | undefined, periods: ParsedProfitAndLossPeriod[]): void {
  if (!rows) return;
  for (const row of rows) {
    if (row.RowType === "Section") {
      walkRows(row.Rows, periods);
      continue;
    }
    if (row.RowType !== "SummaryRow" && row.RowType !== "Row") continue;
    const label = normalizeLabel(row.Cells?.[0]?.Value);
    if (!label) continue;
    const values = row.Cells?.slice(1) ?? [];
    for (let index = 0; index < periods.length; index += 1) {
      assignMetric(periods[index]!, label, parseAmount(values[index]?.Value));
    }
  }
}

export function parseProfitAndLossReport(body: {
  Reports?: XeroReport[];
}): ParsedProfitAndLoss {
  const report = body.Reports?.[0];
  if (!report) {
    return {
      reportName: null,
      reportDate: null,
      currencyCode: null,
      periods: [],
    };
  }

  const columnTitles = extractColumnTitles(report);
  const periods = columnTitles.map((title) => emptyPeriod(title));
  walkRows(report.Rows, periods);

  const currencyCode =
    report.ReportTitles?.find((title) => /^\([A-Z]{3}\)$/.test(title.trim()))?.slice(1, -1) ??
    null;

  return {
    reportName: report.ReportName ?? null,
    reportDate: report.ReportDate ?? null,
    currencyCode,
    periods,
  };
}

export function buildProfitAndLossQuery(input: {
  fromDate: string;
  toDate: string;
  periods?: number;
  timeframe?: "MONTH" | "QUARTER" | "YEAR";
  standardLayout?: boolean;
  paymentsOnly?: boolean;
}): Record<string, string> {
  const query: Record<string, string> = {
    fromDate: input.fromDate,
    toDate: input.toDate,
    standardLayout: String(input.standardLayout ?? true),
    paymentsOnly: String(input.paymentsOnly ?? false),
  };
  if (input.periods != null) query.periods = String(input.periods);
  if (input.timeframe) query.timeframe = input.timeframe;
  return query;
}

export function customerSafeXeroErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "XERO_AUTH_EXPIRED":
      return "Xero authentication expired or insufficient scope.";
    case "XERO_FORBIDDEN":
      return "Xero denied access to that resource.";
    case "XERO_NOT_FOUND":
      return "The requested Xero record was not found.";
    case "XERO_RATE_LIMITED":
      return "Xero rate limit reached. Retry shortly.";
    case "XERO_TIMEOUT":
      return "Xero request timed out.";
    case "XERO_PROVIDER_UNAVAILABLE":
      return "Xero is temporarily unavailable.";
    case "XERO_MALFORMED_RESPONSE":
      return "Xero is temporarily unavailable.";
    default:
      return fallback;
  }
}
