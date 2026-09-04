import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES } from "@infra/shared";
import type { IntelligenceToolResult } from "./types.js";

export const HOLLOW_ASSISTANT =
  /\b(i need another moment to finish that|try asking once more|couldn't complete that just now|couldn't finish a grounded answer|try again in a moment)\b/i;

export const FOLLOW_UP_FILLER =
  /^(please )?(can you |could you )?(give me |tell me )?(more )?(detail|details|info|information|that|this|it)s?[.?!]*$/i;

const MEMORY_ASK =
  /\b(what (were|are) we talking about|what did i (just )?ask|what did you (just )?(tell|say)|remind me)\b/i;

export function isHollowAssistantText(text: string | null | undefined): boolean {
  const trimmed = String(text ?? "").trim();
  return !trimmed || HOLLOW_ASSISTANT.test(trimmed);
}

export function isFollowUpFiller(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return FOLLOW_UP_FILLER.test(trimmed) || /^(give me |tell me )?more details?[.?!]*$/i.test(trimmed);
}

export function isMemoryAsk(text: string): boolean {
  return MEMORY_ASK.test(text.trim());
}

export function previousSubstantiveUserText(
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>,
  currentText: string,
): string | null {
  return (
    [...recentTurns]
      .reverse()
      .find(
        (turn) =>
          turn.role === "user" &&
          turn.text.trim() &&
          turn.text.trim() !== currentText.trim() &&
          !isFollowUpFiller(turn.text) &&
          !isMemoryAsk(turn.text),
      )?.text ?? null
  );
}

export function describeUserAsk(text: string): string {
  const cleaned = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |can you |could you |tell me )/i, "")
    .replace(/^(what (are|is|were|was) |what's )/i, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  return cleaned || text.replace(/\s+/g, " ").trim();
}

export function isExplicitPermissionDenial(error?: string | null, data?: unknown): boolean {
  const record = isRecord(data) ? data : {};
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
  const explicit = [error, record.error, record.code, record.reason]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /permission_denied|insufficient permissions|not available for your role|user_not_authorised|elvex role does not grant|blocked by your company permissions|office staff permissions|your current permissions don’t allow|your current permissions don't allow/i.test(
    explicit,
  );
}

export function terminalFromToolCalls(toolCalls: IntelligenceToolResult[]): string | null {
  if (!toolCalls.length) return null;
  const failed = [...toolCalls].reverse().find((call) => !call.ok);
  if (failed && toolCalls.every((call) => !call.ok)) {
    if (isExplicitPermissionDenial(failed.error, failed.data)) {
      const data = isRecord(failed.data) ? failed.data : {};
      const raw = String(failed.error ?? data.error ?? "").trim();
      return raw && raw.length < 240
        ? raw
        : "Your current permissions don’t allow this action. This was blocked by your company permissions.";
    }
    if (isTimeout(failed)) {
      if (isOutlookTool(failed.name)) return "Outlook is unreachable just now.";
      if (isXeroTool(failed.name)) return "I couldn’t reach Xero just now.";
      if (isKnowledgeTool(failed.name)) return "I couldn’t reach company files just now.";
      return "That connected system is unreachable just now.";
    }
    if (isOutlookTool(failed.name)) return "I couldn’t retrieve that mailbox just now.";
    if (isXeroTool(failed.name)) return "I couldn’t retrieve Xero data just now.";
    if (isKnowledgeTool(failed.name)) return "I couldn’t search company files just now.";
    return "I couldn’t retrieve that just now.";
  }

  const lastOk = [...toolCalls].reverse().find((call) => call.ok);
  if (!lastOk) return null;
  if (isOutlookTool(lastOk.name)) return summariseOutlookEvidence(lastOk.data);
  if (isXeroTool(lastOk.name)) return summariseXeroEvidence(lastOk.data);
  if (lastOk.name === "search_company_knowledge") return summariseKnowledgeSearch(lastOk.data);
  return null;
}

export function summariseOutlookEvidence(data: unknown): string {
  const messages = outlookMessages(data);
  const mailbox = isRecord(data) ? String(data.mailboxAddress ?? data.mailbox ?? "").trim() : "";
  if (!messages.length) {
    return mailbox
      ? `No matching messages in ${mailbox}.`
      : "No matching messages in that mailbox.";
  }
  const newest = messages[0]!;
  const subject = String(newest.subject ?? "").trim() || "(no subject)";
  const from = String(newest.from ?? newest.sender ?? "").trim();
  const when = String(newest.receivedDateTime ?? newest.received ?? newest.date ?? "").trim();
  const who = from ? ` from ${from}` : "";
  const date = when ? ` (${when})` : "";
  const box = mailbox ? ` in ${mailbox}` : "";
  return `The newest email${box} is “${subject}”${who}${date}.`;
}

export function summariseXeroEvidence(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "I reached Xero, but nothing readable came back.";
  }
  const record = data as Record<string, unknown>;
  const summary = isRecord(record.summary) ? record.summary : record;
  const total = firstMoney(summary.total ?? summary.totalAmount ?? summary.salesTotal ?? summary.amount);
  const count = Number(summary.invoiceCount ?? summary.count ?? summary.invoices);
  const currency = String(summary.currency ?? summary.currencyCode ?? "GBP").trim() || "GBP";
  const period = String(summary.period ?? summary.fromDate ?? "").trim();
  if (typeof total === "number" && Number.isFinite(total)) {
    const invoices = Number.isFinite(count) ? ` across ${count} invoices` : "";
    const window = period ? ` for ${period}` : "";
    return `Xero sales${window} are ${formatMoney(total, currency)}${invoices}.`;
  }
  const amounts = JSON.stringify(data).match(/£\s?[\d,]+(?:\.\d{2})?|\b[\d,]+\.\d{2}\b/g)?.slice(0, 4) ?? [];
  if (amounts.length) {
    return `From Xero, the figures I can see include ${amounts.join(", ")}.`;
  }
  return "I reached Xero. Ask for overdue invoices, a named invoice, or P&L if you want a specific cut.";
}

function summariseKnowledgeSearch(data: unknown): string {
  const hits = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  const titles = hits
    .map((hit) => (isRecord(hit) ? String(hit.title ?? "").trim() : ""))
    .filter(Boolean)
    .slice(0, 3);
  if (!titles.length) return "I could not find a matching company document.";
  if (titles.length === 1) return `I found ${titles[0]}. What do you want from it?`;
  return `Across your documents I can see: ${titles.join("; ")}. Which should I open?`;
}

function outlookMessages(data: unknown): Array<Record<string, unknown>> {
  if (!isRecord(data)) return [];
  const rows = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(data.results)
      ? data.results
      : [];
  return rows.filter(isRecord).sort((a, b) => {
    const left = String(a.receivedDateTime ?? a.received ?? a.date ?? "");
    const right = String(b.receivedDateTime ?? b.received ?? b.date ?? "");
    return right.localeCompare(left);
  });
}

function firstMoney(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatMoney(value: number, currency: string): string {
  if (currency.toUpperCase() === "GBP" || currency === "£") {
    return `£${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isTimeout(result: IntelligenceToolResult): boolean {
  const blob = `${result.error ?? ""} ${isRecord(result.data) ? String(result.data.error ?? "") : ""}`;
  return result.error === "timeout" || /timeout|aborted|timed out/i.test(blob);
}

function isOutlookTool(name: string): boolean {
  return name.startsWith("outlook_");
}

function isXeroTool(name: string): boolean {
  return name.startsWith("xero_");
}

function isKnowledgeTool(name: string): boolean {
  return (
    name === "search_company_knowledge" ||
    name === "search_document" ||
    name === "get_knowledge_document" ||
    name === "fetch" ||
    name === "list_documents"
  );
}

export function defaultMailboxForText(text: string): string {
  if (/\bfinance\b/i.test(text)) return ELVEX_FINANCE_MAILBOXES[0];
  return ELVEX_INFO_MAILBOXES[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
