import type { IntelligenceToolResult } from "./types.js";

export const GENERIC_RETRY_COPY = "I need another moment to finish that. Try asking once more.";

export function isGenericRetryCopy(text: string | null | undefined): boolean {
  return /need another moment|try asking once more|couldn.?t process that request just now/i.test(text ?? "");
}

export type ReadTerminalKind =
  | "success"
  | "permission_denied"
  | "no_results"
  | "upstream_failure"
  | "timeout"
  | "clarify";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function outlookFrom(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isRecord(value)) {
    const email = isRecord(value.emailAddress) ? value.emailAddress : value;
    return asString(email.address ?? email.email ?? email.name);
  }
  return "";
}

function looksPermissionDenied(call: IntelligenceToolResult): boolean {
  const record = isRecord(call.data) ? call.data : {};
  if (
    record.accessOutcome === "permission_denied" ||
    record.denied === true ||
    record.result === "permission_denied" ||
    record.billingStatus === "denied"
  ) {
    return true;
  }
  const status = Number(record.status ?? record.httpStatus ?? 0);
  if (status === 403) return true;
  const blob = [call.error, record.error, record.code, record.reason]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /permission_denied|user_not_authorised|not allowed for your role|office staff permissions|your current permissions don.?t allow/i.test(
    blob,
  );
}

function looksTimeout(call: IntelligenceToolResult): boolean {
  const blob = [call.error, isRecord(call.data) ? call.data.error : ""]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return call.error === "timeout" || /timed? ?out|aborted/i.test(blob);
}

export { looksPermissionDenied };

export function extractOutlookMessages(data: unknown): Array<{
  id: string;
  subject: string;
  from: string;
  receivedDateTime: string;
  mailboxAddress: string;
  body: string;
}> {
  const record = isRecord(data) ? data : {};
  const nested = isRecord(record.preview) ? record.preview : record;
  const mailbox = asString(nested.mailboxAddress ?? nested.mailbox ?? record.mailboxAddress);
  const raw = Array.isArray(nested.messages)
    ? nested.messages
    : Array.isArray(record.messages)
      ? record.messages
      : nested.subject || nested.body || nested.id
        ? [nested]
        : nested.message
          ? [nested.message]
          : [];
  return raw
    .filter(isRecord)
    .map((message) => ({
      id: asString(message.id ?? message.messageId ?? message.emailId ?? message.email_id ?? message.internetMessageId),
      subject: asString(message.subject) || "(no subject)",
      from: outlookFrom(message.from ?? message.sender),
      receivedDateTime: asString(message.receivedDateTime ?? message.received ?? message.date),
      mailboxAddress: mailbox || asString(message.mailboxAddress),
      body: asString(message.body ?? message.bodyPreview).slice(0, 800),
    }));
}

export function extractFirstMessageId(data: unknown): string {
  return extractOutlookMessages(data).find((message) => message.id)?.id ?? "";
}

function formatMoney(value: unknown, currency = "GBP"): string {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,£$]/g, ""));
  if (!Number.isFinite(amount)) return String(value ?? "");
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }).format(amount);
  } catch {
    return `£${amount.toFixed(2)}`;
  }
}

function searchHits(data: unknown): Array<{ title: string; snippet: string }> {
  const record = isRecord(data) ? data : {};
  const results = Array.isArray(record.results) ? record.results : [];
  return results
    .filter(isRecord)
    .map((hit) => ({
      title: asString(hit.title) || "Untitled",
      snippet: asString(hit.snippet ?? hit.text).slice(0, 240),
    }));
}

export function synthesizeToolResult(call: IntelligenceToolResult, question: string): string {
  if (looksPermissionDenied(call)) {
    return "Your current permissions don’t allow this action.";
  }
  if (looksTimeout(call)) {
    return "I need another moment to finish that. Try asking once more.";
  }
  if (!call.ok) {
    if (/outlook|mailbox|email/i.test(call.name)) return "I couldn’t reach Email just now.";
    if (/^xero_/.test(call.name)) return "I couldn’t reach Xero just now.";
    if (/knowledge|search|fetch|list_documents|get_knowledge/i.test(call.name)) {
      return "I couldn’t reach company knowledge just now.";
    }
    return "I couldn’t complete that just now. Try again in a moment.";
  }

  if (/outlook/i.test(call.name)) {
    const messages = extractOutlookMessages(call.data);
    if (!messages.length) return "I couldn’t find any matching emails.";
    const newest = messages[0]!;
    const mailbox = newest.mailboxAddress ? ` in ${newest.mailboxAddress}` : "";
    const when = newest.receivedDateTime ? ` (${newest.receivedDateTime})` : "";
    const from = newest.from ? ` from ${newest.from}` : "";
    if (call.name === "outlook_get_message" || (/\b(full|body|what does .{0,40}(say|said))\b/i.test(question) && newest.body)) {
      const excerpt = newest.body
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 420);
      return excerpt
        ? `The latest email${mailbox} is “${newest.subject}”${from}${when}. It says: ${excerpt}`
        : `The latest email${mailbox} is “${newest.subject}”${from}${when}.`;
    }
    if (/\bhow many\b/i.test(question)) {
      return `I can see ${messages.length} matching email${messages.length === 1 ? "" : "s"} in the latest results${mailbox}.`;
    }
    if (/\b(newest|latest|last|most recently|unread)\b/i.test(question) || messages.length === 1) {
      return `The newest email${mailbox} is “${newest.subject}”${from}${when}.`;
    }
    const listed = messages
      .slice(0, 5)
      .map((message) => `“${message.subject}”${message.from ? ` from ${message.from}` : ""}`)
      .join("; ");
    return `I found ${messages.length} email${messages.length === 1 ? "" : "s"}${mailbox}: ${listed}.`;
  }

  if (call.name === "xero_get_invoice") {
    const record = isRecord(call.data) ? call.data : {};
    const invoice = isRecord(record.invoice) ? record.invoice : record;
    const number = asString(invoice.invoiceNumber ?? invoice.InvoiceNumber ?? invoice.invoice_number);
    const contact = asString(
      isRecord(invoice.contact) ? invoice.contact.name : invoice.contact ?? invoice.ContactName,
    );
    const total = invoice.total ?? invoice.Total ?? invoice.amount;
    const status = asString(invoice.status ?? invoice.Status);
    if (number || typeof total === "number" || typeof total === "string") {
      const who = contact ? ` for ${contact}` : "";
      const amount = typeof total === "number" || typeof total === "string" ? ` ${formatMoney(total)}` : "";
      const state = status ? ` (${status})` : "";
      return `Xero invoice ${number || "requested"}${who}${amount}${state}.`;
    }
    return "I retrieved that Xero invoice.";
  }

  if (call.name === "xero_top_customers") {
    const record = isRecord(call.data) ? call.data : {};
    const customers = Array.isArray(record.customers) ? record.customers.filter(isRecord) : [];
    if (!customers.length) return "I couldn’t find top customers for that period.";
    const listed = customers
      .slice(0, 5)
      .map((row) => {
        const name = asString(row.name ?? row.contact ?? row.ContactName) || "Unknown";
        const total = row.total ?? row.amount ?? row.sales_total;
        return typeof total === "number" || typeof total === "string" ? `${name} ${formatMoney(total)}` : name;
      })
      .join("; ");
    return `Top customers this period: ${listed}.`;
  }

  if (call.name === "xero_search_invoices" || call.name === "xero_list_overdue_invoices") {
    const record = isRecord(call.data) ? call.data : {};
    const invoices = Array.isArray(record.invoices) ? record.invoices.filter(isRecord) : [];
    if (!invoices.length) return "I couldn’t find any matching invoices.";
    const listed = invoices
      .slice(0, 5)
      .map((row) => {
        const number = asString(row.invoiceNumber ?? row.InvoiceNumber ?? row.invoice_number);
        const contact = asString(isRecord(row.contact) ? row.contact.name : row.contact ?? row.ContactName);
        const total = row.total ?? row.Total ?? row.amount;
        const amount = typeof total === "number" || typeof total === "string" ? ` ${formatMoney(total)}` : "";
        return `${number || "invoice"}${contact ? ` ${contact}` : ""}${amount}`;
      })
      .join("; ");
    return `I found ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}: ${listed}.`;
  }

  if (call.name === "xero_sales_summary" || call.name.startsWith("xero_")) {
    const record = isRecord(call.data) ? call.data : {};
    const summary = isRecord(record.summary) ? record.summary : {};
    const total = record.sales_total ?? summary.totalSales ?? record.total;
    const count = record.invoice_count ?? summary.transactionCount ?? record.count;
    const period = isRecord(record.period) ? record.period : {};
    const fromDate = asString(period.fromDate ?? summary.fromDate ?? record.fromDate);
    const toDate = asString(period.toDate ?? summary.toDate ?? record.toDate);
    const currency = asString(record.currencyCode ?? record.currency ?? summary.currencyCode) || "GBP";
    if (typeof total === "number" || typeof total === "string") {
      const range = fromDate && toDate ? ` from ${fromDate} to ${toDate}` : "";
      const invoices = typeof count === "number" ? ` across ${count} invoice${count === 1 ? "" : "s"}` : "";
      return `Xero sales${range} are ${formatMoney(total, currency)}${invoices}.`;
    }
    if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
    if (Array.isArray(record.invoices) && record.invoices.length === 0) {
      return "I couldn’t find any matching invoices.";
    }
    return "I retrieved the Xero figures. Ask if you want a specific invoice or period.";
  }

  if (call.name === "get_knowledge_document" || call.name === "fetch") {
    const record = isRecord(call.data) ? call.data : {};
    const title = asString(record.title) || "that document";
    const chunks = Array.isArray(record.chunks) ? record.chunks.filter(isRecord) : [];
    const excerpt = asString(chunks[0]?.text ?? record.text).slice(0, 420);
    if (excerpt) return `${title}: ${excerpt}`;
    return `I found ${title}.`;
  }
  if (call.name === "search_company_knowledge" || call.name === "search") {
    const hits = searchHits(call.data);
    if (!hits.length) return "I couldn’t find any matching documents.";
    if (hits.length === 1) {
      const only = hits[0]!;
      return only.snippet ? `${only.title}: ${only.snippet}` : `I found ${only.title}.`;
    }
    const titles = hits.slice(0, 3).map((hit) => hit.title);
    return `Across your documents I can see: ${titles.join("; ")}.`;
  }

  if (call.name === "web_search") {
    const record = isRecord(call.data) ? call.data : {};
    const heading = asString(record.heading);
    const abstract = asString(record.abstract);
    if (abstract) return heading ? `${heading}: ${abstract}` : abstract;
    const results = Array.isArray(record.results) ? record.results.filter(isRecord) : [];
    const first = results[0];
    if (first && asString(first.snippet)) {
      return asString(first.title) ? `${asString(first.title)}: ${asString(first.snippet)}` : asString(first.snippet);
    }
    return "I checked public web sources and didn’t find a clear answer.";
  }

  if (call.name === "list_documents") {
    const record = isRecord(call.data) ? call.data : {};
    const docs = Array.isArray(record.documents) ? record.documents : Array.isArray(record.results) ? record.results : [];
    const first = docs.find(isRecord);
    if (!first) return "I couldn’t find any matching documents.";
    const title = asString(first.title) || "Untitled";
    return `The newest document is ${title}.`;
  }

  return "I have the result. What else do you need from it?";
}

export function synthesizeFromToolCalls(
  toolCalls: IntelligenceToolResult[],
  question: string,
): string {
  const denied = toolCalls.find((call) => looksPermissionDenied(call));
  if (denied) return synthesizeToolResult(denied, question);
  const xeroCalls = toolCalls.filter((call) => call.ok && /^xero_/.test(call.name));
  const outlook = toolCalls.find((call) => call.ok && /outlook/i.test(call.name));
  if (xeroCalls.length >= 2 && /\b(compare|versus|better than|last month|previous)\b/i.test(question)) {
    return xeroCalls.map((call) => synthesizeToolResult(call, question)).join(" ");
  }
  const xero = xeroCalls[0];
  if (xero && outlook && /\b(and then|then show|and show|and the|then the)\b/i.test(question)) {
    return `${synthesizeToolResult(xero, question)} ${synthesizeToolResult(outlook, question)}`;
  }
  const lastOk = [...toolCalls].reverse().find((call) => call.ok);
  if (lastOk) return synthesizeToolResult(lastOk, question);
  const last = toolCalls.at(-1);
  if (last) return synthesizeToolResult(last, question);
  return GENERIC_RETRY_COPY;
}

export function classifyReadTerminal(
  toolCalls: IntelligenceToolResult[],
  reply: string,
  kind?: string,
): ReadTerminalKind {
  if (toolCalls.some((call) => looksPermissionDenied(call))) return "permission_denied";
  if (toolCalls.some((call) => looksTimeout(call) && !call.ok)) return "timeout";
  if (toolCalls.some((call) => !call.ok)) return "upstream_failure";
  const lastOk = [...toolCalls].reverse().find((call) => call.ok);
  if (lastOk) {
    if (/outlook/i.test(lastOk.name) && extractOutlookMessages(lastOk.data).length === 0) return "no_results";
    if ((lastOk.name === "search_company_knowledge" || lastOk.name === "search") && searchHits(lastOk.data).length === 0) {
      return "no_results";
    }
    return "success";
  }
  if (kind === "clarify") return "clarify";
  if (isGenericRetryCopy(reply)) return "timeout";
  if (!toolCalls.length) return kind === "failed" ? "timeout" : "success";
  return "upstream_failure";
}
