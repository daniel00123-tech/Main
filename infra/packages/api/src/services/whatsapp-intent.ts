export const WHATSAPP_INTENTS = [
  "greeting",
  "thanks",
  "help",
  "capabilities",
  "casual",
  "knowledge_search",
  "finance_read",
  "operations_read",
  "connector_read",
  "automation_query",
  "write_action",
  "clarification",
  "unsupported",
] as const;

export type WhatsAppIntent = (typeof WHATSAPP_INTENTS)[number];

const WRITE_INTENT =
  /\b(create (an? )?(invoice|bill|credit)|approve |send(?: this| the)? invoice|delete |void |allocate |raise an invoice|write to|update (the )?(invoice|bill|contact)|credit note)\b/i;

const GREETING =
  /^(hi+|h+ello+|hey+|hiya|yo|howdy|morning|good morning|afternoon|good afternoon|evening|good evening)[\s!.?]*$/i;
const THANKS = /^(thanks|thank you|cheers|ta|thx|ty)[\s!.?]*$/i;
const HOW_ARE_YOU = /^(how are you|how's it going|hows it going|you ok|you okay)[\s!.?]*$/i;
const HELP = /^(help|what can you do|what can u do|what do you do|who are you|what are you|what is infra|what's infra|whats infra)\b/i;
const CAN_YOU = /^(can you|could you|do you|are you able to)\b/i;
const ACTION_REQUEST =
  /\b(find|search|look(?:ing)? (for|up)|show|fetch|open|read|summarise|summarize|check|get|tell me)\b/i;
const FINANCE =
  /\b(sales|revenue|profit|p&l|pnl|invoices?|aged|balance|contacts?|xero|turnover|vat)\b/i;
const OPERATIONS = /\b(jobs?|work orders?|engineers?|visits?|bigchange|commusoft|schedule|diary)\b/i;
const AUTOMATION = /\b(automations?|scheduled (report|email)|run now)\b/i;
const SEARCH =
  /\b(find|search|look(?:ing)? (for|up)|open|read|show|fetch|summarise|summarize|what does|what is|tell me|relates? to|document|doc|file|email|sharepoint|onedrive|coal|rental|arnold)\b/i;
const CLARIFICATION =
  /^(what about last|what about this|and (last|this)|that one|summarise that|summarize that|more detail|the previous|last month|this month)\b/i;

export function looksLikeWriteIntent(text: string): boolean {
  return WRITE_INTENT.test(text);
}

export function isCheapConversationalIntent(intent: WhatsAppIntent): boolean {
  return intent === "greeting" || intent === "thanks" || intent === "help" || intent === "capabilities" || intent === "casual";
}

export function needsToolWork(intent: WhatsAppIntent): boolean {
  return (
    intent === "knowledge_search" ||
    intent === "finance_read" ||
    intent === "operations_read" ||
    intent === "connector_read" ||
    intent === "automation_query" ||
    intent === "clarification"
  );
}

export function classifyWhatsAppIntent(
  text: string,
  options?: { hasPriorTurns?: boolean },
): WhatsAppIntent {
  const trimmed = text.trim();
  if (!trimmed) return "unsupported";
  if (WRITE_INTENT.test(trimmed)) return "write_action";
  if (GREETING.test(trimmed)) return "greeting";
  if (THANKS.test(trimmed)) return "thanks";
  if (HOW_ARE_YOU.test(trimmed)) return "casual";
  if (HELP.test(trimmed)) return "capabilities";
  if (CAN_YOU.test(trimmed) && !ACTION_REQUEST.test(trimmed) && !FINANCE.test(trimmed)) {
    return "capabilities";
  }
  if (options?.hasPriorTurns && CLARIFICATION.test(trimmed)) {
    if (FINANCE.test(trimmed)) return "finance_read";
    return "clarification";
  }
  if (AUTOMATION.test(trimmed)) return "automation_query";
  if (FINANCE.test(trimmed)) return "finance_read";
  if (OPERATIONS.test(trimmed)) return "operations_read";
  if (SEARCH.test(trimmed)) return "knowledge_search";
  if (trimmed.split(/\s+/).length <= 3 && !/[?]/.test(trimmed)) return "unsupported";
  return "knowledge_search";
}

/** Cheap typo softening for read/search only. Never used to infer write actions. */
export function softenSearchQuery(text: string): string {
  let next = text;
  if (/\b(cold|col+d)\b/i.test(next) && /\b(serch|search|doc|document)\b/i.test(next)) {
    next = next.replace(/\b(cold|col+d)\b/gi, "coal");
  }
  next = next.replace(/\bserch\b/gi, "search");
  next = next.replace(/\bdocumnet\b/gi, "document");
  next = next.replace(/\bsumarise\b/gi, "summarise");
  next = next.replace(/\barno+ld\b/gi, "Arnold");
  return next;
}
