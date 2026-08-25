import { XERO_DATA_BOUNDS } from "@infra/shared";
import type { XeroClient } from "../client";
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

export async function listContacts(
  client: XeroClient,
  input: { query?: string; contactType?: string; limit?: number },
) {
  const where = [
    input.query ? `Name.Contains("${input.query.replace(/"/g, "")}")` : null,
    input.contactType ? `ContactStatus=="ACTIVE"` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
  const body = await client.get<{ Contacts?: unknown[] }>("/Contacts", {
    where: where || undefined,
    page: 1,
  });
  const contacts = (body.Contacts ?? []).slice(0, client.clampLimit(input.limit));
  return { contacts };
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
  input: { fromDate?: string; toDate?: string },
) {
  const dates = boundedDates(input.fromDate, input.toDate);
  const report = await client.get("/Reports/ProfitAndLoss", {
    fromDate: dates.fromDate,
    toDate: dates.toDate,
  });
  return { report };
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
