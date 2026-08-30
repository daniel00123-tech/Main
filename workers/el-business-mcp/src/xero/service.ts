import type { XeroClient } from "./client";
import {
  previousMonthRange,
  resolveEffectiveDate,
  rollingRange,
  startOfMonth,
  todayIso,
  toXeroDateTimeClause,
  normalizeXeroDate,
} from "./dates";
import { ElXeroError } from "./errors";
import {
  computeAgeing,
  formatInvoice,
  isExcludedStatus,
  parseNamedReport,
  parseProfitAndLoss,
  qualifiesAsPostedSales,
  salesContribution,
} from "./reports";

function whereAnd(parts: Array<string | null | undefined>): string | undefined {
  const cleaned = parts.filter(Boolean) as string[];
  return cleaned.length ? cleaned.join(" AND ") : undefined;
}

export function formatContact(contact: Record<string, unknown>) {
  return {
    contactId: contact.ContactID ? String(contact.ContactID) : null,
    name: contact.Name ? String(contact.Name) : null,
    email: contact.EmailAddress ? String(contact.EmailAddress) : null,
    isCustomer: Boolean(contact.IsCustomer),
    isSupplier: Boolean(contact.IsSupplier),
    balances: contact.Balances ?? null,
    updatedDateUtc: contact.UpdatedDateUTC ?? null,
  };
}

export async function getOrganisation(client: XeroClient) {
  const [orgs, settings] = await Promise.all([
    client.get<{ Organisations?: Array<Record<string, unknown>> }>("/Organisation"),
    client.get<Record<string, unknown>>("/Organisation").catch(() => ({})),
  ]);
  const org = orgs.Organisations?.[0] ?? {};
  return {
    organisationName: client.organisationName,
    tenantId: client.tenantId,
    legalName: org.LegalName ?? org.Name ?? client.organisationName,
    baseCurrency: org.BaseCurrency ?? null,
    organisationType: org.OrganisationType ?? null,
    financialYearEnd: org.FinancialYearEndDay && org.FinancialYearEndMonth
      ? `${org.FinancialYearEndMonth}-${org.FinancialYearEndDay}`
      : null,
    timezone: org.Timezone ?? null,
    taxNumber: org.TaxNumber ?? null,
    settings,
  };
}

export async function searchContacts(
  client: XeroClient,
  input: { query?: string; role?: "customer" | "supplier" | "all"; top?: number }
) {
  const where = whereAnd([
    input.role === "customer" ? "IsCustomer==true" : null,
    input.role === "supplier" ? "IsSupplier==true" : null,
    input.query ? `Name.Contains("${input.query.replace(/"/g, "")}")` : null,
  ]);
  const rows = await client.getAll<Record<string, unknown>>("/Contacts", "Contacts", { where, order: "Name" }, input.top ?? 50);
  return rows.map(formatContact);
}

export async function getContactHistory(client: XeroClient, contactId: string) {
  const [contact, invoices] = await Promise.all([
    client.get<{ Contacts?: Array<Record<string, unknown>> }>(`/Contacts/${encodeURIComponent(contactId)}`),
    client.getAll<Record<string, unknown>>(
      "/Invoices",
      "Invoices",
      { where: `Contact.ContactID=Guid("${contactId}")`, order: "Date DESC" },
      80
    ),
  ]);
  return {
    contact: formatContact(contact.Contacts?.[0] ?? { ContactID: contactId }),
    invoices: invoices.map((row) => formatInvoice(row)),
  };
}

export async function searchInvoices(
  client: XeroClient,
  input: {
    type: "ACCREC" | "ACCPAY";
    query?: string;
    status?: string;
    outstanding?: boolean;
    overdue?: boolean;
    contact?: string;
    from?: string;
    to?: string;
    top?: number;
  }
) {
  const effective = todayIso();
  const parts = [`Type=="${input.type}"`];
  if (input.status) parts.push(`Status=="${input.status.toUpperCase()}"`);
  if (input.outstanding) parts.push("AmountDue>0");
  if (input.from) parts.push(`Date>=${toXeroDateTimeClause(input.from)}`);
  if (input.to) parts.push(`Date<=${toXeroDateTimeClause(input.to)}`);
  if (input.query && /^INV[-_A-Z0-9]+$/i.test(input.query.trim())) {
    parts.push(`InvoiceNumber=="${input.query.trim().replace(/"/g, "")}"`);
  }
  const rows = await client.getAll<Record<string, unknown>>(
    "/Invoices",
    "Invoices",
    { where: parts.join(" AND "), order: "Date DESC" },
    200
  );
  let filtered = rows;
  if (input.overdue) {
    filtered = filtered.filter((row) => {
      if (isExcludedStatus(row.Status) || Number(row.AmountDue ?? 0) <= 0) return false;
      const due = normalizeXeroDate(row.DueDate);
      return Boolean(due && due < effective);
    });
  }
  if (input.contact) {
    const needle = input.contact.toLowerCase();
    filtered = filtered.filter((row) => {
      const contact = row.Contact as Record<string, unknown> | undefined;
      return String(contact?.Name ?? "").toLowerCase().includes(needle);
    });
  }
  if (input.query && !/^INV[-_A-Z0-9]+$/i.test(input.query.trim())) {
    const needle = input.query.toLowerCase();
    filtered = filtered.filter((row) =>
      `${row.InvoiceNumber ?? ""} ${ (row.Contact as { Name?: string } | undefined)?.Name ?? ""} ${row.Reference ?? ""}`
        .toLowerCase()
        .includes(needle)
    );
  }
  return filtered.slice(0, input.top ?? 40).map((row) => formatInvoice(row, effective));
}

export async function getInvoice(client: XeroClient, invoiceId: string) {
  const payload = await client.get<{ Invoices?: Array<Record<string, unknown>> }>(
    `/Invoices/${encodeURIComponent(invoiceId)}`
  );
  const invoice = payload.Invoices?.[0];
  if (!invoice) throw new ElXeroError("Invoice not found.", "EL_XERO_NOT_FOUND", 404);
  return {
    ...formatInvoice(invoice),
    lineItems: invoice.LineItems ?? [],
    payments: invoice.Payments ?? [],
    creditNotes: invoice.CreditNotes ?? [],
    rawStatus: invoice.Status ?? null,
  };
}

export async function getReport(
  client: XeroClient,
  input: { report: string; from?: string; to?: string; date?: string; periods?: number }
) {
  const report = input.report.toLowerCase();
  const to = input.to ?? input.date ?? todayIso();
  const from = input.from ?? startOfMonth(to);
  if (report === "profitandloss" || report === "pnl" || report === "p&l") {
    const body = await client.get<{ Reports?: never[] }>("/Reports/ProfitAndLoss", {
      fromDate: from,
      toDate: to,
      standardLayout: true,
      paymentsOnly: false,
      ...(input.periods ? { periods: input.periods, timeframe: "MONTH" } : {}),
    });
    return { kind: "profit_and_loss", from, to, parsed: parseProfitAndLoss(body), source: body };
  }
  if (report === "balancesheet") {
    const body = await client.get<{ Reports?: never[] }>("/Reports/BalanceSheet", { date: to });
    return { kind: "balance_sheet", date: to, parsed: parseNamedReport(body), source: body };
  }
  if (report === "trialbalance") {
    const body = await client.get<{ Reports?: never[] }>("/Reports/TrialBalance", { date: to });
    return { kind: "trial_balance", date: to, parsed: parseNamedReport(body), source: body };
  }
  if (report === "banksummary") {
    const body = await client.get<{ Reports?: never[] }>("/Reports/BankSummary", { fromDate: from, toDate: to });
    return { kind: "bank_summary", from, to, parsed: parseNamedReport(body), source: body };
  }
  if (report === "executivesummary") {
    const body = await client.get<{ Reports?: never[] }>("/Reports/ExecutiveSummary", { date: to });
    return { kind: "executive_summary", date: to, parsed: parseNamedReport(body), source: body };
  }
  if (report === "agedreceivables" || report === "aged_receivables") {
    const invoices = await client.getAll<Record<string, unknown>>(
      "/Invoices",
      "Invoices",
      { where: 'Type=="ACCREC" AND AmountDue>0' },
      400
    );
    return { kind: "aged_receivables", ...computeAgeing(invoices, "receivables", to) };
  }
  if (report === "agedpayables" || report === "aged_payables") {
    const bills = await client.getAll<Record<string, unknown>>(
      "/Invoices",
      "Invoices",
      { where: 'Type=="ACCPAY" AND AmountDue>0' },
      400
    );
    return { kind: "aged_payables", ...computeAgeing(bills, "payables", to) };
  }
  throw new ElXeroError(
    "Unknown report. Use profitandloss, balancesheet, trialbalance, banksummary, executivesummary, agedreceivables or agedpayables.",
    "EL_XERO_INPUT",
    400
  );
}

export async function analyseSales(client: XeroClient, months = 6) {
  const today = todayIso();
  const mtd = { from: startOfMonth(today), to: today };
  const prev = previousMonthRange(today);
  const rolling = rollingRange(months, today);
  const [invoices, credits, pnl] = await Promise.all([
    client.getAll<Record<string, unknown>>(
      "/Invoices",
      "Invoices",
      { where: `Type=="ACCREC" AND Date>=${toXeroDateTimeClause(rolling.from)}` },
      400
    ),
    client.getAll<Record<string, unknown>>(
      "/CreditNotes",
      "CreditNotes",
      { where: `Type=="ACCRECCREDIT" AND Date>=${toXeroDateTimeClause(rolling.from)}` },
      200
    ).catch(() => [] as Record<string, unknown>[]),
    getReport(client, { report: "profitandloss", from: mtd.from, to: mtd.to }).catch(() => null),
  ]);

  const docs: Array<Record<string, unknown>> = [
    ...invoices.map((row) => ({ ...row, _kind: "invoice" })),
    ...credits.map((row) => ({ ...row, _kind: "credit_note", Type: row.Type ?? "ACCRECCREDIT" })),
  ];

  const sumRange = (from: string, to: string) => {
    let invoiced = 0;
    let count = 0;
    for (const row of docs) {
      const status = String(row.Status ?? "");
      const type = String(row.Type ?? "");
      const date = normalizeXeroDate(row.Date);
      if (!date || date < from || date > to) continue;
      if (!qualifiesAsPostedSales(type, status)) continue;
      invoiced += salesContribution(type, Number(row.Total ?? 0));
      count += 1;
    }
    return { from, to, invoicedSales: Number(invoiced.toFixed(2)), documentCount: count };
  };

  const thisMonth = sumRange(mtd.from, mtd.to);
  const lastMonth = sumRange(prev.from, prev.to);
  const change = lastMonth.invoicedSales === 0
    ? null
    : Number((((thisMonth.invoicedSales - lastMonth.invoicedSales) / lastMonth.invoicedSales) * 100).toFixed(1));

  return {
    semantics:
      "invoicedSales is posted ACCREC invoices minus ACCRECCREDIT credit notes in the date range. Draft/void/deleted documents are excluded. P&L revenue can differ when lines post to non-sales accounts.",
    monthToDate: thisMonth,
    previousMonth: lastMonth,
    monthOnMonthPercent: change,
    rolling: sumRange(rolling.from, rolling.to),
    pnl: pnl && "parsed" in pnl ? pnl.parsed : null,
    largestInvoices: invoices
      .filter((row) => qualifiesAsPostedSales(String(row.Type ?? ""), String(row.Status ?? "")))
      .sort((a, b) => Number(b.Total ?? 0) - Number(a.Total ?? 0))
      .slice(0, 8)
      .map((row) => formatInvoice(row)),
  };
}

export async function analyseCustomers(client: XeroClient, months = 6, top = 8) {
  const range = rollingRange(months);
  const invoices = await client.getAll<Record<string, unknown>>(
    "/Invoices",
    "Invoices",
    { where: `Type=="ACCREC" AND Date>=${toXeroDateTimeClause(range.from)}` },
    400
  );
  const credits = await client.getAll<Record<string, unknown>>(
    "/CreditNotes",
    "CreditNotes",
    { where: `Type=="ACCRECCREDIT" AND Date>=${toXeroDateTimeClause(range.from)}` },
    200
  ).catch(() => [] as Record<string, unknown>[]);

  const spend = new Map<string, { contactId: string | null; name: string; invoiced: number; due: number; count: number }>();
  const add = (row: Record<string, unknown>, type: string) => {
    if (!qualifiesAsPostedSales(type, String(row.Status ?? ""))) return;
    const contact = row.Contact as Record<string, unknown> | undefined;
    const key = String(contact?.ContactID ?? contact?.Name ?? "unknown");
    const current = spend.get(key) ?? {
      contactId: contact?.ContactID ? String(contact.ContactID) : null,
      name: String(contact?.Name ?? "Unknown"),
      invoiced: 0,
      due: 0,
      count: 0,
    };
    current.invoiced += salesContribution(type, Number(row.Total ?? 0));
    if (type === "ACCREC") {
      current.due += Number(row.AmountDue ?? 0);
      current.count += 1;
    }
    spend.set(key, current);
  };
  for (const row of invoices) add(row, "ACCREC");
  for (const row of credits) add(row, "ACCRECCREDIT");

  const customers = [...spend.values()].sort((a, b) => b.invoiced - a.invoiced);
  return {
    from: range.from,
    to: range.to,
    topCustomers: customers.slice(0, top),
    outstandingDebt: Number(customers.reduce((sum, row) => sum + row.due, 0).toFixed(2)),
  };
}

export async function analyseSuppliers(client: XeroClient, months = 6, top = 8) {
  const range = rollingRange(months);
  const bills = await client.getAll<Record<string, unknown>>(
    "/Invoices",
    "Invoices",
    { where: `Type=="ACCPAY" AND Date>=${toXeroDateTimeClause(range.from)}` },
    400
  );
  const spend = new Map<string, { contactId: string | null; name: string; billed: number; due: number; count: number }>();
  for (const row of bills) {
    if (isExcludedStatus(row.Status)) continue;
    const contact = row.Contact as Record<string, unknown> | undefined;
    const key = String(contact?.ContactID ?? contact?.Name ?? "unknown");
    const current = spend.get(key) ?? {
      contactId: contact?.ContactID ? String(contact.ContactID) : null,
      name: String(contact?.Name ?? "Unknown"),
      billed: 0,
      due: 0,
      count: 0,
    };
    current.billed += Number(row.Total ?? 0);
    current.due += Number(row.AmountDue ?? 0);
    current.count += 1;
    spend.set(key, current);
  }
  const suppliers = [...spend.values()].sort((a, b) => b.billed - a.billed);
  return {
    from: range.from,
    to: range.to,
    topSuppliers: suppliers.slice(0, top),
    outstandingCreditors: Number(suppliers.reduce((sum, row) => sum + row.due, 0).toFixed(2)),
  };
}

export async function financialSummary(client: XeroClient) {
  const today = resolveEffectiveDate();
  const [sales, customers, suppliers, pnl, bank, receivables, payables, accounts] = await Promise.all([
    analyseSales(client, 6),
    analyseCustomers(client, 6, 5),
    analyseSuppliers(client, 6, 5),
    getReport(client, { report: "profitandloss", from: startOfMonth(today), to: today }).catch((error) => ({ error: String(error) })),
    getReport(client, { report: "banksummary", from: startOfMonth(today), to: today }).catch((error) => ({ error: String(error) })),
    searchInvoices(client, { type: "ACCREC", outstanding: true, top: 20 }),
    searchInvoices(client, { type: "ACCPAY", outstanding: true, top: 20 }),
    client.get<{ Accounts?: Array<Record<string, unknown>> }>("/Accounts").catch(() => ({ Accounts: [] })),
  ]);
  const bankAccounts = (accounts.Accounts ?? []).filter((row) => String(row.Type ?? "") === "BANK");
  return {
    organisationName: client.organisationName,
    tenantId: client.tenantId,
    asAt: today,
    sales,
    customers,
    suppliers,
    pnl,
    bankSummary: bank,
    outstandingInvoices: receivables,
    outstandingBills: payables,
    bankAccounts: bankAccounts.map((row) => ({
      accountId: row.AccountID,
      name: row.Name,
      code: row.Code,
      currency: row.CurrencyCode,
    })),
  };
}

export async function listSettings(client: XeroClient) {
  const [accounts, tax, tracking, currencies, items] = await Promise.all([
    client.get<{ Accounts?: unknown[] }>("/Accounts"),
    client.get<{ TaxRates?: unknown[] }>("/TaxRates"),
    client.get<{ TrackingCategories?: unknown[] }>("/TrackingCategories").catch(() => ({ TrackingCategories: [] })),
    client.get<{ Currencies?: unknown[] }>("/Currencies").catch(() => ({ Currencies: [] })),
    client.get<{ Items?: unknown[] }>("/Items").catch(() => ({ Items: [] })),
  ]);
  return {
    accounts: accounts.Accounts ?? [],
    taxRates: tax.TaxRates ?? [],
    trackingCategories: tracking.TrackingCategories ?? [],
    currencies: currencies.Currencies ?? [],
    items: items.Items ?? [],
  };
}

type DraftLine = { description: string; quantity?: number; unitAmount: number; accountCode?: string };

export function previewDraftDocument(input: {
  type: "ACCREC" | "ACCPAY" | "ACCRECCREDIT";
  kind: "invoice" | "bill" | "credit_note" | "quote";
  contact: string;
  lineItems: DraftLine[];
  date?: string;
  dueDate?: string;
  reference?: string;
}) {
  const lines = input.lineItems.map((line) => ({
    Description: line.description,
    Quantity: line.quantity ?? 1,
    UnitAmount: line.unitAmount,
    AccountCode: line.accountCode,
  }));
  const total = lines.reduce((sum, line) => sum + Number(line.Quantity) * Number(line.UnitAmount), 0);
  return {
    kind: input.kind,
    status: "DRAFT",
    type: input.type,
    contact: input.contact,
    date: input.date ?? todayIso(),
    dueDate: input.dueDate,
    reference: input.reference,
    lineItems: lines,
    estimatedTotalExTax: Number(total.toFixed(2)),
    note: "This preview will create a DRAFT only. It will not approve, send, void, pay or reconcile anything.",
  };
}

export async function createDraft(
  client: XeroClient,
  input: {
    kind: "invoice" | "bill" | "credit_note" | "quote";
    contact: string;
    lineItems: DraftLine[];
    date?: string;
    dueDate?: string;
    reference?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }
) {
  if (!input.lineItems?.length) {
    throw new ElXeroError("At least one line item is required.", "EL_XERO_INPUT", 400);
  }
  const type = input.kind === "bill" ? "ACCPAY" : input.kind === "credit_note" ? "ACCRECCREDIT" : "ACCREC";
  const preview = previewDraftDocument({
    type,
    kind: input.kind,
    contact: input.contact,
    lineItems: input.lineItems,
    date: input.date,
    dueDate: input.dueDate,
    reference: input.reference,
  });
  if (input.dryRun !== false || input.confirm !== true) {
    return {
      executed: false,
      requiresConfirmation: true,
      preview,
      instruction: "Re-run with dry_run=false and confirm=true to create the DRAFT in Xero.",
    };
  }

  if (input.kind === "quote") {
    const body = {
      Quotes: [
        {
          Contact: { Name: input.contact },
          Date: preview.date,
          ExpiryDate: input.dueDate,
          Reference: input.reference,
          Status: "DRAFT",
          LineItems: preview.lineItems,
        },
      ],
    };
    const created = await client.post("/Quotes", body);
    return { executed: true, preview, result: created };
  }

  if (input.kind === "credit_note") {
    const body = {
      CreditNotes: [
        {
          Type: "ACCRECCREDIT",
          Contact: { Name: input.contact },
          Date: preview.date,
          Reference: input.reference,
          Status: "DRAFT",
          LineItems: preview.lineItems,
        },
      ],
    };
    const created = await client.post("/CreditNotes", body);
    return { executed: true, preview, result: created };
  }

  const body = {
    Invoices: [
      {
        Type: type,
        Contact: { Name: input.contact },
        Date: preview.date,
        DueDate: input.dueDate,
        Reference: input.reference,
        Status: "DRAFT",
        LineItems: preview.lineItems,
      },
    ],
  };
  const created = await client.post("/Invoices", body);
  return { executed: true, preview, result: created };
}
