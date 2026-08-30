import {
  hasDocumentMemory,
  namesDifferentDocument,
  recentDocumentTitles,
  resolveRememberedDocument,
  type WhatsAppEntityMemory,
} from "./whatsapp-entities";
import { looksLikeWriteIntent, softenSearchQuery, focusSearchTerms } from "./whatsapp-intent";
import { DOCUMENT_CLARIFY_REPLY, isGenericDocumentAsk } from "./whatsapp-realtime";

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
  fact: "amount" | "who" | "summary" | "detail" | "alternatives" | "shorter" | "explain" | "reference" | null;
  draftKind: "reply" | "quote" | "method" | "professional" | "customer_update" | null;
};

export type WhatsAppPlanInput = {
  text: string;
  memory: WhatsAppEntityMemory;
  connectors: string[];
};

const CHAT =
  /^(hi+|h+ello+|hey+|hiya|morning|afternoon|evening|good (morning|afternoon|evening)|how are you|thanks|thank you|cheers|ta|hi there|hello there)[\s!.?]*$/i;
const CAPABILITIES =
  /^(what can you do|what can u do|what do you do|who are you|what are you|what is infra|can you help me|help)[\s!.?]*$/i;
export const DOCUMENT_URL_ASK =
  /\b(send me (the |that )?(link|url)|give me the (link|url)|what('?s| is) the (url|link)|url where|where (can|could|do) i (download|get|find)|need a copy|want a copy|can i download|download (it|this|that|the)|open the (source|document|file)|source link)\b/i;
const LINK = DOCUMENT_URL_ASK;
const SOURCE_ASK =
  /\b(where did you (get|find)|what('s| is) the source|source (for|of) that|where is this stored|is it in sharepoint|where is it stored)\b/i;
const AMOUNT = /\b(what was the (amount|figure)|how much|the amount|the figure again)\b/i;
const WHO = /\b(who sent|who from|who wrote|who is it from)\b/i;
const REFERENCE = /\b(what was the reference|the reference|ref(erence)? (was|is|again))\b/i;
const SUMMARY =
  /\b(summaris[ee] (it|that|this|the (difference|email|document))|what (was|is) (that|it|this) (document )?about)\b/i;
const DETAIL = /\b(more detail|full detail|give me the full|show me more|tell me more|explain properly|show me everything)\b/i;
const SHORTER = /\b(make (that|it|this)( \w+)? shorter|briefly|quick summary)\b/i;
const EXPLAIN = /\b(i don'?t understand|explain that( simply)?|what did you mean|can you explain)\b/i;
const ALTERNATIVES = /\b(what other docs|other documents|like this|alternatives|another document like)\b/i;
const COMPARE = /\b(compare (those |these |the )?two|compare them)\b/i;
const OTHER_ONE = /\b(the other one|that one|the second (document|one)|show me the second)\b/i;
const FINANCE = /\b(sales|revenue|profit|p&l|pnl|overdue|aged|who owes|xero|turnover|biggest customer|elvex)\b/i;
const INVOICE_FIND = /\b(find|show|get|open)\b.*\binvoice\b|\binvoice\b.*\b(find|show)\b/i;
const INVOICE_ID = /\b(inv[- ]?\d+|[A-Z]{2,}-?\d{3,})\b/i;
const POLICY = /\b(policy|guidance|procedure|quoting rules|how (do|should) we|instructions for)\b/i;
const PRICE = /\b(price|pricing|quote this|help me price|historical pricing)\b/i;
const DRAFT_REPLY = /\b(write (me )?(an? )?(customer )?(reply|email)|draft a reply|write an email|turn that into a (customer )?response)\b/i;
const DRAFT_QUOTE = /\b(draft a quote|turn that into a quote|create a quote|draft a quote summary)\b/i;
const DRAFT_METHOD = /\b(method statement|turn this into a method)\b/i;
const DRAFT_PRO = /\b(rewrite this professionally|more professionally|more professional)\b/i;
const ASKED_FOR = /\b(what did they (ask|say|want)|assumptions? did you use)\b/i;
const DRAFT_UPDATE = /\b(customer update|draft a customer update)\b/i;
const EMAIL = /\b(email|mailbox|outlook|inbox)\b/i;
const THAT_DOC = /^(show me )?(that|the) document\b|\bwhich one was first\b|\bfind the document\b|\bshow me that one\b/i;
const OPERATIONS = /\b(jobs? (due|today)|engineers? (working|busy)|operational information)\b/i;

function hasXero(connectors: string[]): boolean {
  return connectors.some((id) => id === "conn_xero");
}

export function looksLikeSourceLinkAsk(text: string): boolean {
  return LINK.test(text);
}

export function planWhatsAppTurn(
  input: WhatsAppPlanInput,
  runtime?: { planner?: { skipToolsOnCheapIntents?: boolean; preferMemoryOnFollowUp?: boolean; blockWriteIntents?: boolean } },
): WhatsAppPlan {
  const text = input.text.trim().replace(/[\u2018\u2019]/g, "'");
  const query = focusSearchTerms(softenSearchQuery(text));
  const memory = input.memory;
  const remembered = hasDocumentMemory(memory);
  const titles = recentDocumentTitles(memory);

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
    runtime?.planner?.blockWriteIntents !== false &&
    (looksLikeWriteIntent(text) ||
      /\b(send that invoice|approve that action|approve it)\b/i.test(text) ||
      /\bcreate a quote\b/i.test(text))
  ) {
    return { ...base(), action: "write_blocked", intent: "write_action", tool: null, skipTools: true };
  }
  if (CHAT.test(text)) {
    return { ...base(), action: "chat", intent: "greeting", tool: null, skipTools: true };
  }
  if (CAPABILITIES.test(text) || (/^(can you|could you)\b/i.test(text) && PRICE.test(text))) {
    return { ...base(), action: "capabilities", intent: "capabilities", tool: null, skipTools: true };
  }
  if (LINK.test(text)) {
    const askingForNewNamedDoc =
      /\b(find|search|look(?:ing)? (for|up)|anything about)\b/i.test(text) &&
      namesDifferentDocument(text, memory);
    if (askingForNewNamedDoc) {
      return { ...base(), action: "knowledge", intent: "knowledge_search", fetch: true, query: query || text };
    }
    if (titles.length >= 2 && /other one|that one|second|which/i.test(text)) {
      return {
        ...base(),
        action: "clarify",
        intent: "clarification",
        tool: null,
        skipTools: true,
        clarification: `Do you mean ${titles[0]} or ${titles[1]}?`,
      };
    }
    if (remembered) {
      return { ...base(), action: "memory_link", intent: "source_link", tool: null, skipTools: true, useMemory: true };
    }
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: "Which document would you like the link for?",
    };
  }

  if (SOURCE_ASK.test(text) && remembered) {
    return { ...base(), action: "memory_source", intent: "source_attribution", tool: null, skipTools: true, useMemory: true };
  }
  if (SOURCE_ASK.test(text) && !remembered) {
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: remembered
        ? `Do you mean the ${memory.lastDocument?.title} document we were just discussing?`
        : "Which document are you asking about?",
    };
  }

  if (OTHER_ONE.test(text) && titles.length >= 2) {
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: `Do you mean ${titles[0]} or ${titles[1]}?`,
    };
  }
  const financeCompare = Boolean(memory.lastDateRange) || FINANCE.test(text);
  if (COMPARE.test(text) && titles.length >= 2 && !financeCompare) {
    return {
      ...base(),
      action: "knowledge",
      intent: "knowledge_search",
      fetch: true,
      useMemory: true,
      query: `${titles[0]} ${titles[1]} compare`,
    };
  }
  if (COMPARE.test(text) && titles.length < 2 && !financeCompare) {
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: "Which two documents should I compare?",
    };
  }

  if (
    remembered &&
    (AMOUNT.test(text) ||
      WHO.test(text) ||
      REFERENCE.test(text) ||
      SUMMARY.test(text) ||
      DETAIL.test(text) ||
      SHORTER.test(text) ||
      EXPLAIN.test(text) ||
      ASKED_FOR.test(text) ||
      ALTERNATIVES.test(text))
  ) {
    const resolved = resolveRememberedDocument(memory, text) ?? memory.lastDocument;
    const fact = AMOUNT.test(text)
      ? "amount"
      : WHO.test(text)
        ? "who"
        : REFERENCE.test(text)
          ? "reference"
          : DETAIL.test(text)
            ? "detail"
            : SHORTER.test(text)
              ? "shorter"
              : EXPLAIN.test(text)
                ? "explain"
                : ALTERNATIVES.test(text)
                  ? "alternatives"
                  : "summary";
    if (fact === "alternatives" && resolved?.title) {
      return {
        ...base(),
        action: "knowledge",
        intent: "knowledge_search",
        fetch: false,
        useMemory: true,
        query: resolved.title,
        fact,
      };
    }
    return {
      ...base(),
      action: "memory_fact",
      intent: "clarification",
      tool: fact === "detail" || fact === "summary" ? "get_knowledge_document" : null,
      skipTools: fact === "amount" || fact === "who" || fact === "reference" || fact === "shorter" || fact === "explain",
      useMemory: true,
      fetch: fact === "detail" || fact === "summary",
      fact,
    };
  }

  if (EXPLAIN.test(text) || SHORTER.test(text) || /^i don'?t understand\b/i.test(text)) {
    return {
      ...base(),
      action: remembered ? "memory_fact" : "chat",
      intent: remembered ? "clarification" : "casual",
      tool: null,
      skipTools: true,
      useMemory: remembered,
      fact: EXPLAIN.test(text) ? "explain" : "shorter",
    };
  }

  if ((THAT_DOC.test(text) || OTHER_ONE.test(text)) && !remembered) {
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
    (/last month|this month|compare this month|compare them/i.test(text) || Boolean(memory.lastDateRange)) &&
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
          : /\bbiggest customer|elvex\b/i.test(text)
            ? "xero_search_contacts"
            : "xero_sales_summary";
    return { ...base(), action: "xero", intent: "finance_read", tool, query: text };
  }
  if (PRICE.test(text) && !/^(can you|could you|do you)\b/i.test(text)) {
    return { ...base(), action: "price", intent: "knowledge_search", fetch: true, needsGuidance: true, query: query || text };
  }
  if (POLICY.test(text) || OPERATIONS.test(text)) {
    return {
      ...base(),
      action: POLICY.test(text) ? "guidance" : "knowledge",
      intent: POLICY.test(text) ? "knowledge_search" : "operations_read",
      fetch: true,
      needsGuidance: POLICY.test(text),
      query: query || text,
    };
  }
  if (DRAFT_REPLY.test(text) || DRAFT_QUOTE.test(text) || DRAFT_METHOD.test(text) || DRAFT_PRO.test(text) || DRAFT_UPDATE.test(text)) {
    const draftKind = DRAFT_QUOTE.test(text)
      ? "quote"
      : DRAFT_METHOD.test(text)
        ? "method"
        : DRAFT_PRO.test(text)
          ? "professional"
          : DRAFT_UPDATE.test(text)
            ? "customer_update"
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
  if (isGenericDocumentAsk(text)) {
    return {
      ...base(),
      action: "clarify",
      intent: "clarification",
      tool: null,
      skipTools: true,
      clarification: DOCUMENT_CLARIFY_REPLY,
    };
  }
  const planned = {
    ...base(),
    action: "knowledge" as const,
    intent: "knowledge_search",
    fetch: true,
    query: query || text,
  };
  if (
    runtime?.planner?.skipToolsOnCheapIntents !== false &&
    (planned.intent === "greeting" || planned.intent === "capabilities" || planned.intent === "casual")
  ) {
    return { ...planned, skipTools: true, tool: null };
  }
  return planned;
}
