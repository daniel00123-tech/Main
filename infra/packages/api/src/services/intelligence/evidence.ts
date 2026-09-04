import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES } from "@infra/shared";
import {
  isKnowledgeToolName,
  isOutlookToolName,
  isXeroToolName,
  normaliseBusinessResult,
} from "./normalise.js";
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
      if (isOutlookToolName(failed.name)) return "Outlook is unreachable just now.";
      if (isXeroToolName(failed.name)) return "I couldn’t reach Xero just now.";
      if (isKnowledgeToolName(failed.name)) return "I couldn’t reach company files just now.";
      return "That connected system is unreachable just now.";
    }
    if (isOutlookToolName(failed.name)) return "I couldn’t retrieve that mailbox just now.";
    if (isXeroToolName(failed.name)) return "I couldn’t retrieve Xero data just now.";
    if (isKnowledgeToolName(failed.name)) return "I couldn’t search company files just now.";
    return "I couldn’t retrieve that just now.";
  }

  const lastOk = [...toolCalls].reverse().find((call) => call.ok);
  if (!lastOk) return null;
  if (isOutlookToolName(lastOk.name)) return summariseOutlookEvidence(lastOk.data);
  if (isXeroToolName(lastOk.name)) return summariseXeroEvidence(lastOk.data, lastOk.name);
  if (lastOk.name === "search_company_knowledge" || lastOk.name === "list_documents") {
    return normaliseBusinessResult(lastOk.name, lastOk.data).summaryText;
  }
  return null;
}

export function summariseOutlookEvidence(data: unknown): string {
  return normaliseBusinessResult("outlook_list_messages", data).summaryText;
}

export function summariseXeroEvidence(data: unknown, tool = "xero_sales_summary"): string {
  return normaliseBusinessResult(tool, data).summaryText;
}

function isTimeout(result: IntelligenceToolResult): boolean {
  const blob = `${result.error ?? ""} ${isRecord(result.data) ? String(result.data.error ?? "") : ""}`;
  return result.error === "timeout" || /timeout|aborted|timed out/i.test(blob);
}

export function defaultMailboxForText(text: string): string {
  if (/\bfinance\b/i.test(text)) return ELVEX_FINANCE_MAILBOXES[0];
  return ELVEX_INFO_MAILBOXES[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
