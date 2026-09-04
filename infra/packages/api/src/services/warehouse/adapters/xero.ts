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
import { extractRawSalesDocuments } from "../../xero-company-mcp";
import {
  COMPANY_MCP_RESULT_CAP,
  WAREHOUSE_CURRENT_WINDOWS_PER_RUN,
  WAREHOUSE_HISTORICAL_WINDOWS_PER_RUN,
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
import {
  addDays,
  applyWindowResult,
  calendarWindow,
  markCurrentMonthCaughtUp,
  remainingIncompleteWindows,
  seedProgressiveCheckpoint,
  summariseCompleteness,
  windowHitsCap,
} from "../windows";
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

/** Company-MCP invoice rows often have InvoiceNumber but no InvoiceID. Prefer Xero UUID, else stable number. */
export function stableXeroEntityId(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (value == null || value === "") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
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
    invoiceId: stableXeroEntityId(raw.InvoiceID, raw.invoiceId, raw.documentId, raw.InvoiceNumber, raw.invoiceNumber),
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
    contactId: stableXeroEntityId(raw.ContactID, raw.contactId),
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
    paymentId: stableXeroEntityId(raw.PaymentID, raw.paymentId),
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
    creditNoteId: stableXeroEntityId(raw.CreditNoteID, raw.creditNoteId, raw.documentId, raw.CreditNoteNumber, raw.creditNoteNumber),
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

function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(year, (month ?? 1) - 1 + months, day ?? 1));
  return dt.toISOString().slice(0, 10);
}

function monthEnd(isoDate: string): string {
  const next = addMonths(`${isoDate.slice(0, 8)}01`, 1);
  const end = new Date(`${next}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export function dateWindows(fromDate: string, toDate: string): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const end = monthEnd(cursor);
    windows.push({ from: cursor, to: end < toDate ? end : toDate });
    cursor = addMonths(`${cursor.slice(0, 8)}01`, 1);
  }
  return windows;
}

function coerceInvoiceRaw(row: Record<string, unknown>): Record<string, unknown> {
  const contact = (row.Contact as Record<string, unknown> | undefined) ?? {};
  return {
    InvoiceID: stableXeroEntityId(row.InvoiceID, row.invoiceId, row.documentId, row.InvoiceNumber, row.invoiceNumber, row.documentNumber),
    InvoiceNumber: row.InvoiceNumber ?? row.invoiceNumber ?? row.documentNumber,
    Type: row.Type ?? row.type ?? row.transactionType ?? "ACCREC",
    Status: row.Status ?? row.status ?? "AUTHORISED",
    Date: row.Date ?? row.date ?? row.InvoiceDate ?? row.invoiceDate,
    DueDate: row.DueDate ?? row.dueDate,
    Reference: row.Reference ?? row.reference,
    CurrencyCode: row.CurrencyCode ?? row.currency ?? row.currencyCode,
    SubTotal: row.SubTotal ?? row.subtotal,
    TotalTax: row.TotalTax ?? row.tax,
    Total: row.Total ?? row.total ?? row.amount,
    AmountDue: row.AmountDue ?? row.amountDue,
    AmountPaid: row.AmountPaid ?? row.amountPaid,
    AmountCredited: row.AmountCredited ?? row.amountCredited,
    UpdatedDateUTC: row.UpdatedDateUTC ?? row.sourceUpdatedAt,
    Contact: {
      ContactID: contact.ContactID ?? row.contactId ?? row.ContactID,
      Name: contact.Name ?? row.contactName ?? row.ContactName,
    },
    LineItems: row.LineItems ?? row.lineItems ?? [],
  };
}

function collectSearchRows(result: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(result.invoices)) return result.invoices as Record<string, unknown>[];
  return extractRawSalesDocuments(result).map((doc) => ({
    InvoiceID: doc.documentId ?? doc.documentNumber,
    InvoiceNumber: doc.documentNumber,
    Type: doc.transactionType,
    Status: doc.status,
    Date: doc.date,
    Total: doc.total,
    Contact: { ContactID: doc.contactId, Name: doc.contactName },
    documentKind: doc.documentKind,
  }));
}

function absorbSalesRows(
  companyId: string,
  nowIso: string,
  rows: Record<string, unknown>[],
  invoices: Map<string, WarehouseXeroInvoice>,
  invoiceLines: WarehouseXeroInvoiceLine[],
  creditNotes: Map<string, WarehouseXeroCreditNote>,
): number {
  let accepted = 0;
  for (const raw of rows) {
    const kind = String(raw.Type ?? raw.type ?? raw.documentKind ?? "");
    if (/credit/i.test(kind) || raw.documentKind === "credit_note") {
      const note = normaliseCreditNote(companyId, coerceInvoiceRaw(raw), nowIso);
      if (note.creditNoteId) {
        creditNotes.set(note.creditNoteId, note);
        accepted += 1;
      }
      continue;
    }
    const mapped = normaliseInvoice(companyId, coerceInvoiceRaw(raw), nowIso);
    if (!mapped.invoice.invoiceId) continue;
    invoices.set(mapped.invoice.invoiceId, mapped.invoice);
    invoiceLines.push(...mapped.lines);
    accepted += 1;
  }
  return accepted;
}

async function searchCompanyMcpWindow(input: {
  env: Env;
  companyId: string;
  from: string;
  to: string;
}): Promise<Record<string, unknown>[]> {
  const search = await executeXeroReadToolOnInfra(input.env, {
    companyId: input.companyId,
    toolName: "xero_search_invoices",
    arguments: { fromDate: input.from, toDate: input.to, limit: COMPANY_MCP_RESULT_CAP },
    actor: "system:warehouse",
  });
  if (!search.ok) {
    throw Object.assign(new Error(search.error), { code: search.code ?? "WAREHOUSE_XERO_UNAVAILABLE" });
  }
  return collectSearchRows(search.result);
}

async function extractContactsPage(input: {
  env: Env;
  companyId: string;
  nowIso: string;
  page: number;
}): Promise<{ contacts: WarehouseXeroContact[]; hitCap: boolean; pageAdvanced: boolean }> {
  const offset = Math.max(0, (input.page - 1) * COMPANY_MCP_RESULT_CAP);
  const contactResult = await executeXeroReadToolOnInfra(input.env, {
    companyId: input.companyId,
    toolName: "xero_list_contacts",
    arguments: { limit: COMPANY_MCP_RESULT_CAP, page: input.page, offset },
    actor: "system:warehouse",
  });
  if (!contactResult.ok) {
    return { contacts: [], hitCap: false, pageAdvanced: false };
  }
  const list = Array.isArray(contactResult.result.contacts)
    ? (contactResult.result.contacts as Record<string, unknown>[])
    : [];
  const contacts: WarehouseXeroContact[] = [];
  for (const raw of list) {
    const mapped = normaliseContact(
      input.companyId,
      {
        ContactID: raw.ContactID ?? raw.contactId,
        Name: raw.Name ?? raw.name ?? raw.displayName,
        ContactStatus: raw.ContactStatus ?? raw.status,
        IsCustomer: raw.IsCustomer ?? raw.isCustomer,
        IsSupplier: raw.IsSupplier ?? raw.isSupplier,
        AccountNumber: raw.AccountNumber ?? raw.accountNumber,
        UpdatedDateUTC: raw.UpdatedDateUTC,
      },
      input.nowIso,
    );
    if (mapped.contactId) contacts.push(mapped);
  }
  return {
    contacts,
    hitCap: windowHitsCap(contacts.length),
    pageAdvanced: contacts.length > 0,
  };
}

async function extractXeroViaInfraReads(input: {
  env: Env;
  companyId: string;
  checkpoint: WarehouseCheckpoint | null;
  now: Date;
  trigger: "scheduled" | "backfill" | "manual";
  storedInvoices?: Array<{ invoiceDate: string | null }>;
}): Promise<WarehouseExtract> {
  const nowIso = input.now.toISOString();
  const org = await executeXeroReadToolOnInfra(input.env, {
    companyId: input.companyId,
    toolName: "xero_get_organisation",
    arguments: {},
    actor: "system:warehouse",
  });
  const orgRecord =
    org.ok && org.result.organisation && typeof org.result.organisation === "object"
      ? (org.result.organisation as Record<string, unknown>)
      : null;
  const fy = financialYearWindow(orgRecord, input.now);
  const historyFrom =
    input.trigger === "backfill" && !input.checkpoint
      ? fy.historicalFrom
      : input.checkpoint?.historyFrom ?? fy.historicalFrom;
  const historyTo = fy.historicalTo;
  const dates = londonDateParts(input.now);
  const seeded = seedProgressiveCheckpoint(
    input.checkpoint,
    input.storedInvoices ?? [],
    historyFrom,
    historyTo,
  );
  const started = Date.now();
  const invoices = new Map<string, WarehouseXeroInvoice>();
  const invoiceLines: WarehouseXeroInvoiceLine[] = [];
  const creditNotes = new Map<string, WarehouseXeroCreditNote>();
  let months = seeded.months ?? [];
  let grain = seeded.windowGrain ?? "month";
  let cursor = seeded.backfillCursor ?? null;
  let lastAttempted: string | null = null;
  let lastCompleted: string | null = seeded.lastCompletedWindow ?? null;
  let windowsUsed = 0;

  const runWindow = async (from: string, to: string, windowGrain: typeof grain) => {
    lastAttempted = `${from}:${to}`;
    const rows = await searchCompanyMcpWindow({
      env: input.env,
      companyId: input.companyId,
      from,
      to,
    });
    const fetched = absorbSalesRows(input.companyId, nowIso, rows, invoices, invoiceLines, creditNotes);
    const applied = applyWindowResult(months, { from, to }, fetched, windowGrain);
    months = applied.months;
    lastCompleted = `${from}:${to}`;
    windowsUsed += 1;
    return { fetched, applied };
  };

  const currentWin = calendarWindow(dates.monthStart, dates.today, "month");
  if (currentWin) {
    let currentGrain: "month" | "week" | "day" = "month";
    let currentCursor: string | null = currentWin.from;
    let currentBudget = WAREHOUSE_CURRENT_WINDOWS_PER_RUN;
    let currentFetched = 0;
    while (currentCursor && currentCursor <= dates.today && currentBudget > 0 && Date.now() - started < 22_000) {
      const piece = calendarWindow(currentCursor, dates.today, currentGrain);
      if (!piece) break;
      const { fetched, applied } = await runWindow(piece.from, piece.to, currentGrain);
      currentFetched += fetched;
      if (applied.possiblyTruncated && applied.nextGrain !== currentGrain) {
        currentGrain = applied.nextGrain;
        currentCursor = applied.nextCursor;
        currentBudget -= 1;
        continue;
      }
      currentCursor = applied.nextCursor && applied.nextCursor <= dates.today ? applied.nextCursor : null;
      currentBudget -= 1;
      if (!applied.possiblyTruncated && currentGrain !== "month" && currentCursor && currentCursor.slice(8, 10) === "01") {
        break;
      }
    }
    if (currentGrain === "month" || !currentCursor || currentCursor > dates.today) {
      months = markCurrentMonthCaughtUp(months, dates.monthStart, currentFetched);
    }
  }

  let contacts: WarehouseXeroContact[] = [];
  let contactsStatus = seeded.contactsStatus ?? "BACKFILLING";
  let contactPageNext = seeded.contactPage ?? 1;
  let contactsRetrieved = seeded.contactsRetrieved ?? 0;
  if (
    (contactsStatus === "BACKFILLING" || contactsStatus === "PARTIAL") &&
    Date.now() - started < 22_000
  ) {
    const page = seeded.contactPage ?? 1;
    const contactPage = await extractContactsPage({
      env: input.env,
      companyId: input.companyId,
      nowIso,
      page,
    });
    contacts = contactPage.contacts;
    contactsRetrieved = (seeded.contactsRetrieved ?? 0) + contactPage.contacts.length;
    if (!contactPage.hitCap) {
      contactsStatus = "COMPLETE";
    } else if (contactPage.pageAdvanced) {
      contactsStatus = "BACKFILLING";
      contactPageNext = page + 1;
    } else {
      contactsStatus = "PARTIAL";
    }
  }

  const payments: WarehouseXeroPayment[] = [];
  let paymentsStatus = seeded.paymentsStatus ?? "unknown";
  if (paymentsStatus !== "unavailable" && Date.now() - started < 22_000) {
    const paymentResult = await executeXeroReadToolOnInfra(input.env, {
      companyId: input.companyId,
      toolName: "xero_list_payments",
      arguments: { since: historyFrom, toDate: historyTo, limit: COMPANY_MCP_RESULT_CAP },
      actor: "system:warehouse",
    });
    if (paymentResult.ok) {
      const list = Array.isArray(paymentResult.result.payments)
        ? (paymentResult.result.payments as Record<string, unknown>[])
        : [];
      for (const raw of list) {
        const mapped = normalisePayment(input.companyId, raw, nowIso);
        if (mapped.paymentId) payments.push(mapped);
      }
      paymentsStatus = "available";
    } else if (paymentResult.code === "XERO_TOOL_NOT_IMPLEMENTED") {
      paymentsStatus = "unavailable";
    }
  }

  while (
    cursor &&
    cursor < dates.monthStart &&
    cursor <= historyTo &&
    windowsUsed < WAREHOUSE_CURRENT_WINDOWS_PER_RUN + WAREHOUSE_HISTORICAL_WINDOWS_PER_RUN &&
    Date.now() - started < 22_000
  ) {
    const historicalTo = addDays(dates.monthStart, -1);
    const win = calendarWindow(cursor, historicalTo < historyTo ? historicalTo : historyTo, grain);
    if (!win) {
      cursor = null;
      break;
    }
    const { applied } = await runWindow(win.from, win.to, grain);
    cursor = applied.nextCursor && applied.nextCursor < dates.monthStart ? applied.nextCursor : null;
    grain = applied.nextGrain;
    if (cursor && cursor.slice(8, 10) === "01" && !applied.possiblyTruncated) {
      grain = grain === "day" ? "week" : grain === "week" ? "month" : grain;
    }
  }

  const completeness = summariseCompleteness(months);
  const remaining = remainingIncompleteWindows(months, historyTo, grain);
  const invoiceLinesStatus = invoiceLines.length > 0 ? "available" : (seeded.invoiceLinesStatus === "available" ? "available" : "unavailable");
  const creditNotesStatus = creditNotes.size > 0 ? "available" : (seeded.creditNotesStatus === "available" ? "available" : "unavailable");
  const historicalIncomplete = completeness !== "COMPLETE";

  return {
    invoices: [...invoices.values()],
    invoiceLines,
    contacts,
    payments,
    creditNotes: [...creditNotes.values()],
    recordsRead: invoices.size + invoiceLines.length + contacts.length + payments.length + creditNotes.size,
    truncated: historicalIncomplete,
    organisation: {
      name: orgRecord?.Name ? String(orgRecord.Name) : null,
      currency: orgRecord?.BaseCurrency ? String(orgRecord.BaseCurrency) : "GBP",
      financialYearStart: fy.currentFyStart,
      historicalFrom: historyFrom,
      historicalTo: historyTo,
    },
    checkpoint: {
      mode: historicalIncomplete ? "backfill" : "incremental",
      invoicesUpdatedAfter: nowIso,
      contactsUpdatedAfter: nowIso,
      paymentsUpdatedAfter: nowIso,
      creditNotesUpdatedAfter: nowIso,
      historyFrom,
      historyTo,
      sourceTimestamp: nowIso,
      backfillCursor: cursor,
      windowFrom: cursor,
      windowTo: historyTo,
      lastCompletedWindow: lastCompleted,
      lastAttemptedWindow: lastAttempted,
      remainingWindows: remaining,
      recordsRetrieved: (seeded.recordsRetrieved ?? 0) + invoices.size,
      completeness,
      windowGrain: grain,
      months,
      contactsStatus,
      contactPage: contactPageNext,
      contactsRetrieved,
      completionEmailSent: seeded.completionEmailSent ?? false,
      historicalComplete: completeness === "COMPLETE",
      invoiceLinesStatus,
      paymentsStatus,
      creditNotesStatus,
      paginationMode: "window_subdivision",
    },
  };
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
  storedInvoices?: Array<{ invoiceDate: string | null }>;
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
    return extractXeroViaInfraReads(input);
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
      completeness: truncated ? "PARTIAL" : "COMPLETE",
      historicalComplete: !truncated,
      paginationMode: "true_page",
      invoiceLinesStatus: invoiceLines.length > 0 ? "available" : "unavailable",
      paymentsStatus: payments.length > 0 ? "available" : "unavailable",
      creditNotesStatus: creditNotes.length > 0 ? "available" : "unavailable",
      contactsStatus: contactPage.truncated ? "PARTIAL" : "COMPLETE",
      completionEmailSent: input.checkpoint?.completionEmailSent ?? false,
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
    const summary = (result.summary as Record<string, unknown> | undefined) ?? {};
    const overdueResult = overdue.ok ? (overdue.result as Record<string, unknown>) : {};
    const overdueRows = Array.isArray(overdueResult.invoices) ? overdueResult.invoices : [];
    const overdueTotal = overdueRows.reduce((sum, row) => {
      const rec = row as Record<string, unknown>;
      return sum + Number(rec.amountDue ?? rec.AmountDue ?? rec.total ?? 0);
    }, 0);
    const companyMcp = result.via === "company_mcp" || overdueResult.via === "company_mcp";
    const overdueCapped = overdueRows.length >= 50;
    return {
      mtdSales: Number(
        summary.totalSales ?? result.sales_total ?? result.totalSales ?? summary.total ?? summary.sales_total ?? 0,
      ),
      invoiceCount: Number(
        result.invoice_count ??
          summary.qualifyingTransactionCount ??
          summary.transactionCount ??
          result.count ??
          summary.invoiceCount ??
          0,
      ),
      outstanding: summary.outstanding != null ? Number(summary.outstanding) : null,
      overdue: overdue.ok && !companyMcp && !overdueCapped ? overdueTotal : null,
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
        storedInvoices: input.storedInvoices,
      }),
    liveTotals: (input) => liveXeroTotals({ env, companyId: input.companyId, now: input.now }),
  };
}

export { WAREHOUSE_RECONCILE_ABS_TOLERANCE };
