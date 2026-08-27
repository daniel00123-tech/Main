import { XERO_DATA_BOUNDS } from "@infra/shared";
import type { XeroClient } from "../client";
import { computeAgeingFromInvoices, groupAgeingByContact } from "../ageing";
import {
  normalizeXeroDate,
  resolveEffectiveDate,
  toXeroDateTimeClause,
} from "../dates";
import { xeroGetJson, type XeroFetchConfig } from "../fetch-json";
import {
  buildOutstandingSalesInvoiceWhere,
  filterInvoicesByType,
  formatInvoiceSummary,
  invoiceHasOutstandingBalance,
  invoiceTypeWhereClause,
  isOverdueSalesInvoice,
  normalizeInvoiceTypeFilter,
  sortOverdueInvoices,
  SALES_SEMANTICS,
  type InvoiceDocumentType,
} from "../invoices";
import { fetchAllPagedWithConfig, XERO_API_PAGE_SIZE } from "../pagination";
import {
  buildPaymentDateWhere,
  filterPaymentsByDirection,
  filterPaymentsByTransactionDate,
  formatPaymentSummary,
  sumPaymentAmounts,
  type PaymentDirection,
} from "../payments";
import {
  aggregateTopSuppliers,
  classifyPurchaseDocuments,
  mapPurchaseInvoiceRow,
} from "../purchase-aggregation";
import {
  buildProfitAndLossQuery,
  parseProfitAndLossReport,
  type ParsedProfitAndLoss,
} from "../reports/profit-and-loss";
import {
  aggregateSales,
  aggregateTopCustomers,
  classifySalesDocuments,
  dateRangeWhere,
  mapCreditNoteRow,
  mapInvoiceRow,
  type RawSalesDocument,
} from "../sales-aggregation";
import { buildVatCapabilityReport, formatTaxRateRow, listTaxRatesForMcp } from "../tax-info";

function boundedDates(fromDate?: string, toDate?: string): { fromDate: string; toDate: string } {
  const to = toDate ? new Date(toDate) : new Date();
  const from = fromDate
    ? new Date(fromDate)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const maxDays = XERO_DATA_BOUNDS.maxDateRangeDays * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxDays) {
    return {
      fromDate: new Date(to.getTime() - maxDays).toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
    };
  }
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

function maxPaginationRecords(): number {
  return XERO_DATA_BOUNDS.maxPaginationRecords;
}

function maxFetchPages(): number {
  return Math.ceil(maxPaginationRecords() / XERO_API_PAGE_SIZE);
}

function clampReadLimit(limit?: number): number {
  const value = limit ?? XERO_DATA_BOUNDS.defaultListResults;
  return Math.min(Math.max(1, value), XERO_DATA_BOUNDS.maxListResults);
}

function normalizePaymentDirection(
  direction?: string,
): PaymentDirection | "all" {
  const value = String(direction ?? "all")
    .trim()
    .toLowerCase();
  if (value === "customer_receipt" || value === "supplier_payment") return value;
  return "all";
}

function postFilterInvoices(
  invoices: Record<string, unknown>[],
  input: {
    query?: string;
    status?: string;
    contactId?: string;
    overdueOnly?: boolean;
    unpaidOnly?: boolean;
    invoiceType?: InvoiceDocumentType;
    effectiveDate?: string;
  },
): Record<string, unknown>[] {
  const effective = resolveEffectiveDate(input.effectiveDate);
  const invoiceType = normalizeInvoiceTypeFilter(input.invoiceType);
  let filtered = filterInvoicesByType(invoices, invoiceType);

  if (input.contactId) {
    filtered = filtered.filter((invoice) => {
      const contact = invoice.Contact as Record<string, unknown> | undefined;
      return String(contact?.ContactID ?? "") === input.contactId;
    });
  }

  if (input.status) {
    const status = input.status.trim().toUpperCase();
    filtered = filtered.filter(
      (invoice) => String(invoice.Status ?? "").trim().toUpperCase() === status,
    );
  }

  if (input.query?.trim()) {
    const query = input.query.trim().toLowerCase();
    filtered = filtered.filter((invoice) =>
      String(invoice.InvoiceNumber ?? "")
        .toLowerCase()
        .includes(query),
    );
  }

  if (input.unpaidOnly) {
    filtered = filtered.filter((invoice) => invoiceHasOutstandingBalance(invoice));
  }

  if (input.overdueOnly) {
    filtered = filtered.filter((invoice) => isOverdueSalesInvoice(invoice, effective));
  }

  return filtered;
}

function buildInvoiceSearchWhere(input: {
  query?: string;
  status?: string;
  contactId?: string;
  fromDate?: string;
  toDate?: string;
  invoiceType?: InvoiceDocumentType;
}): string | undefined {
  const clauses: string[] = [];
  const typeClause = invoiceTypeWhereClause(normalizeInvoiceTypeFilter(input.invoiceType));
  if (typeClause) clauses.push(typeClause);
  if (input.contactId) clauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.query) clauses.push(`InvoiceNumber.Contains("${input.query.replace(/"/g, "")}")`);
  const dates = boundedDates(input.fromDate, input.toDate);
  clauses.push(`Date>=${toXeroDateTimeClause(dates.fromDate)}`);
  if (input.toDate) {
    clauses.push(`Date<=${toXeroDateTimeClause(dates.toDate)}`);
  }
  return clauses.length ? clauses.join(" AND ") : undefined;
}

export async function getOrganisation(client: XeroClient) {
  const body = await client.get<{ Organisations?: unknown[] }>("/Organisation");
  return { organisation: body.Organisations?.[0] ?? null };
}

async function resolveBaseCurrency(client: XeroClient): Promise<string | null> {
  const body = await client.get<{ Organisations?: Array<{ BaseCurrency?: string }> }>(
    "/Organisation",
  );
  return body.Organisations?.[0]?.BaseCurrency ?? null;
}

async function resolveBaseCurrencyWithFetch(config: XeroFetchConfig): Promise<string | null> {
  const body = await xeroGetJson<{ Organisations?: Array<{ BaseCurrency?: string }> }>(
    config,
    "/Organisation",
  );
  return body.Organisations?.[0]?.BaseCurrency ?? null;
}

function clampContactLimit(limit?: number): number {
  const value = limit ?? XERO_DATA_BOUNDS.defaultListResults;
  return Math.min(Math.max(1, value), XERO_DATA_BOUNDS.maxListResults);
}

function buildContactWhere(input: { query?: string; contactType?: string }): string | undefined {
  const clauses: string[] = [];
  if (input.query?.trim()) {
    clauses.push(`Name.Contains("${input.query.trim().replace(/"/g, "")}")`);
  }
  const type = input.contactType?.trim().toLowerCase();
  if (type === "customer") {
    clauses.push("IsCustomer==true");
  } else if (type === "supplier") {
    clauses.push("IsSupplier==true");
  } else if (input.contactType?.trim()) {
    clauses.push('ContactStatus=="ACTIVE"');
  }
  return clauses.length ? clauses.join(" AND ") : undefined;
}

function refineContactsByQuery<T extends { Name?: string }>(
  contacts: T[],
  query?: string,
): T[] {
  const q = query?.trim().toLowerCase();
  if (!q) return contacts;
  return contacts.filter((contact) => {
    const name = String(contact.Name ?? "").toLowerCase();
    if (!name) return false;
    if (name === q || name.includes(q)) return true;
    return name.split(/\s+/).some((word) => word.startsWith(q));
  });
}

async function fetchContactsPage(
  config: XeroFetchConfig,
  where?: string,
): Promise<Array<{ Name?: string }>> {
  const body = await xeroGetJson<{ Contacts?: Array<{ Name?: string }> }>(config, "/Contacts", {
    where,
    page: 1,
  });
  return body.Contacts ?? [];
}

async function searchContactsWithFallback(
  config: XeroFetchConfig,
  input: { query?: string; contactType?: string; limit?: number },
): Promise<Array<{ Name?: string }>> {
  const limit = clampContactLimit(input.limit);
  const query = input.query?.trim();
  const where = buildContactWhere(input);

  if (!query) {
    return (await fetchContactsPage(config, where)).slice(0, limit);
  }

  let contacts = refineContactsByQuery(await fetchContactsPage(config, where), query);
  if (contacts.length > 0) {
    return contacts.slice(0, limit);
  }

  const upperWhere = buildContactWhere({ ...input, query: query.toUpperCase() });
  contacts = refineContactsByQuery(await fetchContactsPage(config, upperWhere), query);
  if (contacts.length > 0) {
    return contacts.slice(0, limit);
  }

  const typeOnlyWhere = buildContactWhere({ contactType: input.contactType });
  contacts = refineContactsByQuery(await fetchContactsPage(config, typeOnlyWhere), query);
  return contacts.slice(0, limit);
}

export async function listContactsWithFetch(
  config: XeroFetchConfig,
  input: { query?: string; contactType?: string; limit?: number },
) {
  const contacts = await searchContactsWithFallback(config, input);
  return { contacts };
}

export async function getContactWithFetch(
  config: XeroFetchConfig,
  input: { contactId: string },
) {
  const body = await xeroGetJson<{ Contacts?: unknown[] }>(config, `/Contacts/${input.contactId}`);
  return { contact: body.Contacts?.[0] ?? null };
}

export async function listAccountsWithFetch(
  config: XeroFetchConfig,
  input: { accountType?: string },
) {
  const body = await xeroGetJson<{ Accounts?: unknown[] }>(config, "/Accounts", {
    where: input.accountType ? `Type=="${input.accountType}"` : undefined,
  });
  return { accounts: body.Accounts ?? [] };
}

export async function searchInvoicesWithFetch(
  config: XeroFetchConfig,
  input: {
    query?: string;
    status?: string;
    contactId?: string;
    overdueOnly?: boolean;
    unpaidOnly?: boolean;
    fromDate?: string;
    toDate?: string;
    invoiceType?: string;
    effectiveDate?: string;
    limit?: number;
  },
) {
  const effectiveDate = resolveEffectiveDate(input.effectiveDate);
  const invoiceType = normalizeInvoiceTypeFilter(input.invoiceType);
  const where = buildInvoiceSearchWhere({ ...input, invoiceType });
  const { rows, meta } = await fetchAllPagedWithConfig<Record<string, unknown>>(
    config,
    "/Invoices",
    "Invoices",
    where,
    maxPaginationRecords(),
  );
  const filtered = postFilterInvoices(rows, {
    ...input,
    invoiceType,
    effectiveDate,
  });
  const target = clampReadLimit(input.limit);
  const invoices = filtered
    .slice(0, target)
    .map((invoice) => formatInvoiceSummary(invoice, effectiveDate));
  const truncated = filtered.length > target || meta.truncated;
  return {
    invoices,
    effectiveDate,
    meta: {
      ...meta,
      returned: invoices.length,
      truncated,
      message: truncated
        ? meta.message ??
          `Results truncated to ${target} invoices (safety limit). Narrow the date range or filters for complete coverage.`
        : undefined,
    },
  };
}

export async function getInvoiceWithFetch(
  config: XeroFetchConfig,
  input: { invoiceId?: string; invoiceNumber?: string },
) {
  if (input.invoiceId) {
    const body = await xeroGetJson<{ Invoices?: unknown[] }>(
      config,
      `/Invoices/${input.invoiceId}`,
    );
    return { invoice: body.Invoices?.[0] ?? null };
  }
  if (input.invoiceNumber) {
    const found = await searchInvoicesWithFetch(config, {
      query: input.invoiceNumber,
      limit: 5,
    });
    const match = found.invoices.find((row) => row.invoiceNumber === input.invoiceNumber);
    return { invoice: match ?? found.invoices[0] ?? null };
  }
  return { invoice: null, error: "Provide invoiceId or invoiceNumber." };
}

export async function listOverdueInvoicesWithFetch(
  config: XeroFetchConfig,
  input: { contactId?: string; effectiveDate?: string; limit?: number },
) {
  const effectiveDate = resolveEffectiveDate(input.effectiveDate);
  const where = [
    buildOutstandingSalesInvoiceWhere({ contactId: input.contactId }),
    `DueDate<${toXeroDateTimeClause(effectiveDate)}`,
  ].join(" AND ");
  const { rows, meta } = await fetchAllPagedWithConfig<Record<string, unknown>>(
    config,
    "/Invoices",
    "Invoices",
    where,
    maxPaginationRecords(),
  );
  const overdue = sortOverdueInvoices(
    rows
      .filter((invoice) => isOverdueSalesInvoice(invoice, effectiveDate))
      .map((invoice) => formatInvoiceSummary(invoice, effectiveDate)),
  );
  const target = clampReadLimit(input.limit);
  const invoices = overdue.slice(0, target);
  const truncated = overdue.length > target || meta.truncated;
  return {
    invoices,
    effectiveDate,
    meta: {
      ...meta,
      returned: invoices.length,
      truncated,
      message: truncated
        ? meta.message ??
          `Results truncated to ${target} overdue invoices (safety limit).`
        : undefined,
    },
  };
}

export async function listPaymentsWithFetch(
  config: XeroFetchConfig,
  input: {
    since?: string;
    toDate?: string;
    direction?: string;
    limit?: number;
  },
) {
  const dates = boundedDates(input.since, input.toDate);
  const where = buildPaymentDateWhere(dates.fromDate, dates.toDate);
  const { rows, meta } = await fetchAllPagedWithConfig<Record<string, unknown>>(
    config,
    "/Payments",
    "Payments",
    where,
    maxPaginationRecords(),
  );
  let filtered = filterPaymentsByTransactionDate(rows, dates.fromDate, dates.toDate);
  const direction = normalizePaymentDirection(input.direction);
  if (direction !== "all") {
    filtered = filterPaymentsByDirection(filtered, direction);
  }
  const target = clampReadLimit(input.limit);
  const slice = filtered.slice(0, target);
  return {
    payments: slice.map(formatPaymentSummary),
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    direction,
    totalAmount: sumPaymentAmounts(slice),
    meta: {
      ...meta,
      returned: slice.length,
      truncated: filtered.length > target || meta.truncated,
    },
  };
}

export async function listBankTransactionsWithFetch(
  config: XeroFetchConfig,
  input: { since?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.since, input.toDate);
  const body = await xeroGetJson<{ BankTransactions?: unknown[] }>(config, "/BankTransactions", {
    where: `Date>=${toXeroDateTimeClause(dates.fromDate)}`,
    page: 1,
  });
  return {
    bankTransactions: (body.BankTransactions ?? []).slice(0, clampReadLimit(input.limit)),
  };
}

export async function balanceSheetWithFetch(
  config: XeroFetchConfig,
  input: { date?: string },
) {
  const report = await xeroGetJson(config, "/Reports/BalanceSheet", {
    date: input.date ?? new Date().toISOString().slice(0, 10),
  });
  return { report };
}

export async function agedReceivablesWithFetch(
  config: XeroFetchConfig,
  input: { reportType?: string; date?: string; contactId?: string },
) {
  const effectiveDate = resolveEffectiveDate(input.date);
  const reportType = input.reportType === "payables" ? "payables" : "receivables";
  const expectedType = reportType === "receivables" ? "ACCREC" : "ACCPAY";
  const whereClauses = [`Type=="${expectedType}"`, "AmountDue>0"];
  if (input.contactId) {
    whereClauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  }
  const { rows, meta } = await fetchAllPagedWithConfig<Record<string, unknown>>(
    config,
    "/Invoices",
    "Invoices",
    whereClauses.join(" AND "),
    maxPaginationRecords(),
  );
  const currencyCode = await resolveBaseCurrencyWithFetch(config);
  const report = computeAgeingFromInvoices({
    invoices: rows,
    reportType,
    effectiveDate,
    currencyCode,
  });
  return {
    report,
    byContact: groupAgeingByContact(report.lines),
    effectiveDate,
    meta,
  };
}

export async function topSuppliersWithFetch(
  config: XeroFetchConfig,
  input: { fromDate?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.fromDate, input.toDate);
  const where = [
    'Type=="ACCPAY"',
    `Date>=${toXeroDateTimeClause(dates.fromDate)}`,
    `Date<=${toXeroDateTimeClause(dates.toDate)}`,
  ].join(" AND ");
  const { rows, meta } = await fetchAllPagedWithConfig<Record<string, unknown>>(
    config,
    "/Invoices",
    "Invoices",
    where,
    maxPaginationRecords(),
  );
  const classified = classifyPurchaseDocuments(rows.map(mapPurchaseInvoiceRow));
  const currencyCode = await resolveBaseCurrencyWithFetch(config);
  const suppliers = aggregateTopSuppliers(classified, clampReadLimit(input.limit ?? 3)).map(
    (supplier) => ({ ...supplier, currencyCode }),
  );
  return {
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    currencyCode,
    suppliers,
    meta,
  };
}

export async function listTaxRatesWithFetch(config: XeroFetchConfig) {
  return listTaxRatesForMcp(config);
}

export async function vatCapabilityWithFetch(config: XeroFetchConfig) {
  const capability = await buildVatCapabilityReport(config);
  return { capability };
}

export async function listContacts(
  client: XeroClient,
  input: { query?: string; contactType?: string; limit?: number },
) {
  const limit = client.clampLimit(input.limit);
  const query = input.query?.trim();
  const where = buildContactWhere(input);
  let contacts = refineContactsByQuery(
    (
      await client.get<{ Contacts?: Array<{ Name?: string }> }>("/Contacts", {
        where,
        page: 1,
      })
    ).Contacts ?? [],
    input.query,
  );

  if (query && contacts.length === 0) {
    const upperWhere = buildContactWhere({ ...input, query: query.toUpperCase() });
    contacts = refineContactsByQuery(
      (
        await client.get<{ Contacts?: Array<{ Name?: string }> }>("/Contacts", {
          where: upperWhere,
          page: 1,
        })
      ).Contacts ?? [],
      input.query,
    );
  }

  if (query && contacts.length === 0) {
    const typeOnlyWhere = buildContactWhere({ contactType: input.contactType });
    contacts = refineContactsByQuery(
      (
        await client.get<{ Contacts?: Array<{ Name?: string }> }>("/Contacts", {
          where: typeOnlyWhere,
          page: 1,
        })
      ).Contacts ?? [],
      input.query,
    );
  }

  return { contacts: contacts.slice(0, limit) };
}

export async function getContact(client: XeroClient, input: { contactId: string }) {
  const body = await client.get<{ Contacts?: unknown[] }>(`/Contacts/${input.contactId}`);
  return { contact: body.Contacts?.[0] ?? null };
}

export async function searchInvoices(
  client: XeroClient,
  input: {
    query?: string;
    status?: string;
    contactId?: string;
    overdueOnly?: boolean;
    unpaidOnly?: boolean;
    fromDate?: string;
    toDate?: string;
    invoiceType?: string;
    effectiveDate?: string;
    limit?: number;
  },
) {
  const effectiveDate = resolveEffectiveDate(input.effectiveDate);
  const invoiceType = normalizeInvoiceTypeFilter(input.invoiceType);
  const where = buildInvoiceSearchWhere({ ...input, invoiceType });
  const rows = await fetchPaged<Record<string, unknown>>(
    client,
    "/Invoices",
    "Invoices",
    where ?? "",
    maxPaginationRecords(),
  );
  const filtered = postFilterInvoices(rows, {
    ...input,
    invoiceType,
    effectiveDate,
  });
  const target = client.clampLimit(input.limit);
  const invoices = filtered
    .slice(0, target)
    .map((invoice) => formatInvoiceSummary(invoice, effectiveDate));
  const truncated = filtered.length > target;
  return {
    invoices,
    effectiveDate,
    meta: {
      returned: invoices.length,
      truncated,
      message: truncated
        ? `Results truncated to ${target} invoices (safety limit). Narrow the date range or filters for complete coverage.`
        : undefined,
    },
  };
}

export async function getInvoice(
  client: XeroClient,
  input: { invoiceId?: string; invoiceNumber?: string },
) {
  if (input.invoiceId) {
    const body = await client.get<{ Invoices?: unknown[] }>(`/Invoices/${input.invoiceId}`);
    return { invoice: body.Invoices?.[0] ?? null };
  }
  if (input.invoiceNumber) {
    const found = await searchInvoices(client, {
      query: input.invoiceNumber,
      limit: 5,
    });
    const match = found.invoices.find((row) => row.invoiceNumber === input.invoiceNumber);
    return { invoice: match ?? found.invoices[0] ?? null };
  }
  return { invoice: null, error: "Provide invoiceId or invoiceNumber." };
}

export async function listOverdueInvoices(
  client: XeroClient,
  input: { contactId?: string; effectiveDate?: string; limit?: number },
) {
  const effectiveDate = resolveEffectiveDate(input.effectiveDate);
  const where = [
    buildOutstandingSalesInvoiceWhere({ contactId: input.contactId }),
    `DueDate<${toXeroDateTimeClause(effectiveDate)}`,
  ].join(" AND ");
  const rows = await fetchPaged<Record<string, unknown>>(
    client,
    "/Invoices",
    "Invoices",
    where,
    maxPaginationRecords(),
  );
  const overdue = sortOverdueInvoices(
    rows
      .filter((invoice) => isOverdueSalesInvoice(invoice, effectiveDate))
      .map((invoice) => formatInvoiceSummary(invoice, effectiveDate)),
  );
  const target = client.clampLimit(input.limit);
  const invoices = overdue.slice(0, target);
  return {
    invoices,
    effectiveDate,
    meta: {
      returned: invoices.length,
      truncated: overdue.length > target,
    },
  };
}

export async function listPayments(
  client: XeroClient,
  input: {
    since?: string;
    toDate?: string;
    direction?: string;
    limit?: number;
  },
) {
  const dates = boundedDates(input.since, input.toDate);
  const where = buildPaymentDateWhere(dates.fromDate, dates.toDate);
  const rows = await fetchPaged<Record<string, unknown>>(
    client,
    "/Payments",
    "Payments",
    where,
    maxPaginationRecords(),
  );
  let filtered = filterPaymentsByTransactionDate(rows, dates.fromDate, dates.toDate);
  const direction = normalizePaymentDirection(input.direction);
  if (direction !== "all") {
    filtered = filterPaymentsByDirection(filtered, direction);
  }
  const target = client.clampLimit(input.limit);
  const slice = filtered.slice(0, target);
  return {
    payments: slice.map(formatPaymentSummary),
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    direction,
    totalAmount: sumPaymentAmounts(slice),
    meta: {
      returned: slice.length,
      truncated: filtered.length > target,
    },
  };
}

export async function listAccounts(client: XeroClient, input: { accountType?: string }) {
  const body = await client.get<{ Accounts?: unknown[] }>("/Accounts", {
    where: input.accountType ? `Type=="${input.accountType}"` : undefined,
  });
  return { accounts: body.Accounts ?? [] };
}

export async function listBankTransactions(
  client: XeroClient,
  input: { since?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.since, input.toDate);
  const body = await client.get<{ BankTransactions?: unknown[] }>("/BankTransactions", {
    where: `Date>=${toXeroDateTimeClause(dates.fromDate)}`,
    page: 1,
  });
  return {
    bankTransactions: (body.BankTransactions ?? []).slice(0, client.clampLimit(input.limit)),
  };
}

export async function profitAndLoss(
  client: XeroClient,
  input: {
    fromDate?: string;
    toDate?: string;
    periods?: number;
    timeframe?: "MONTH" | "QUARTER" | "YEAR";
    standardLayout?: boolean;
    paymentsOnly?: boolean;
  },
) {
  const dates = boundedDates(input.fromDate, input.toDate);
  const query = buildProfitAndLossQuery({
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    periods: input.periods,
    timeframe: input.timeframe,
    standardLayout: input.standardLayout,
    paymentsOnly: input.paymentsOnly,
  });
  const reportBody = await client.get<{ Reports?: import("../reports/profit-and-loss").XeroReport[] }>(
    "/Reports/ProfitAndLoss",
    query,
  );
  const parsed = parseProfitAndLossReport(reportBody);
  return {
    report: reportBody.Reports?.[0] ?? null,
    parsed,
  };
}

export async function profitAndLossWithFetch(
  config: {
    accessToken: string;
    tenantId: string;
    apiBaseUrl?: string;
    fetchImpl?: typeof fetch;
  },
  input: {
    fromDate?: string;
    toDate?: string;
    periods?: number;
    timeframe?: "MONTH" | "QUARTER" | "YEAR";
    standardLayout?: boolean;
    paymentsOnly?: boolean;
  },
): Promise<{ report: unknown; parsed: ParsedProfitAndLoss }> {
  const dates = boundedDates(input.fromDate, input.toDate);
  const query = buildProfitAndLossQuery({
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    periods: input.periods,
    timeframe: input.timeframe,
    standardLayout: input.standardLayout,
    paymentsOnly: input.paymentsOnly,
  });
  const reportBody = await xeroGetJson<{ Reports?: import("../reports/profit-and-loss").XeroReport[] }>(
    config,
    "/Reports/ProfitAndLoss",
    query,
  );
  const parsed = parseProfitAndLossReport(reportBody);
  return {
    report: reportBody.Reports?.[0] ?? null,
    parsed,
  };
}

export async function balanceSheet(client: XeroClient, input: { date?: string }) {
  const report = await client.get("/Reports/BalanceSheet", {
    date: input.date ?? new Date().toISOString().slice(0, 10),
  });
  return { report };
}

export async function agedReceivables(
  client: XeroClient,
  input: { reportType?: string; date?: string; contactId?: string },
) {
  const effectiveDate = resolveEffectiveDate(input.date);
  const reportType = input.reportType === "payables" ? "payables" : "receivables";
  const expectedType = reportType === "receivables" ? "ACCREC" : "ACCPAY";
  const whereClauses = [`Type=="${expectedType}"`, "AmountDue>0"];
  if (input.contactId) {
    whereClauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  }
  const rows = await fetchPaged<Record<string, unknown>>(
    client,
    "/Invoices",
    "Invoices",
    whereClauses.join(" AND "),
    maxPaginationRecords(),
  );
  const currencyCode = await resolveBaseCurrency(client);
  const report = computeAgeingFromInvoices({
    invoices: rows,
    reportType,
    effectiveDate,
    currencyCode,
  });
  return {
    report,
    byContact: groupAgeingByContact(report.lines),
    effectiveDate,
  };
}

export async function topSuppliers(
  client: XeroClient,
  input: { fromDate?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.fromDate, input.toDate);
  const where = [
    'Type=="ACCPAY"',
    `Date>=${toXeroDateTimeClause(dates.fromDate)}`,
    `Date<=${toXeroDateTimeClause(dates.toDate)}`,
  ].join(" AND ");
  const rows = await fetchPaged<Record<string, unknown>>(
    client,
    "/Invoices",
    "Invoices",
    where,
    maxPaginationRecords(),
  );
  const classified = classifyPurchaseDocuments(rows.map(mapPurchaseInvoiceRow));
  const currencyCode = await resolveBaseCurrency(client);
  const suppliers = aggregateTopSuppliers(classified, client.clampLimit(input.limit ?? 3)).map(
    (supplier) => ({ ...supplier, currencyCode }),
  );
  return {
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    currencyCode,
    suppliers,
  };
}

export async function listTaxRates(client: XeroClient) {
  const body = await client.get<{ TaxRates?: Record<string, unknown>[] }>("/TaxRates");
  const taxRates = (body.TaxRates ?? [])
    .filter((row) => String(row.Status ?? "ACTIVE").toUpperCase() === "ACTIVE")
    .map((row) =>
      formatTaxRateRow({
        Name: row.Name as string | undefined,
        TaxType: row.TaxType as string | undefined,
        EffectiveRate: row.EffectiveRate as number | undefined,
        Status: row.Status as string | undefined,
      }),
    );
  return {
    taxRates,
    capability: {
      available: taxRates.length > 0,
      officialVatReturnAccessible: false,
      message:
        taxRates.length > 0
          ? "Transaction-level tax rates are available. INFRA can analyse tax codes on invoices but cannot retrieve the official filed VAT return through the currently available Xero API."
          : "No active tax rates were returned from Xero for this organisation.",
      taxRates,
      limitations: [
        "Official HMRC/filed VAT return data is not exposed via the Xero Accounting API endpoints used by INFRA.",
        "Do not infer an official VAT position from invoice totals alone.",
        "Use xero_profit_and_loss or native Xero reports for accounting income; use xero_sales_summary for customer invoices raised.",
      ],
      semantics: {
        transactionLevelTax:
          "INFRA can list configured tax rates/codes and analyse transaction-level tax on invoices where exposed by Xero.",
        officialVatReturn:
          "The official submitted VAT return is NOT available through the current Xero Accounting API integration.",
      },
    },
  };
}

export async function vatCapability(client: XeroClient) {
  const listed = await listTaxRates(client);
  return { capability: listed.capability };
}

async function fetchPaged<T>(
  client: XeroClient,
  path: string,
  collectionKey: string,
  where: string,
  target: number,
): Promise<T[]> {
  const maxRecords = Math.min(target, maxPaginationRecords());
  const rows: T[] = [];
  let page = 1;
  while (rows.length < maxRecords && page <= maxFetchPages()) {
    const body = await client.get<Record<string, unknown[]>>(path, {
      where: where || undefined,
      page,
    });
    const batch = body[collectionKey] ?? [];
    if (!batch.length) break;
    rows.push(...(batch as T[]));
    if (batch.length < XERO_API_PAGE_SIZE) break;
    page += 1;
  }
  return rows.slice(0, maxRecords);
}

export async function fetchSalesDocumentsInRange(
  client: XeroClient,
  input: { fromDate: string; toDate: string; limit?: number },
): Promise<RawSalesDocument[]> {
  const fromDate = normalizeXeroDate(input.fromDate) ?? input.fromDate;
  const toDate = normalizeXeroDate(input.toDate) ?? input.toDate;
  const where = dateRangeWhere(fromDate, toDate);
  const target = Math.min(
    Math.max(1, input.limit ?? XERO_DATA_BOUNDS.defaultListResults),
    maxPaginationRecords(),
  );
  const perKindLimit = target;
  const invoices = await fetchPaged<Record<string, unknown>>(
    client,
    "/Invoices",
    "Invoices",
    where,
    perKindLimit,
  );
  const creditNotes = await fetchPaged<Record<string, unknown>>(
    client,
    "/CreditNotes",
    "CreditNotes",
    where,
    perKindLimit,
  );
  return [...invoices.map(mapInvoiceRow), ...creditNotes.map(mapCreditNoteRow)];
}

export async function salesSummary(
  client: XeroClient,
  input: { fromDate: string; toDate: string },
) {
  const fromDate = normalizeXeroDate(input.fromDate) ?? input.fromDate;
  const toDate = normalizeXeroDate(input.toDate) ?? input.toDate;
  const raw = await fetchSalesDocumentsInRange(client, {
    fromDate,
    toDate,
    limit: maxPaginationRecords(),
  });
  const classified = classifySalesDocuments(raw);
  const aggregated = aggregateSales(classified);
  const currencyCode = await resolveBaseCurrency(client);
  return {
    currencyCode,
    semantics: SALES_SEMANTICS,
    summary: {
      fromDate,
      toDate,
      transactionCount: aggregated.qualifyingTransactionCount,
      excludedTransactionCount: aggregated.excludedTransactionCount,
      totalSales: aggregated.totalSales,
      currencyCode,
    },
    transactions: aggregated.transactions,
    excludedTransactions: aggregated.excludedTransactions,
  };
}

export async function topCustomers(
  client: XeroClient,
  input: { fromDate?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.fromDate, input.toDate);
  const raw = await fetchSalesDocumentsInRange(client, {
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    limit: maxPaginationRecords(),
  });
  const classified = classifySalesDocuments(raw);
  const customers = aggregateTopCustomers(
    classified,
    client.clampLimit(input.limit ?? 3),
  );
  const currencyCode = await resolveBaseCurrency(client);
  return {
    currencyCode,
    customers: customers.map((customer) => ({ ...customer, currencyCode })),
  };
}
