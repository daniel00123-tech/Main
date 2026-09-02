/**
 * Shared capability-family routing.
 * WhatsApp, Portal Chat, and ChatGPT intelligence use the same rules:
 * email → Outlook, process/policy → knowledge, Xero only for live finance.
 */

import { xeroAllowedForQuery } from "@infra/shared";
import type { ScopeDecision } from "./scope.js";

export function isXeroToolName(name: string): boolean {
  return name.startsWith("xero_");
}

export function isOutlookToolName(name: string): boolean {
  return name.startsWith("outlook_");
}

export function isKnowledgeToolName(name: string): boolean {
  return (
    name === "search_company_knowledge" ||
    name === "search_document" ||
    name === "get_knowledge_document" ||
    name === "fetch" ||
    name === "list_company_documents"
  );
}

export function honourScopedToolCall(
  scoped: Pick<ScopeDecision, "scope" | "tool" | "lastUserIntent" | "lastAnswerTopic">,
  requestedName: string,
): { name: string; overridden: boolean } {
  const wanted = scoped.tool;
  const emailTurn = scoped.lastAnswerTopic === "email" || scoped.lastUserIntent === "email";
  const financeTurn = scoped.lastAnswerTopic === "finance" || scoped.lastUserIntent === "finance";

  if (emailTurn && !isOutlookToolName(requestedName)) {
    return { name: wanted && isOutlookToolName(wanted) ? wanted : "outlook_search_mailbox", overridden: true };
  }
  if (wanted && isOutlookToolName(wanted) && !isOutlookToolName(requestedName)) {
    return { name: wanted, overridden: true };
  }
  if (
    (scoped.scope === "COMPANY_KNOWLEDGE" || scoped.scope === "CURRENT_DOCUMENT" || scoped.scope === "RECENT_ENTITY") &&
    isXeroToolName(requestedName)
  ) {
    return { name: wanted && isKnowledgeToolName(wanted) ? wanted : "search_company_knowledge", overridden: true };
  }
  if (wanted && isXeroToolName(wanted) && financeTurn && !isXeroToolName(requestedName) && !isOutlookToolName(requestedName)) {
    return { name: wanted, overridden: true };
  }
  if (wanted && scoped.scope === "BUSINESS_SYSTEM" && requestedName !== wanted) {
    if (isOutlookToolName(wanted) || (isXeroToolName(wanted) && !isOutlookToolName(requestedName))) {
      if (isXeroToolName(wanted) && isXeroToolName(requestedName)) {
        return { name: requestedName, overridden: false };
      }
      if (isOutlookToolName(wanted) && isOutlookToolName(requestedName)) {
        return { name: requestedName, overridden: false };
      }
      return { name: wanted, overridden: true };
    }
  }
  return { name: requestedName, overridden: false };
}

export function shouldRecoverAsFinance(
  text: string,
  scoped?: Partial<Pick<ScopeDecision, "scope" | "lastAnswerTopic" | "lastUserIntent">> | null,
): boolean {
  if (scoped?.lastAnswerTopic === "email" || scoped?.lastUserIntent === "email") return false;
  if (scoped?.scope === "COMPANY_KNOWLEDGE" || scoped?.scope === "CURRENT_DOCUMENT") return false;
  if (scoped?.lastAnswerTopic === "finance" || scoped?.lastUserIntent === "finance") return true;
  if (/\b(emails?|mailbox|outlook|inbox)\b/i.test(text)) return false;
  if (/\b(process|procedure|policy|handbook|guide|manual)\b/i.test(text) && !/\bxero\b/i.test(text)) {
    return false;
  }
  return xeroAllowedForQuery(text);
}

export function shouldRecoverAsEmail(
  text: string,
  scoped?: Partial<Pick<ScopeDecision, "scope" | "lastAnswerTopic" | "lastUserIntent" | "tool">> | null,
): boolean {
  if (scoped?.lastAnswerTopic === "email" || scoped?.lastUserIntent === "email") return true;
  if (scoped?.tool && isOutlookToolName(scoped.tool)) return true;
  return /\b(emails?|mailbox|outlook|inbox)\b/i.test(text) && !/\bxero\b/i.test(text);
}
