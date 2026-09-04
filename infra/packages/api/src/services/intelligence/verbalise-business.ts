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

export function extractOutlookMessages(data: unknown): Array<{
  subject: string;
  from: string;
  receivedDateTime: string;
  mailboxAddress: string;
}> {
  const record = isRecord(data) ? data : {};
  const nested = isRecord(record.preview) ? record.preview : record;
  const mailbox = asString(nested.mailboxAddress ?? nested.mailbox ?? record.mailboxAddress);
  const raw = Array.isArray(nested.messages)
    ? nested.messages
    : Array.isArray(record.messages)
      ? record.messages
      : nested.message
        ? [nested.message]
        : [];
  return raw
    .filter(isRecord)
    .map((message) => ({
      subject: asString(message.subject) || "(no subject)",
      from: outlookFrom(message.from ?? message.sender),
      receivedDateTime: asString(message.receivedDateTime ?? message.received ?? message.date),
      mailboxAddress: mailbox || asString(message.mailboxAddress),
    }));
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
    if (/\b(newest|latest|last)\b/i.test(question) || messages.length === 1) {
      return `The newest email${mailbox} is “${newest.subject}”${from}${when}.`;
    }
    const listed = messages
      .slice(0, 3)
      .map((message) => `“${message.subject}”${message.from ? ` from ${message.from}` : ""}`)
      .join("; ");
    return `I found ${messages.length} email${messages.length === 1 ? "" : "s"}${mailbox}: ${listed}.`;
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
