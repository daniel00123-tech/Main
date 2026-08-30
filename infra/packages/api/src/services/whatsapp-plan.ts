import { hasDocumentMemory, type WhatsAppEntityMemory } from "./whatsapp-entities";
import { looksLikeWriteIntent, softenSearchQuery, focusSearchTerms } from "./whatsapp-intent";

export type WhatsAppPlanAction =
  | "chat"
  | "capabilities"
  | "clarify"
  | "memory_link"
  | "memory_source"
  | "memory_fact"
  | "knowledge"
  | "xero"
  | "draft"
  | "price"
  | "guidance"
  | "write_blocked";

export type WhatsAppPlan = {
  action: WhatsAppPlanAction;
  intent: string;
  tool: string | null;
  query: string;
  fetch: boolean;
  skipTools: boolean;
  useMemory: boolean;
  needsGuidance: boolean;
  clarification: string | null;
  fact: "amount" | "who" | "summary" | "detail" | "alternatives" | null;
  draftKind: "reply" | "quote" | "method" | "professional" | null;
};

export type WhatsAppPlanInput = {
  text: string;
  memory: WhatsAppEntityMemory;
  connectors: string[];
};

const CHAT = /^(hi+|h+ello+|hey+|hiya|morning|afternoon|evening|good (morning|afternoon|evening)|how are you|thanks|thank you|cheers|ta)[\s!.?]*$/i;
const CAPABILITIES = /^(what can you do|what can u do|what do you do|who are you|what are you|what is infra|can you help me)\b/i;
const LINK = /\b(send me the link|give me the (link|url)|where is it|can i download|download it|open the source)\b/i;
const SOURCE_ASK = /\b(where did you get|what('s| is) the source|source (for|of) that)\b/i;
const AMOUNT = /\b(what was the amount|how much|the amount)\b/i;
const WHO = /\b(who sent|who from|who wrote)\b/i;
const SUMMARY =
  /\b(summaris[ee] (it|that|this|the difference)|what (was|is) (that|it|this) (document )?about)\b/i;
const DETAIL = /\b(more detail|full detail|give me the full|show me more)\b/i;
const ALTERNATIVES = /\b(what other docs|other documents|like this|alternatives)\b/i;
const FINANCE = /\b(sales|revenue|profit|p&l|pnl|overdue|aged|who owes|xero|turnover)\b/i;
const INVOICE_FIND = /\b(find|show|get|open)\b.*\binvoice\b|\binvoice\b.*\b(find|show)\b/i;
const INVOICE_ID = /\b(inv[- ]?\d+|[A-Z]{2,}-?\d{3,})\b/i;
const POLICY = /\b(policy|guidance|procedure|quoting rules|how (do|should) we)\b/i;
const PRICE = /\b(price|pricing|quote this|help me price|historical pricing)\b/i;
const DRAFT_REPLY = /\b(write (me )?a (customer )?reply|draft a reply|turn that into a (customer )?response)\b/i;
const DRAFT_QUOTE = /\b(draft a quote|turn that into a quote|create a quote)\b/i;
const DRAFT_METHOD = /\b(method statement|turn this into a method)\b/i;
const DRAFT_PRO = /\b(rewrite this professionally)\b/i;
const EMAIL = /\b(email|mailbox|outlook|inbox)\b/i;
const THAT_DOC = /^(show me )?(that|the) document\b|\bwhich one was first\b/i;

function hasXero(connectors: string[]): boolean {
  return connectors.some((id) => id === "conn_xero");
}

export function planWhatsAppTurn(input: WhatsAppPlanInput): WhatsAppPlan {
  const text = input.text.trim();
  const query = focusSearchTerms(softenSearchQuery(text));
  const memory = input.memory;
  const remembered = hasDocumentMemory(memory);

  const base = (): WhatsAppPlan => ({
    action: "knowledge",
    intent: "knowledge_search",
    tool: "search_company_knowledge",
    query,
    fetch: false,
    skipTools: false,
    useMemory: false,
    needsGuidance: false,
    clarification: null,
    fact: null,
    draftKind: null,
  });

  if (
    looksLikeWriteIntent(text) ||
    /\b(send that invoice|approve that action)\b/i.test(text) ||
    /\bcreate a quote\b/i.test(text)
  ) {
    return { ...base(), action: "write_blocked", intent: "write_action", tool: null, skipTools: true };
  }
  if (CHAT.test(text)) {
    return { ...base(), action: "chat", intent: "greeting", tool: null, skipTools: true };
  }
  if (CAPABILITIES.test(text) || (/^(can you|could you)\b/i.test(text) && PRICE.test(text))) {
    return { ...base(), action: "capabilities", intent: "capabilities", tool: null, skipTools: true };
  }
  if (LINK.test(text) && remembered) {
    return { ...base(), action: "memory_link", intent: "source_link", tool: null, skipTools: true, useMemory: true };
  }
  if (SOURCE_ASK.test(text) && remembered) {
    return { ...base(), action: "memory_source", intent: "source_attribution", tool: null, skipTools: true, useMemory: true };
  }
  if (remembered && (AMOUNT.test(text) || WHO.test(text) || SUMMARY.test(text) || DETAIL.test(text) || ALTERNATIVES.test(text))) {
    const fact = AMOUNT.test(text)
      ? "amount"
      : WHO.test(text)
        ? "who"
        : DETAIL.test(text)
          ? "detail"
          : ALTERNATIVES.test(text)
            ? "alternatives"
            : "summary";
    return {
      ...base(),
      action: "memory_fact",
      intent: "clarification",
      tool: fact === "alternatives" || fact === "detail" || fact === "summary" ? "get_knowledge_document" : null,
      skipTools: fact === "amount" || fact === "who",
      useMemory: true,
      fetch: fact === "detail" || fact === "summary",
      fact,
    };
  }
  if (THAT_DOC.test(text) && !remembered) {
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: "Which document do you mean — can you give me a name, date or a few words from it?",
    };
  }
  if (INVOICE_ID.test(text) && /\binvoice\b/i.test(text) && hasXero(input.connectors)) {
    return { ...base(), action: "xero", intent: "finance_read", tool: "xero_get_invoice", query: text };
  }
  if (INVOICE_FIND.test(text) && !INVOICE_ID.test(text) && !memory.lastInvoice) {
    return {
      ...base(),
      action: "clarify",
      intent: "finance_read",
      tool: null,
      skipTools: true,
      clarification: "Which invoice do you mean — do you have the invoice number, customer name or approximate date?",
    };
  }
  if (
    hasXero(input.connectors) &&
    (/last month|this month|compare this month/i.test(text) || Boolean(memory.lastDateRange)) &&
    /\b(what about|compare|sales|month|difference)\b/i.test(text) &&
    !/\b(document|doc|file|email|coal|arnold)\b/i.test(text)
  ) {
    return { ...base(), action: "xero", intent: "finance_read", tool: "xero_sales_summary", query: text };
  }
  if (FINANCE.test(text) && hasXero(input.connectors)) {
    const tool = /\boverdue|who owes|aged\b/i.test(text)
      ? "xero_list_overdue_invoices"
      : /\bprofit|p&l\b/i.test(text)
        ? "xero_profit_and_loss"
        : INVOICE_ID.test(text)
          ? "xero_get_invoice"
          : "xero_sales_summary";
    return { ...base(), action: "xero", intent: "finance_read", tool, query: text };
  }
  if (PRICE.test(text) && !/^(can you|could you|do you)\b/i.test(text)) {
    return { ...base(), action: "price", intent: "knowledge_search", fetch: true, needsGuidance: true, query: query || text };
  }
  if (POLICY.test(text)) {
    return { ...base(), action: "guidance", intent: "knowledge_search", fetch: true, needsGuidance: true, query: query || text };
  }
  if (DRAFT_REPLY.test(text) || DRAFT_QUOTE.test(text) || DRAFT_METHOD.test(text) || DRAFT_PRO.test(text)) {
    const draftKind = DRAFT_QUOTE.test(text)
      ? "quote"
      : DRAFT_METHOD.test(text)
        ? "method"
        : DRAFT_PRO.test(text)
          ? "professional"
          : "reply";
    return {
      ...base(),
      action: "draft",
      intent: "draft",
      tool: remembered ? null : "search_company_knowledge",
      skipTools: remembered,
      useMemory: remembered,
      needsGuidance: true,
      draftKind,
    };
  }
  if (EMAIL.test(text)) {
    return { ...base(), action: "knowledge", intent: "knowledge_search", fetch: true, query: query || text };
  }
  return {
    ...base(),
    action: "knowledge",
    intent: "knowledge_search",
    fetch: true,
    query: query || text,
  };
}
