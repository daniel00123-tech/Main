/**
 * Shared structured-result normalisation for Xero, Outlook, and catalogue tools.
 * The model must not rediscover amounts, counts, subjects, or titles from raw JSON blobs.
 */

import type { IntelligenceToolCall, IntelligenceToolResult } from "./types.js";

export type BusinessResultFamily = "xero" | "outlook" | "catalogue" | "knowledge" | "unknown";

export type NormalisedBusinessResult = {
  family: BusinessResultFamily;
  tool: string;
  sufficient: boolean;
  amount: number | null;
  invoiceCount: number | null;
  period: string | null;
  currency: string | null;
  source: string | null;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  mailbox: string | null;
  preview: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  summaryText: string;
  compact: Record<string, unknown>;
};

const REFRESH_ASK =
  /\b(refresh|again|re-?check|re-?run|re-?query|updated|latest figures|check again|look again)\b/i;

export function userAskedRefresh(text: string): boolean {
  return REFRESH_ASK.test(text);
}

export function isXeroToolName(name: string): boolean {
  return name.startsWith("xero_");
}

export function isOutlookToolName(name: string): boolean {
  return name.startsWith("outlook_");
}

export function isCatalogueToolName(name: string): boolean {
  return name === "list_documents";
}

export function isKnowledgeToolName(name: string): boolean {
  return (
    name === "search_company_knowledge" ||
    name === "search_document" ||
    name === "get_knowledge_document" ||
    name === "fetch" ||
    name === "ask_document"
  );
}

export function familyForTool(name: string): BusinessResultFamily {
  if (isXeroToolName(name)) return "xero";
  if (isOutlookToolName(name)) return "outlook";
  if (isCatalogueToolName(name)) return "catalogue";
  if (isKnowledgeToolName(name)) return "knowledge";
  return "unknown";
}

export function normaliseBusinessResult(tool: string, data: unknown): NormalisedBusinessResult {
  const family = familyForTool(tool);
  if (family === "xero") return normaliseXero(tool, data);
  if (family === "outlook") return normaliseOutlook(tool, data);
  if (family === "catalogue") return normaliseCatalogue(tool, data);
  if (family === "knowledge") return normaliseKnowledge(tool, data);
  return emptyNormalised(tool, "unknown");
}

export function isSufficientBusinessResult(result: IntelligenceToolResult): boolean {
  if (!result.ok) return false;
  const family = familyForTool(result.name);
  if (family === "knowledge") return false;
  return normaliseBusinessResult(result.name, result.data).sufficient;
}

export function equivalentToolArgs(
  name: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return canonicalArgKey(name, left) === canonicalArgKey(name, right);
}

export function findReusableSuccess(
  executed: Array<{ call: IntelligenceToolCall; result: IntelligenceToolResult }>,
  next: IntelligenceToolCall,
): IntelligenceToolResult | null {
  const match = [...executed].reverse().find(
    (row) =>
      row.result.ok &&
      row.call.name === next.name &&
      equivalentToolArgs(next.name, row.call.arguments, next.arguments),
  );
  return match?.result ?? null;
}

export function isTransientToolFailure(result: IntelligenceToolResult): boolean {
  const blob = `${result.error ?? ""} ${isRecord(result.data) ? String(result.data.error ?? "") : ""}`;
  return result.error === "timeout" || /timeout|aborted|timed out|temporar|unavailable|502|503|524|522/i.test(blob);
}

export function compactBusinessToolData(tool: string, data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const normalised = normaliseBusinessResult(tool, data);
  const record = data as Record<string, unknown>;
  const raw = JSON.stringify(data);
  if (raw.length <= 3_500) return data;
  const compact: Record<string, unknown> = {
    ...normalised.compact,
    source: normalised.source ?? record.source ?? null,
    retrieved_at: record.retrieved_at ?? record.retrievedAt ?? null,
    toolName: record.toolName ?? tool,
  };
  if (raw.length > 3_500) {
    compact.truncated = true;
  }
  return compact;
}

export function formatNormalisedTranscript(result: IntelligenceToolResult): string {
  const normalised = normaliseBusinessResult(result.name, result.data);
  if (!result.ok) {
    return `${result.name} (error, ${result.latencyMs}ms): ${JSON.stringify({ error: result.error ?? "tool_failed" }).slice(0, 800)}`;
  }
  return `${result.name} (ok, ${result.latencyMs}ms): ${JSON.stringify(normalised.compact).slice(0, 1_200)}`;
}

export function answerContainsStructuredEvidence(text: string, normalised: NormalisedBusinessResult): boolean {
  const body = text.trim();
  if (!body) return false;
  if (normalised.family === "xero") {
    if (normalised.amount == null) return /£\s?[\d,]|\b\d+\.\d{2}\b/.test(body);
    const amount = normalised.amount.toFixed(2);
    const loose = String(Math.round(normalised.amount));
    return body.includes(amount) || body.includes(loose) || body.includes(formatMoney(normalised.amount, normalised.currency ?? "GBP"));
  }
  if (normalised.family === "outlook") {
    if (normalised.subject && body.includes(normalised.subject)) return true;
    if (normalised.sender && body.includes(normalised.sender)) return true;
    return /no matching messages/i.test(body);
  }
  if (normalised.family === "catalogue" || normalised.family === "knowledge") {
    return Boolean(normalised.title && body.includes(normalised.title));
  }
  return false;
}

function normaliseXero(tool: string, data: unknown): NormalisedBusinessResult {
  const base = emptyNormalised(tool, "xero");
  if (!isRecord(data)) {
    return { ...base, summaryText: "I reached Xero, but nothing readable came back." };
  }
  const unwrapped = unwrapPreview(data);
  const summary = isRecord(unwrapped.summary) ? unwrapped.summary : unwrapped;
  const periodObj = isRecord(unwrapped.period) ? unwrapped.period : isRecord(summary.period) ? summary.period : null;
  const amount = firstMoney(
    unwrapped.sales_total,
    unwrapped.totalSales,
    unwrapped.total,
    unwrapped.amount,
    summary.totalSales,
    summary.salesTotal,
    summary.total,
    summary.totalAmount,
    summary.amount,
    summary.sales_total,
  );
  const invoiceCount = firstCount(
    unwrapped.invoice_count,
    unwrapped.invoiceCount,
    unwrapped.qualifyingTransactionCount,
    summary.invoiceCount,
    summary.invoice_count,
    summary.transactionCount,
    summary.count,
    Array.isArray(unwrapped.invoices) ? unwrapped.invoices.length : null,
    Array.isArray(summary.invoices) ? summary.invoices.length : null,
  );
  const currency =
    firstString(unwrapped.currency, unwrapped.currencyCode, summary.currency, summary.currencyCode) || "GBP";
  const period = formatPeriod(
    firstString(periodObj?.label, unwrapped.periodLabel, summary.periodLabel) ||
      periodWindow(
        firstString(periodObj?.fromDate, unwrapped.fromDate, summary.fromDate),
        firstString(periodObj?.toDate, unwrapped.toDate, summary.toDate),
      ) ||
      (typeof unwrapped.period === "string" ? unwrapped.period : typeof summary.period === "string" ? summary.period : null),
  );
  const source = firstString(unwrapped.source, "Xero") || "Xero";
  const invoice =
    isRecord(unwrapped.invoice) ? unwrapped.invoice : isRecord(summary.invoice) ? summary.invoice : null;
  const invoiceNumber = firstString(
    unwrapped.invoiceNumber,
    invoice?.InvoiceNumber,
    invoice?.invoiceNumber,
    unwrapped.documentNumber,
  );
  const customers = Array.isArray(unwrapped.customers) ? unwrapped.customers : [];
  const topName =
    customers[0] && isRecord(customers[0]) ? firstString(customers[0].name, customers[0].contactName) : null;

  const isInvoiceDetail = tool === "xero_get_invoice" && Boolean(invoice);
  const invoiceMissing =
    tool === "xero_get_invoice" &&
    !invoice &&
    (unwrapped.found === false || unwrapped.no_results === true || Boolean(invoiceNumber));
  const isTopCustomers = tool === "xero_top_customers" && customers.length > 0;
  const sufficient =
    invoiceMissing ||
    isInvoiceDetail ||
    isTopCustomers ||
    typeof amount === "number" ||
    (tool === "xero_search_invoices" && invoiceCount != null) ||
    (tool === "xero_list_overdue_invoices" && invoiceCount != null);

  let summaryText = "I reached Xero, but nothing readable came back.";
  if (invoiceMissing) {
    summaryText = invoiceNumber
      ? `I could not find invoice ${invoiceNumber} in Xero.`
      : "I could not find that invoice in Xero.";
  } else if (isInvoiceDetail) {
    const total = firstMoney(invoice?.Total, invoice?.total, invoice?.AmountDue, amount);
    const who = firstString(isRecord(invoice?.Contact) ? invoice.Contact.Name : null, invoice?.contactName);
    summaryText = `Invoice ${invoiceNumber ?? "record"} is ${
      total != null ? formatMoney(total, currency) : "on file"
    }${who ? ` for ${who}` : ""}.`;
  } else if (isTopCustomers) {
    const names = customers
      .slice(0, 5)
      .map((row) => (isRecord(row) ? firstString(row.name, row.contactName) : null))
      .filter(Boolean);
    summaryText = names.length
      ? `Top Xero customers: ${names.join(", ")}.`
      : "I reached Xero customers, but no names were readable.";
  } else if (typeof amount === "number") {
    const invoices = invoiceCount != null ? ` across ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}` : "";
    const window = period ? ` for ${period}` : "";
    summaryText = `Xero sales${window} are ${formatMoney(amount, currency)}${invoices}.`;
  } else if (invoiceCount != null) {
    const listed = invoicePreview(unwrapped, currency);
    const kind =
      tool === "xero_list_overdue_invoices"
        ? "overdue invoice"
        : /outstanding|unpaid/i.test(String(unwrapped.query ?? ""))
          ? "outstanding invoice"
          : "invoice";
    const head = `Xero returned ${invoiceCount} ${kind}${invoiceCount === 1 ? "" : "s"}${period ? ` for ${period}` : ""}`;
    summaryText = listed ? `${head}, including ${listed}.` : `${head}.`;
  }

  const compact = {
    source,
    amount,
    invoice_count: invoiceCount,
    period,
    currency,
    invoice_number: invoiceNumber,
    top_customer: topName,
  };

  return {
    ...base,
    sufficient,
    amount,
    invoiceCount,
    period,
    currency,
    source,
    title: invoiceNumber,
    summaryText,
    compact,
  };
}

function normaliseOutlook(tool: string, data: unknown): NormalisedBusinessResult {
  const base = emptyNormalised(tool, "outlook");
  if (!isRecord(data)) {
    return { ...base, summaryText: "No matching messages in that mailbox.", sufficient: true };
  }
  const unwrapped = unwrapPreview(data);
  const mailbox = firstString(unwrapped.mailboxAddress, unwrapped.mailbox);
  const messages = outlookMessages(unwrapped);
  if (!messages.length) {
    return {
      ...base,
      sufficient: true,
      mailbox,
      source: "Outlook",
      summaryText: mailbox ? `No matching messages in ${mailbox}.` : "No matching messages in that mailbox.",
      compact: { source: "Outlook", mailbox, message_count: 0 },
    };
  }
  const newest = messages[0]!;
  const subject = firstString(newest.subject) || "(no subject)";
  const sender = firstString(newest.from, newest.sender, newest.fromAddress);
  const receivedAt = firstString(newest.receivedDateTime, newest.received, newest.date);
  const preview = firstString(newest.bodyPreview, newest.preview, newest.body, newest.snippet);
  const who = sender ? ` from ${sender}` : "";
  const date = receivedAt ? ` (${receivedAt})` : "";
  const box = mailbox ? ` in ${mailbox}` : "";
  return {
    ...base,
    sufficient: true,
    mailbox,
    subject,
    sender,
    receivedAt,
    preview,
    source: "Outlook",
    summaryText: `The newest email${box} is “${subject}”${who}${date}.`,
    compact: {
      source: "Outlook",
      mailbox,
      subject,
      sender,
      received_at: receivedAt,
      preview: preview ? preview.slice(0, 240) : null,
      message_count: messages.length,
    },
  };
}

function normaliseCatalogue(tool: string, data: unknown): NormalisedBusinessResult {
  const base = emptyNormalised(tool, "catalogue");
  if (!isRecord(data)) {
    return { ...base, summaryText: "I could not find a matching company file.", sufficient: true };
  }
  const unwrapped = unwrapPreview(data);
  const items = catalogueItems(unwrapped);
  if (!items.length) {
    return {
      ...base,
      sufficient: true,
      source: "catalogue",
      summaryText: "I could not find a matching company file.",
      compact: { source: "catalogue", item_count: 0 },
    };
  }
  const first = items[0]!;
  const title = firstString(first.title, first.name) || "Untitled file";
  const url = firstString(first.url, first.webUrl);
  const description = firstString(first.description, first.snippet, first.summary);
  const createdAt = firstString(first.created, first.createdAt, first.createdDateTime);
  const modifiedAt = firstString(first.modified, first.modifiedAt, first.lastModifiedDateTime, first.updatedAt);
  const source = firstString(first.source, first.sourceSystem, unwrapped.source, "OneDrive / SharePoint");
  return {
    ...base,
    sufficient: true,
    title,
    url,
    description,
    createdAt,
    modifiedAt,
    source,
    summaryText: `The newest file is “${title}”${modifiedAt ? ` (updated ${modifiedAt})` : ""}.`,
    compact: {
      source,
      title,
      url,
      description: description ? description.slice(0, 240) : null,
      created_at: createdAt,
      modified_at: modifiedAt,
      item_count: items.length,
    },
  };
}

function normaliseKnowledge(tool: string, data: unknown): NormalisedBusinessResult {
  const base = emptyNormalised(tool, "knowledge");
  if (!isRecord(data)) {
    return { ...base, summaryText: "I could not find a matching company document." };
  }
  const unwrapped = unwrapPreview(data);
  const hits = Array.isArray(unwrapped.results) ? unwrapped.results.filter(isRecord) : [];
  const title = firstString(unwrapped.title, hits[0] && isRecord(hits[0]) ? hits[0].title : null);
  const url = firstString(unwrapped.url, hits[0] && isRecord(hits[0]) ? hits[0].url : null);
  const description = firstString(
    unwrapped.snippet,
    hits[0] && isRecord(hits[0]) ? hits[0].snippet : null,
    Array.isArray(unwrapped.chunks) && isRecord(unwrapped.chunks[0]) ? String(unwrapped.chunks[0].text ?? "") : null,
  );
  const titles = hits
    .map((hit) => firstString(hit.title))
    .filter(Boolean)
    .slice(0, 3);
  let summaryText = "I could not find a matching company document.";
  if (title && tool !== "search_company_knowledge") {
    summaryText = `I found ${title}.`;
  } else if (titles.length === 1) {
    summaryText = `I found ${titles[0]}. What do you want from it?`;
  } else if (titles.length > 1) {
    summaryText = `Across your documents I can see: ${titles.join("; ")}. Which should I open?`;
  }
  return {
    ...base,
    sufficient: Boolean(title || titles.length),
    title: title ?? titles[0] ?? null,
    url,
    description,
    source: firstString(unwrapped.source, "company_knowledge"),
    summaryText,
    compact: {
      source: "company_knowledge",
      title: title ?? titles[0] ?? null,
      titles,
      url,
      hit_count: hits.length,
    },
  };
}

function emptyNormalised(tool: string, family: BusinessResultFamily): NormalisedBusinessResult {
  return {
    family,
    tool,
    sufficient: false,
    amount: null,
    invoiceCount: null,
    period: null,
    currency: null,
    source: null,
    subject: null,
    sender: null,
    receivedAt: null,
    mailbox: null,
    preview: null,
    title: null,
    url: null,
    description: null,
    createdAt: null,
    modifiedAt: null,
    summaryText: "",
    compact: { source: family === "unknown" ? null : family },
  };
}

function unwrapPreview(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.preview === "string" && data.truncated === true) {
    try {
      const parsed = JSON.parse(data.preview) as unknown;
      if (isRecord(parsed)) return { ...parsed, ...data };
    } catch {
      // Keep the truncated wrapper; field extractors still run on the wrapper.
    }
  }
  return data;
}

function canonicalArgKey(name: string, args: Record<string, unknown>): string {
  const material: Record<string, unknown> = {};
  if (isXeroToolName(name)) {
    for (const key of ["fromDate", "toDate", "period", "periodLabel", "invoice_id", "invoiceId", "invoiceNumber"]) {
      if (args[key] != null && args[key] !== "") material[key] = args[key];
    }
  } else if (isOutlookToolName(name)) {
    for (const key of ["mailboxAddress", "mailbox", "query", "limit"]) {
      if (args[key] != null && args[key] !== "") material[key] = args[key];
    }
  } else if (name === "search_company_knowledge" || name === "search") {
    if (args.query != null) material.query = String(args.query).trim().toLowerCase();
  } else if (name === "list_documents") {
    for (const key of ["source", "sort", "limit", "file_type", "titleContains"]) {
      if (args[key] != null && args[key] !== "") material[key] = args[key];
    }
  } else {
    for (const [key, value] of Object.entries(args)) {
      if (value != null && value !== "") material[key] = value;
    }
  }
  return JSON.stringify(material, Object.keys(material).sort());
}

function outlookMessages(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = Array.isArray(data.messages) ? data.messages : Array.isArray(data.results) ? data.results : [];
  return rows.filter(isRecord).sort((a, b) => {
    const left = String(a.receivedDateTime ?? a.received ?? a.date ?? "");
    const right = String(b.receivedDateTime ?? b.received ?? b.date ?? "");
    return right.localeCompare(left);
  });
}

function catalogueItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = Array.isArray(data.documents)
    ? data.documents
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.results)
        ? data.results
        : Array.isArray(data.files)
          ? data.files
          : [];
  return rows.filter(isRecord);
}

function invoicePreview(data: Record<string, unknown>, currency: string): string | null {
  const rows = Array.isArray(data.invoices)
    ? data.invoices
    : Array.isArray(data.invoice_numbers)
      ? data.invoice_numbers
      : [];
  const parts = rows
    .slice(0, 5)
    .map((row) => {
      if (typeof row === "string" && row.trim()) return row.trim();
      if (!isRecord(row)) return null;
      const number = firstString(row.InvoiceNumber, row.invoiceNumber, row.documentNumber);
      const who = firstString(
        isRecord(row.Contact) ? row.Contact.Name : null,
        row.contactName,
        isRecord(row.contact) ? row.contact.name : null,
      );
      const total = firstMoney(row.AmountDue, row.Total, row.total, row.amount);
      if (!number && !who) return null;
      return `${number ?? "invoice"}${who ? ` (${who})` : ""}${total != null ? ` ${formatMoney(total, currency)}` : ""}`;
    })
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join("; ") : null;
}

function firstMoney(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() && value !== "[object Object]") return value.trim();
  }
  return null;
}

function periodWindow(from: string | null, to: string | null): string | null {
  if (from && to) return from === to ? from : `${from} to ${to}`;
  return from || to || null;
}

function formatPeriod(value: string | null): string | null {
  return value && value !== "[object Object]" ? value : null;
}

function formatMoney(value: number, currency: string): string {
  if (currency.toUpperCase() === "GBP" || currency === "£") {
    return `£${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
