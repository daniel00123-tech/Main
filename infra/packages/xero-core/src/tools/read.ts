import { XERO_DATA_BOUNDS } from "@infra/shared";
import type { XeroClient } from "../client";
import { xeroGetJson, type XeroFetchConfig } from "../fetch-json";
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

  // Xero Name.Contains is case-sensitive; scan the first page in-memory for natural-language names.
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

function clampReadLimit(limit?: number): number {
  const value = limit ?? XERO_DATA_BOUNDS.defaultListResults;
  return Math.min(Math.max(1, value), XERO_DATA_BOUNDS.maxListResults);
}

function readMaxPages(): number {
  return Math.ceil(XERO_DATA_BOUNDS.maxListResults / XERO_DATA_BOUNDS.defaultListResults);
}

async function fetchPagedCollectionWithConfig<T>(
  config: XeroFetchConfig,
  path: string,
  collectionKey: string,
  where: string | undefined,
  target: number,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  while (rows.length < target && page <= readMaxPages()) {
    const body = await xeroGetJson<Record<string, T[]>>(config, path, { where, page });
    const batch = body[collectionKey] ?? [];
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return rows.slice(0, target);
}

function buildInvoiceSearchWhere(input: {
  query?: string;
  status?: string;
  contactId?: string;
  overdueOnly?: boolean;
  unpaidOnly?: boolean;
  fromDate?: string;
  toDate?: string;
}): string {
  const clauses: string[] = [];
  if (input.contactId) clauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.overdueOnly) clauses.push("AmountDue>0");
  if (input.unpaidOnly) clauses.push('Status=="AUTHORISED"');
  if (input.query) clauses.push(`InvoiceNumber.Contains("${input.query.replace(/"/g, "")}")`);
  const dates = boundedDates(input.fromDate, input.toDate);
  clauses.push(`Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`);
  if (input.toDate) {
    clauses.push(`Date<=DateTime(${dates.toDate.replace(/-/g, ",")})`);
  }
  return clauses.join(" AND ");
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
    limit?: number;
  },
) {
  const target = clampReadLimit(input.limit);
  const where = buildInvoiceSearchWhere(input) || undefined;
  const invoices = await fetchPagedCollectionWithConfig<unknown>(
    config,
    "/Invoices",
    "Invoices",
    where,
    target,
  );
  const truncated = invoices.length >= target;
  return {
    invoices,
    meta: {
      returned: invoices.length,
      truncated,
      message: truncated
        ? `Results truncated to ${target} invoices (safety limit). Narrow the date range or filters for complete coverage.`
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
    const match = (found.invoices as Array<{ InvoiceNumber?: string }>).find(
      (row) => row.InvoiceNumber === input.invoiceNumber,
    );
    return { invoice: match ?? found.invoices[0] ?? null };
  }
  return { invoice: null, error: "Provide invoiceId or invoiceNumber." };
}

export async function listOverdueInvoicesWithFetch(
  config: XeroFetchConfig,
  input: { contactId?: string; limit?: number },
) {
  return searchInvoicesWithFetch(config, { ...input, overdueOnly: true, unpaidOnly: true });
}

export async function listPaymentsWithFetch(
  config: XeroFetchConfig,
  input: { since?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.since, input.toDate);
  const body = await xeroGetJson<{ Payments?: unknown[] }>(config, "/Payments", {
    where: `Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`,
    page: 1,
  });
  return { payments: (body.Payments ?? []).slice(0, clampReadLimit(input.limit)) };
}

export async function listBankTransactionsWithFetch(
  config: XeroFetchConfig,
  input: { since?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.since, input.toDate);
  const body = await xeroGetJson<{ BankTransactions?: unknown[] }>(config, "/BankTransactions", {
    where: `Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`,
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
  input: { reportType?: string; date?: string },
) {
  const path =
    input.reportType === "payables"
      ? "/Reports/AgedPayablesByContact"
      : "/Reports/AgedReceivablesByContact";
  const report = await xeroGetJson(config, path, {
    date: input.date ?? new Date().toISOString().slice(0, 10),
  });
  return { report };
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
    limit?: number;
  },
) {
  const clauses: string[] = [];
  if (input.contactId) clauses.push(`Contact.ContactID=guid("${input.contactId}")`);
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.overdueOnly) clauses.push("AmountDue>0");
  if (input.unpaidOnly) clauses.push('Status=="AUTHORISED"');
  if (input.query) clauses.push(`InvoiceNumber.Contains("${input.query.replace(/"/g, "")}")`);
  const dates = boundedDates(input.fromDate, input.toDate);
  clauses.push(`Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`);
  if (input.toDate) {
    clauses.push(`Date<=DateTime(${dates.toDate.replace(/-/g, ",")})`);
  }
  const target = client.clampLimit(input.limit);
  const invoices: unknown[] = [];
  let page = 1;
  while (invoices.length < target && page <= client.maxPages()) {
    const body = await client.get<{ Invoices?: unknown[] }>("/Invoices", {
      where: clauses.join(" AND ") || undefined,
      page,
    });
    const batch = body.Invoices ?? [];
    if (!batch.length) break;
    invoices.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  const truncated = invoices.length > target;
  return {
    invoices: invoices.slice(0, target),
    meta: {
      returned: Math.min(invoices.length, target),
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
    const match = (found.invoices as Array<{ InvoiceNumber?: string }>).find(
      (row) => row.InvoiceNumber === input.invoiceNumber,
    );
    return { invoice: match ?? found.invoices[0] ?? null };
  }
  return { invoice: null, error: "Provide invoiceId or invoiceNumber." };
}

export async function listOverdueInvoices(
  client: XeroClient,
  input: { contactId?: string; limit?: number },
) {
  return searchInvoices(client, { ...input, overdueOnly: true, unpaidOnly: true });
}

export async function listPayments(
  client: XeroClient,
  input: { since?: string; toDate?: string; limit?: number },
) {
  const dates = boundedDates(input.since, input.toDate);
  const body = await client.get<{ Payments?: unknown[] }>("/Payments", {
    where: `Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`,
    page: 1,
  });
  return { payments: (body.Payments ?? []).slice(0, client.clampLimit(input.limit)) };
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
    where: `Date>=DateTime(${dates.fromDate.replace(/-/g, ",")})`,
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
  input: { reportType?: string; date?: string },
) {
  const path =
    input.reportType === "payables"
      ? "/Reports/AgedPayablesByContact"
      : "/Reports/AgedReceivablesByContact";
  const report = await client.get(path, {
    date: input.date ?? new Date().toISOString().slice(0, 10),
  });
  return { report };
}

async function fetchPaged<T>(
  client: XeroClient,
  path: string,
  collectionKey: string,
  where: string,
  target: number,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  while (rows.length < target && page <= client.maxPages()) {
    const body = await client.get<Record<string, unknown[]>>(path, { where, page });
    const batch = body[collectionKey] ?? [];
    if (!batch.length) break;
    rows.push(...(batch as T[]));
    if (batch.length < 100) break;
    page += 1;
  }
  return rows.slice(0, target);
}

export async function fetchSalesDocumentsInRange(
  client: XeroClient,
  input: { fromDate: string; toDate: string; limit?: number },
): Promise<RawSalesDocument[]> {
  const dates = boundedDates(input.fromDate, input.toDate);
  const where = dateRangeWhere(dates.fromDate, dates.toDate);
  const target = Math.min(
    Math.max(1, input.limit ?? XERO_DATA_BOUNDS.defaultListResults),
    XERO_DATA_BOUNDS.maxListResults,
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
  return [
    ...invoices.map(mapInvoiceRow),
    ...creditNotes.map(mapCreditNoteRow),
  ];
}

export async function salesSummary(
  client: XeroClient,
  input: { fromDate: string; toDate: string },
) {
  const raw = await fetchSalesDocumentsInRange(client, {
    fromDate: input.fromDate,
    toDate: input.toDate,
    limit: XERO_DATA_BOUNDS.maxListResults,
  });
  const classified = classifySalesDocuments(raw);
  const aggregated = aggregateSales(classified);
  const currencyCode = await resolveBaseCurrency(client);
  return {
    currencyCode,
    summary: {
      fromDate: input.fromDate,
      toDate: input.toDate,
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
    limit: XERO_DATA_BOUNDS.maxListResults,
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
