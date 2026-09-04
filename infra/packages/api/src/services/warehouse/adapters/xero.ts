/**
 * EL Xero warehouse adapter — first production connector.
 * Read-only. Uses existing INFRA Xero token path. No writes. No new scopes.
 */

import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";
import {
  classifySalesDocument,
  mapCreditNoteRow,
  mapInvoiceRow,
  normalizeXeroDate,
  xeroGetJson,
  type XeroFetchConfig,
} from "@infra/xero-core";
import { getZonedParts } from "../../automation-engine/schedule";
import type { Env } from "../../../env";
import { getValidXeroAccessToken } from "../../xero";
import { prepareXeroMcpExecution } from "../../xero-tools";
import { getConnectorInstance } from "../../control-plane";
import { executeXeroReadToolOnInfra } from "../../xero-read-execution";
import {
  WAREHOUSE_MAX_PAGES,
  WAREHOUSE_PAGE_SIZE,
  WAREHOUSE_RECONCILE_ABS_TOLERANCE,
  WAREHOUSE_TIMEZONE,
  WAREHOUSE_XERO_CONNECTOR,
  type WarehouseCheckpoint,
  type WarehouseXeroContact,
  type WarehouseXeroCreditNote,
  type WarehouseXeroInvoice,
  type WarehouseXeroInvoiceLine,
  type WarehouseXeroPayment,
} from "../standard";
import type { WarehouseConnectorAdapter, WarehouseExtract, WarehouseLiveTotals } from "./types";

const INACTIVE_STATUSES = new Set(["VOIDED", "DELETED"]);

export function parseXeroTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const dotnet = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(raw);
  if (dotnet) {
    const ms = Number(dotnet[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return new Date(raw).toISOString();
  const dateOnly = normalizeXeroDate(raw);
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : null;
}

export function financialYearWindow(
  org: { FinancialYearEndDay?: number; FinancialYearEndMonth?: number } | null,
  now: Date,
): { historicalFrom: string; historicalTo: string; currentFyStart: string } {
  const parts = getZonedParts(now, WAREHOUSE_TIMEZONE);
  const endMonth = Number(org?.FinancialYearEndMonth ?? 12);
  const endDay = Number(org?.FinancialYearEndDay ?? 31);
  let fyEndYear = parts.year;
  const fyEndThisYear = new Date(Date.UTC(parts.year, endMonth - 1, endDay));
  const today = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (today <= fyEndThisYear) fyEndYear = parts.year;
  else fyEndYear = parts.year + 1;
  const currentFyEnd = new Date(Date.UTC(fyEndYear, endMonth - 1, endDay));
  const currentFyStart = new Date(currentFyEnd.getTime() + 24 * 60 * 60 * 1000);
  currentFyStart.setUTCFullYear(currentFyStart.getUTCFullYear() - 1);
  const priorFyStart = new Date(currentFyStart.getTime());
  priorFyStart.setUTCFullYear(priorFyStart.getUTCFullYear() - 1);
  return {
    historicalFrom: priorFyStart.toISOString().slice(0, 10),
    historicalTo: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    currentFyStart: currentFyStart.toISOString().slice(0, 10),
  };
}

export function londonDateParts(now: Date): { year: number; month: number; day: number; today: string; monthStart: string } {
  const parts = getZonedParts(now, WAREHOUSE_TIMEZONE);
  const today = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const monthStart = `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
  return { year: parts.year, month: parts.month, day: parts.day, today, monthStart };
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCurrentStatus(status: string | null | undefined): boolean {
  return !INACTIVE_STATUSES.has(String(status ?? "").toUpperCase());
}

export function normaliseInvoice(
  companyId: string,
  raw: Record<string, unknown>,
  nowIso: string,
): { invoice: WarehouseXeroInvoice; lines: WarehouseXeroInvoiceLine[] } {
  const contact = (raw.Contact as Record<string, unknown> | undefined) ?? {};
  const status = raw.Status ? String(raw.Status) : null;
  const invoice: WarehouseXeroInvoice = {
    companyId,
    invoiceId: String(raw.InvoiceID ?? ""),
    invoiceNumber: raw.InvoiceNumber ? String(raw.InvoiceNumber) : null,
    type: raw.Type ? String(raw.Type) : null,
    contactId: contact.ContactID ? String(contact.ContactID) : null,
    contactName: contact.Name ? String(contact.Name) : null,
    status,
    invoiceDate: normalizeXeroDate(raw.Date),
    dueDate: normalizeXeroDate(raw.DueDate),
    reference: raw.Reference ? String(raw.Reference) : null,
    currency: raw.CurrencyCode ? String(raw.CurrencyCode) : null,
    subtotal: num(raw.SubTotal),
    tax: num(raw.TotalTax),
    total: num(raw.Total),
    amountDue: num(raw.AmountDue),
    amountPaid: num(raw.AmountPaid),
    amountCredited: num(raw.AmountCredited),
    sourceUpdatedAt: parseXeroTimestamp(raw.UpdatedDateUTC),
    warehouseUpdatedAt: nowIso,
    isCurrent: isCurrentStatus(status),
  };
  const rawLines = Array.isArray(raw.LineItems) ? (raw.LineItems as Record<string, unknown>[]) : [];
  const lines = rawLines
    .map((line, index) => ({
      companyId,
      invoiceId: invoice.invoiceId,
      lineId: String(line.LineItemID ?? `${invoice.invoiceId}:${index}`),
      description: line.Description ? String(line.Description) : null,
      quantity: num(line.Quantity),
      unitAmount: num(line.UnitAmount),
      tax: num(line.TaxAmount),
      lineTotal: num(line.LineAmount),
      accountCode: line.AccountCode ? String(line.AccountCode) : null,
      warehouseUpdatedAt: nowIso,
    }))
    .filter((line) => line.invoiceId);
  return { invoice, lines };
}

export function normaliseContact(companyId: string, raw: Record<string, unknown>, nowIso: string): WarehouseXeroContact {
  const status = raw.ContactStatus ? String(raw.ContactStatus) : null;
  return {
    companyId,
    contactId: String(raw.ContactID ?? ""),
    displayName: raw.Name ? String(raw.Name) : null,
    status,
    isCustomer: raw.IsCustomer == null ? null : Boolean(raw.IsCustomer),
    isSupplier: raw.IsSupplier == null ? null : Boolean(raw.IsSupplier),
    accountNumber: raw.AccountNumber ? String(raw.AccountNumber) : null,
    sourceUpdatedAt: parseXeroTimestamp(raw.UpdatedDateUTC),
    warehouseUpdatedAt: nowIso,
    isCurrent: String(status ?? "ACTIVE").toUpperCase() !== "ARCHIVED",
  };
}

export function normalisePayment(companyId: string, raw: Record<string, unknown>, nowIso: string): WarehouseXeroPayment {
  const invoice = (raw.Invoice as Record<string, unknown> | undefined) ?? {};
  const status = raw.Status ? String(raw.Status) : null;
  return {
    companyId,
    paymentId: String(raw.PaymentID ?? ""),
    invoiceId: invoice.InvoiceID ? String(invoice.InvoiceID) : null,
    paymentDate: normalizeXeroDate(raw.Date),
    amount: num(raw.Amount),
    status,
    paymentType: raw.PaymentType ? String(raw.PaymentType) : null,
    reference: raw.Reference ? String(raw.Reference) : null,
    sourceUpdatedAt: parseXeroTimestamp(raw.UpdatedDateUTC),
    warehouseUpdatedAt: nowIso,
    isCurrent: isCurrentStatus(status),
  };
}

export function normaliseCreditNote(
  companyId: string,
  raw: Record<string, unknown>,
  nowIso: string,
): WarehouseXeroCreditNote {
  const contact = (raw.Contact as Record<string, unknown> | undefined) ?? {};
  const status = raw.Status ? String(raw.Status) : null;
  return {
    companyId,
    creditNoteId: String(raw.CreditNoteID ?? ""),
    creditNoteNumber: raw.CreditNoteNumber ? String(raw.CreditNoteNumber) : null,
    type: raw.Type ? String(raw.Type) : null,
    contactId: contact.ContactID ? String(contact.ContactID) : null,
    contactName: contact.Name ? String(contact.Name) : null,
    status,
    creditDate: normalizeXeroDate(raw.Date),
    reference: raw.Reference ? String(raw.Reference) : null,
    currency: raw.CurrencyCode ? String(raw.CurrencyCode) : null,
    subtotal: num(raw.SubTotal),
    tax: num(raw.TotalTax),
    total: num(raw.Total),
    remainingCredit: num(raw.RemainingCredit),
    sourceUpdatedAt: parseXeroTimestamp(raw.UpdatedDateUTC),
    warehouseUpdatedAt: nowIso,
    isCurrent: isCurrentStatus(status),
  };
}

export function computeWarehouseSalesMetrics(
  invoices: WarehouseXeroInvoice[],
  creditNotes: WarehouseXeroCreditNote[],
  asOf: { today: string; monthStart: string },
) {
  const docs = [
    ...invoices.map((row) =>
      classifySalesDocument(
        mapInvoiceRow({
          InvoiceID: row.invoiceId,
          InvoiceNumber: row.invoiceNumber,
          Type: row.type,
          Status: row.status,
          Date: row.invoiceDate,
          Total: row.total,
          Contact: { ContactID: row.contactId, Name: row.contactName },
        }),
      ),
    ),
    ...creditNotes.map((row) =>
      classifySalesDocument(
        mapCreditNoteRow({
          CreditNoteID: row.creditNoteId,
          CreditNoteNumber: row.creditNoteNumber,
          Type: row.type,
          Status: row.status,
          Date: row.creditDate,
          Total: row.total,
          Contact: { ContactID: row.contactId, Name: row.contactName },
        }),
      ),
    ),
  ];
  const inMonth = docs.filter(
    (doc) => doc.qualifiesForSales && doc.date && doc.date >= asOf.monthStart && doc.date <= asOf.today,
  );
  const today = inMonth.filter((doc) => doc.date === asOf.today);
  const salesInvoices = invoices.filter(
    (row) =>
      row.type === "ACCREC" &&
      row.isCurrent &&
      !INACTIVE_STATUSES.has(String(row.status ?? "")) &&
      row.status !== "DRAFT" &&
      row.status !== "SUBMITTED",
  );
  const outstanding = salesInvoices.reduce((sum, row) => sum + (row.amountDue ?? 0), 0);
  const overdueInvoices = salesInvoices.filter(
    (row) => (row.amountDue ?? 0) > 0 && row.dueDate && row.dueDate < asOf.today,
  );
  const overdue = overdueInvoices.reduce((sum, row) => sum + (row.amountDue ?? 0), 0);
  const paidMtd = salesInvoices
    .filter((row) => row.invoiceDate && row.invoiceDate >= asOf.monthStart && row.invoiceDate <= asOf.today)
    .reduce((sum, row) => sum + (row.amountPaid ?? 0), 0);
  const customers = new Map<string, { contactId: string; name: string; total: number }>();
  for (const doc of inMonth) {
    if (doc.salesContribution <= 0) continue;
    const id = doc.contactId ?? "unknown";
    const current = customers.get(id) ?? { contactId: id, name: doc.contactName, total: 0 };
    current.total += doc.salesContribution;
    customers.set(id, current);
  }
  return {
    salesMtd: inMonth.reduce((sum, doc) => sum + doc.salesContribution, 0),
    salesToday: today.reduce((sum, doc) => sum + doc.salesContribution, 0),
    invoiceCountMtd: inMonth.filter((doc) => doc.documentKind === "invoice").length,
    outstanding,
    overdue,
    overdueCount: overdueInvoices.length,
    paidMtd,
    topCustomers: [...customers.values()].sort((a, b) => b.total - a.total).slice(0, 5),
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPaged(
  config: XeroFetchConfig,
  path: string,
  collectionKey: string,
  query: Record<string, string | number | undefined>,
  extraHeaders?: Record<string, string>,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; pages: number }> {
  const rows: Record<string, unknown>[] = [];
  let page = 1;
  let truncated = false;
  while (page <= WAREHOUSE_MAX_PAGES) {
    let attempt = 0;
    let body: Record<string, Record<string, unknown>[]> | null = null;
    while (attempt < 3) {
      try {
        body = await xeroGetJson<Record<string, Record<string, unknown>[]>>(
          config,
          path,
          { ...query, page, unitdp: 4 },
          extraHeaders ? { headers: extraHeaders } : undefined,
        );
        break;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429 && attempt < 2) {
          await sleep(400 * (attempt + 1));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
    const batch = body?.[collectionKey] ?? [];
    rows.push(...batch);
    if (batch.length < WAREHOUSE_PAGE_SIZE) break;
    if (page === WAREHOUSE_MAX_PAGES && batch.length >= WAREHOUSE_PAGE_SIZE) truncated = true;
    page += 1;
  }
  return { rows, truncated, pages: page };
}

export function ifModifiedSinceHeader(iso: string | null | undefined): Record<string, string> | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  const skewed = new Date(parsed - 120_000);
  return { "If-Modified-Since": skewed.toUTCString() };
}

export async function extractXeroWarehouse(input: {
  env: Env;
  companyId: string;
  checkpoint: WarehouseCheckpoint | null;
  now: Date;
  trigger: "scheduled" | "backfill" | "manual";
}): Promise<WarehouseExtract> {
  const prepared = await prepareXeroMcpExecution({
    env: input.env,
    companyId: input.companyId,
    toolName: "xero_search_invoices",
  });
  if (!prepared.ok) {
    throw Object.assign(new Error(prepared.body.error), { code: prepared.body.code ?? "WAREHOUSE_XERO_UNAVAILABLE" });
  }
  const instance = await getConnectorInstance(input.env.DB, prepared.instanceId);
  if (!instance?.credentialRefId) {
    throw Object.assign(new Error("INFRA-native Xero credentials required for warehouse sync"), {
      code: "WAREHOUSE_XERO_UNAVAILABLE",
    });
  }
  const token = await getValidXeroAccessToken({
    env: input.env,
    companyId: input.companyId,
    instanceId: prepared.instanceId,
    actor: "system:warehouse",
    reason: "mcp_resolve",
  });
  if (!token.ok) {
    throw Object.assign(new Error(token.body.error), { code: token.body.code ?? "WAREHOUSE_XERO_UNAVAILABLE" });
  }
  const config: XeroFetchConfig = {
    accessToken: token.accessToken,
    tenantId: token.tenantId,
    apiBaseUrl: XERO_AUTH.apiBaseUrl,
    fetchImpl: fetch,
  };
  const nowIso = input.now.toISOString();
  const orgBody = await xeroGetJson<{ Organisations?: Array<Record<string, unknown>> }>(config, "/Organisation");
  const org = orgBody.Organisations?.[0] ?? null;
  const fy = financialYearWindow(org, input.now);
  const backfill = input.trigger === "backfill" || !input.checkpoint?.sourceTimestamp;
  const modified = backfill ? undefined : ifModifiedSinceHeader(input.checkpoint?.sourceTimestamp);
  const invoiceWhere = backfill
    ? `Date>=DateTime(${fy.historicalFrom.replace(/-/g, ",")})`
    : undefined;
  const invoiceQuery: Record<string, string | number | undefined> = {
    where: invoiceWhere,
    statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED",
  };
  const [invoicesPage, creditPage, contactPage, paymentPage] = await Promise.all([
    fetchPaged(config, "/Invoices", "Invoices", invoiceQuery, modified),
    fetchPaged(
      config,
      "/CreditNotes",
      "CreditNotes",
      backfill ? { where: `Date>=DateTime(${fy.historicalFrom.replace(/-/g, ",")})` } : {},
      modified,
    ),
    fetchPaged(config, "/Contacts", "Contacts", { includeArchived: "true" }, modified),
    fetchPaged(
      config,
      "/Payments",
      "Payments",
      backfill ? { where: `Date>=DateTime(${fy.historicalFrom.replace(/-/g, ",")})` } : {},
      modified,
    ),
  ]);

  const invoices: WarehouseXeroInvoice[] = [];
  const invoiceLines: WarehouseXeroInvoiceLine[] = [];
  for (const raw of invoicesPage.rows) {
    const mapped = normaliseInvoice(input.companyId, raw, nowIso);
    if (!mapped.invoice.invoiceId) continue;
    invoices.push(mapped.invoice);
    invoiceLines.push(...mapped.lines);
  }
  const creditNotes = creditPage.rows
    .map((raw) => normaliseCreditNote(input.companyId, raw, nowIso))
    .filter((row) => row.creditNoteId);
  const contacts = contactPage.rows
    .map((raw) => normaliseContact(input.companyId, raw, nowIso))
    .filter((row) => row.contactId);
  const payments = paymentPage.rows
    .map((raw) => normalisePayment(input.companyId, raw, nowIso))
    .filter((row) => row.paymentId);

  const sourceTimestamp = [
    ...invoices.map((row) => row.sourceUpdatedAt),
    ...creditNotes.map((row) => row.sourceUpdatedAt),
    ...contacts.map((row) => row.sourceUpdatedAt),
    ...payments.map((row) => row.sourceUpdatedAt),
    input.checkpoint?.sourceTimestamp,
    nowIso,
  ]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? nowIso;

  const truncated =
    invoicesPage.truncated || creditPage.truncated || contactPage.truncated || paymentPage.truncated;
  void XERO_DATA_BOUNDS;

  return {
    invoices,
    invoiceLines,
    contacts,
    payments,
    creditNotes,
    recordsRead: invoices.length + invoiceLines.length + contacts.length + payments.length + creditNotes.length,
    truncated,
    organisation: {
      name: org?.Name ? String(org.Name) : null,
      currency: org?.BaseCurrency ? String(org.BaseCurrency) : null,
      financialYearStart: fy.currentFyStart,
      historicalFrom: fy.historicalFrom,
      historicalTo: fy.historicalTo,
    },
    checkpoint: {
      mode: backfill ? "backfill" : "incremental",
      invoicesUpdatedAfter: sourceTimestamp,
      contactsUpdatedAfter: sourceTimestamp,
      paymentsUpdatedAfter: sourceTimestamp,
      creditNotesUpdatedAfter: sourceTimestamp,
      historyFrom: backfill ? fy.historicalFrom : input.checkpoint?.historyFrom ?? fy.historicalFrom,
      historyTo: fy.historicalTo,
      sourceTimestamp,
    },
  };
}

export async function liveXeroTotals(input: {
  env: Env;
  companyId: string;
  now: Date;
}): Promise<WarehouseLiveTotals> {
  const dates = londonDateParts(input.now);
  try {
    const [sales, overdue] = await Promise.all([
      executeXeroReadToolOnInfra(input.env, {
        companyId: input.companyId,
        toolName: "xero_sales_summary",
        arguments: { fromDate: dates.monthStart, toDate: dates.today },
        actor: "system:warehouse",
      }),
      executeXeroReadToolOnInfra(input.env, {
        companyId: input.companyId,
        toolName: "xero_list_overdue_invoices",
        arguments: { effectiveDate: dates.today, limit: 100 },
        actor: "system:warehouse",
      }),
    ]);
    if (!sales.ok) return { mtdSales: null, invoiceCount: null, outstanding: null, overdue: null, unavailable: true };
    const result = sales.result as Record<string, unknown>;
    const summary = (result.summary as Record<string, unknown> | undefined) ?? result;
    const overdueResult = overdue.ok ? (overdue.result as Record<string, unknown>) : {};
    const overdueRows = Array.isArray(overdueResult.invoices) ? overdueResult.invoices : [];
    const overdueTotal = overdueRows.reduce((sum, row) => {
      const rec = row as Record<string, unknown>;
      return sum + Number(rec.amountDue ?? rec.AmountDue ?? rec.total ?? 0);
    }, 0);
    return {
      mtdSales: Number(summary.totalSales ?? summary.total ?? summary.sales_total ?? 0),
      invoiceCount: Number(summary.qualifyingTransactionCount ?? summary.count ?? summary.invoiceCount ?? 0),
      outstanding: summary.outstanding != null ? Number(summary.outstanding) : null,
      overdue: overdue.ok ? overdueTotal : null,
      unavailable: false,
    };
  } catch {
    return { mtdSales: null, invoiceCount: null, outstanding: null, overdue: null, unavailable: true };
  }
}

export function createXeroWarehouseAdapter(env: Env): WarehouseConnectorAdapter {
  return {
    connector: WAREHOUSE_XERO_CONNECTOR,
    extract: (input) =>
      extractXeroWarehouse({
        env,
        companyId: input.companyId,
        checkpoint: input.checkpoint,
        now: input.now,
        trigger: input.trigger,
      }),
    liveTotals: (input) => liveXeroTotals({ env, companyId: input.companyId, now: input.now }),
  };
}

export { WAREHOUSE_RECONCILE_ABS_TOLERANCE };
