import { businessToolForIntent, resolveBusinessSystemIntent } from "@infra/shared";
import type { IntelligenceConversationState, IntelligenceDocumentRef, IntelligenceScope } from "./types.js";
import { distinctiveTopicTokens, titleTokenOverlap, titleTokens } from "./titles.js";
import { isCatalogueListingAsk } from "../document-catalogue.js";

export type ScopeSwitch =
  | "company"
  | "system"
  | "current"
  | "recent"
  | "business"
  | "email"
  | "clear"
  | null;

export type ScopeFeatures = {
  quantityAsk: boolean;
  corpusNoun: boolean;
  contentMention: boolean;
  currentLocus: boolean;
  systemLocus: boolean;
  companyLocus: boolean;
  discourse: boolean;
  rephraseLastAnswer: boolean;
  memoryRecall: boolean;
  capabilityAsk: boolean;
  connectorAsk: boolean;
  financeAsk: boolean;
  emailAsk: boolean;
  writeIntent: boolean;
  findDocument: boolean;
  underspecifiedQuantity: boolean;
  sourceBreakdown: boolean;
  typeBreakdown: boolean;
  syncAsk: boolean;
  automationAsk: boolean;
  userOrCompanyAsk: boolean;
  adminOpsAsk: boolean;
  scopeSwitch: ScopeSwitch;
};

export type ScopeDecision = {
  scope: IntelligenceScope;
  features: ScopeFeatures;
  tool: string | null;
  noTool: boolean;
  clarify: boolean;
  clarifyText?: string;
  clearCurrentDocument: boolean;
  restoreRecentDocument: boolean;
  lastAnswerTopic: string | null;
  lastUserIntent: string;
  matchedDocument: IntelligenceDocumentRef | null;
};

const QUANTITY =
  /\b(how many|how much|how large|number of|count of|totals?|stocktake|headcount|inventory|volume of|numerically|dozens|hundreds|what(?:'s| is) the (total|count|number|volume)|quantity of|more \w+ or)\b/i;
const CORPUS =
  /\b(files?|documents?|docs?|items?( indexed)?|indexed (files?|documents?|items?|records?)|pdfs?|library|corpus|records?|index)\b/i;
const CONTENT_MENTION =
  /\b(mention|mentions|mentioned|about|contain|contains|containing|say|says|talk(?:s|ing)? about|cover(?:s|ing)?|refer(?:s|ring)? to)\b/i;
const CURRENT_LOCUS =
  /\b(this (document|doc|file)|that (document|doc|file)|the current (document|doc|file)|in (this|that|it|the file|the document)|only this (file|document|one)|just this (file|document)|inside (this|that) (file|document)|this one)\b/i;
const SYSTEM_LOCUS =
  /\b(on the system|in the system|the system|indexed|company[- ]wide|in total|across (the )?(system|company|everything)|whole system|entire system|everywhere|the platform|system (document )?count|system total|all (of )?(the )?(files|documents|docs) (on|in) (the )?(system|company))\b/i;
const COMPANY_LOCUS =
  /\b(all documents|all (the )?files|across (all )?(documents|files|docs)|search everywhere|the whole (library|corpus|set)|every (document|file)|company knowledge|other documents)\b/i;
const DISCOURSE =
  /^(hi|hello|hey|hiya|yo|morning|thanks|thank you|cheers|ta|thx|ty)\b|^(how are you|how(?:'s|s) it going)\b|\b(that(?:'s| is) useful|that helps|great thanks|appreciate (it|that)|i don'?t (understand|follow)|what do you mean|why did you ask|can you (give|show) (me )?an example)\b/i;
const REPHRASE =
  /\b(explain(?: that| this| it| your last answer)? more simply|more simply|make (that|it|this|your last answer)( \w+)? (shorter|simpler|brief)|in fewer words|more detail(s)?( on (that|your last|what you said))?|give me more (detail|details|info|information)|say that again|explain again|put (that|it) another way)\b/i;
const SHORT_REPHRASE = /^(more detail|what exactly)[.?!]*$/i;
const SHORT_MEMORY = /^(when|who)[.?!]*$/i;
const MEMORY =
  /\b(what (were|are) we talking about|what did i (just )?ask|what did you (just )?(tell|say)|remind me|which source|last document i asked|the amount again)\b/i;
const CAPABILITY =
  /^(help)\b|\b(what can you do|what can i ask|what (data|information) (can you|are you allowed to) (access|see|use|read)|what else (can|are) you (do|help|able)|what are you able to|who are you|what is infra|what information are you)\b/i;
const CONNECTOR =
  /\b(what systems? (are )?(connected|linked)|which (live )?systems?|what(?:'s| is) connected|connectors?|(is|are) (xero|sharepoint|drive|email|outlook) (connected|linked)|do (we|i|you) have (xero|sharepoint|drive|email) connected|systems can you (actually )?use)\b/i;
const FINANCE =
  /\b(sales|revenue|profit|p&l|pnl|overdue|xero|invoice|turnover|aged receivables|who owes)\b/i;
const EMAIL = /\b(emails?|emailed|emials|emaills|mailbox|outlook|inbox|any mail|e-mails?)\b/i;
const WRITE =
  /\b(create (an? )?(invoice|bill|credit)|approve |send(?: this| the)? invoice|delete |void |allocate |raise an invoice|write to|update (the )?(invoice|bill|contact)|credit note)\b/i;
const FIND =
  /\b((can you |could you |please )?(find|search|look(?:ing)? (for|up)|pull up)|have we got|where is)\b/i;
const NAMED_SWITCH_VERB =
  /^(?:can you |could you |please )?(?:open|find|search|look(?:ing)? (?:for|up)|pull up|show|get|go to|switch to)\b/i;
const SOURCE_OR_URL = /\b(source( url| link)?|the (url|link)|send me the (link|url))\b/i;
const GENERIC_SWITCH_TOPIC =
  /^(me |us )?(the |a |an |that |this |our |my )?(document|file|policy|one|it|that)s?[.?!]*$/i;
const FOLLOWUP_FILLER = /^(me )?(more )?(detail|details|info|information|summary|that|this|it)[.?!]*$/i;
const NOT_A_DOCUMENT_TOPIC = /\b(example|how you answer|more detail|the source|connected|unhealthy)\b/i;
const SOURCE_BREAKDOWN =
  /\b(where (are|do) (most|they|those)|by source|which source|most of them from|how many from|versus|sharepoint or|drive versus)\b/i;
const TYPE_BREAKDOWN = /\b(by (file )?type|what types?|how many (pdfs?|spreadsheets?|emails?))\b/i;
const SYNC_ASK =
  /\b(last sync|last (synced|updated)|when (did|was) .{0,40}(sync|synced|updated)|how fresh|freshness)\b/i;
const AUTOMATION = /\b(automations?|scheduled reports?|scheduled emails?|run now)\b/i;
const USER_COMPANY =
  /\b(how many (users|people)|who has access|which companies|what companies|this tenant)\b/i;
const SYSTEM_OVERVIEW = /\b(system snapshot|system summary|platform snapshot)\b/i;
const ADMIN_OPS =
  /\b(whatsapp volume|failure rate|latency|unhealthy connectors?|connectors? unhealthy|quality loop|platform health)\b/i;
const NAMED_FILE = /\b\w+\.(pdf|docx?|xlsx?|pptx?)\b/i;
const GENERIC_FIND =
  /^(please )?(can you )?(find|search|look(?:ing)? (for|up)|pull up|open|have we got) (me )?(the |a |that )?(document|file|policy)[.?!]*$/i;
const UNDERSPECIFIED_QUANTITY = /^(how many( are there)?|and (the )?total|the count)\b[.?!]*$/i;

function namedFindTopic(text: string): string {
  return text
    .replace(NAMED_SWITCH_VERB, "")
    .replace(FIND, "")
    .replace(/[.?!]+$/g, "")
    .replace(/^(me |us |the |a |an |that |this |our |my )/i, "")
    .trim();
}

function isNamedDocumentFind(trimmed: string): boolean {
  if (GENERIC_FIND.test(trimmed) || SOURCE_OR_URL.test(trimmed) || NOT_A_DOCUMENT_TOPIC.test(trimmed)) {
    return false;
  }
  const wantsFind = FIND.test(trimmed) || NAMED_SWITCH_VERB.test(trimmed);
  if (!wantsFind) return false;
  if (NAMED_FILE.test(trimmed) || COMPANY_LOCUS.test(trimmed) || trimmed.split(/\s+/).length >= 5) {
    return true;
  }
  return distinctiveTopicTokens(namedFindTopic(trimmed)).length >= 1;
}

const PERIOD_FOLLOW =
  /\b(today|yesterday|(this|last|past|previous)( \d+)? (days?|weeks?|months?|quarters?|years?))\b|\b(what about|how about|and) (this|last|yesterday|today|it)\b|\b(compare|versus|\bvs\.?\b) (them|that|this|last|the)\b/i;

function isFinancePeriodFollowUp(
  text: string,
  state: Pick<IntelligenceConversationState, "lastAnswerTopic" | "currentScope" | "currentBusinessSystem">,
  features: ScopeFeatures,
): boolean {
  const onFinance =
    state.lastAnswerTopic === "finance" ||
    state.currentScope === "BUSINESS_SYSTEM" ||
    state.currentBusinessSystem === "xero";
  if (!onFinance) return false;
  if (features.findDocument || features.emailAsk || features.quantityAsk || features.writeIntent || features.capabilityAsk) {
    return false;
  }
  return features.financeAsk || PERIOD_FOLLOW.test(text);
}

function pickBusinessTool(text: string, lastSuccessfulTool?: string | null): string {
  const intent = resolveBusinessSystemIntent(text) ?? {
    capability: "xero" as const,
    connectorDefinitionId: "conn_xero",
    namedExplicitly: /\bxero\b/i.test(text),
    reason: "domain_language" as const,
  };
  const mapped = businessToolForIntent(
    intent.capability === "xero" || intent.capability === "payments"
      ? intent
      : { ...intent, capability: "xero", connectorDefinitionId: "conn_xero" },
    text,
  );
  if (mapped?.toolName.startsWith("xero_")) return mapped.toolName;
  if (/overdue|owes/i.test(text)) return "xero_list_overdue_invoices";
  if (/p&l|pnl|profit/i.test(text)) return "xero_profit_and_loss";
  if (/aged/i.test(text)) return "xero_aged_receivables";
  if (/INV-|\binvoice\b.*\d/i.test(text)) return "xero_get_invoice";
  if (lastSuccessfulTool && /^xero_/.test(lastSuccessfulTool)) return lastSuccessfulTool;
  return "xero_sales_summary";
}

function pickMailboxTool(text: string): string {
  if (/\bfrom\s+[A-Za-z]{2,}|containing|has \w+ sent|with \w+ in the subject\b/i.test(text)) {
    return "outlook_search_mailbox";
  }
  if (/\b(full|body|what does .{0,40}(say|said))\b/i.test(text)) return "outlook_list_messages";
  if (/\b(newest|latest|last \d|last five|unread|most recently|arrived today|last 5|who emailed)\b/i.test(text)) {
    return "outlook_list_messages";
  }
  return "outlook_search_mailbox";
}

function extractFeatures(text: string): ScopeFeatures {
  const trimmed = text.trim();
  return {
    quantityAsk: QUANTITY.test(trimmed),
    corpusNoun: CORPUS.test(trimmed),
    contentMention: CONTENT_MENTION.test(trimmed),
    currentLocus: CURRENT_LOCUS.test(trimmed),
    systemLocus: SYSTEM_LOCUS.test(trimmed),
    companyLocus: COMPANY_LOCUS.test(trimmed),
    discourse: DISCOURSE.test(trimmed),
    rephraseLastAnswer: REPHRASE.test(trimmed) || SHORT_REPHRASE.test(trimmed),
    memoryRecall: MEMORY.test(trimmed) || SHORT_MEMORY.test(trimmed),
    capabilityAsk: CAPABILITY.test(trimmed),
    connectorAsk: CONNECTOR.test(trimmed),
    financeAsk: FINANCE.test(trimmed),
    emailAsk: EMAIL.test(trimmed) && !CORPUS.test(trimmed),
    writeIntent: WRITE.test(trimmed),
    findDocument: isNamedDocumentFind(trimmed),
    underspecifiedQuantity: UNDERSPECIFIED_QUANTITY.test(trimmed),
    sourceBreakdown: SOURCE_BREAKDOWN.test(trimmed),
    typeBreakdown: TYPE_BREAKDOWN.test(trimmed),
    syncAsk: SYNC_ASK.test(trimmed),
    automationAsk: AUTOMATION.test(trimmed),
    userOrCompanyAsk: USER_COMPANY.test(trimmed) || SYSTEM_OVERVIEW.test(trimmed),
    adminOpsAsk: ADMIN_OPS.test(trimmed),
    scopeSwitch: detectScopeSwitch(trimmed),
  };
}

function detectScopeSwitch(text: string): ScopeSwitch {
  if (/\b(forget (the |that |this )?(current )?(document|file|cv|profile)|drop (the|that) (document|file)|never mind (the|that) (document|file))\b/i.test(text)) {
    return "clear";
  }
  if (/\b(only this (file|document|one)|just this (file|document)|stay on this (file|document)|in this (file|document) only)\b/i.test(text)) {
    return "current";
  }
  if (/\b(go back|previous (document|file|one)|return to (the )?(previous|last|earlier)|the (document|file) before|last one we had open|the last one we had)\b/i.test(text)) {
    return "recent";
  }
  if (/\binstead of this (file|document)|don'?t look in this (file|document)\b/i.test(text)) {
    if (/\bxero\b/i.test(text)) return "business";
    return /\b(system|count|total|indexed)\b/i.test(text) ? "system" : "company";
  }
  if (/\banother (document|file|policy|one) like\b/i.test(text)) {
    return "company";
  }
  if (/\b(i meant (the )?(whole system|all (documents|files)|company[- ]wide)|across all (documents|files)|search everywhere|whole system|all documents)\b/i.test(text)) {
    return /\b(system|indexed|how many|count|total)\b/i.test(text) ? "system" : "company";
  }
  if (/\b(all documents|all (the )?files|across (all )?(documents|files)|search everywhere|company[- ]wide|whole (library|corpus))\b/i.test(text)) {
    return "company";
  }
  if (/\b(whole system|on the system|entire system|the platform)\b/i.test(text)) {
    return "system";
  }
  if (/\b(i )?meant (the )?(xero|sales|invoices?)\b/i.test(text) && !/\b(email|mailbox|outlook|inbox)\b/i.test(text)) {
    return "business";
  }
  if (/\b(i )?meant (the )?(email|emails|mailbox|outlook|inbox)\b/i.test(text)) {
    return "email";
  }
  if (
    (/\bxero\b/i.test(text) || /\b(finance|invoices?|sales figures)\b/i.test(text)) &&
    /\b(switch|instead|use|check|meant)\b/i.test(text) &&
    !/\b(emails?|mailbox|outlook|inbox)\b/i.test(text)
  ) {
    return "business";
  }
  if (/\b(emails?|emials|mailbox|outlook)\b/i.test(text) && /\b(instead|switch|search|check|from|meant)\b/i.test(text)) {
    return "email";
  }
  return null;
}

function rememberedDocuments(
  state: Pick<IntelligenceConversationState, "currentDocument" | "recentDocuments" | "entities">,
): IntelligenceDocumentRef[] {
  const seen = new Set<string>();
  const docs: IntelligenceDocumentRef[] = [];
  for (const doc of [...(state.recentDocuments ?? []), ...(state.entities ?? []).map((entity) => ({
    id: entity.id,
    title: entity.title,
    url: entity.url,
  }))]) {
    if (!doc?.id || !doc.title || seen.has(doc.id)) continue;
    seen.add(doc.id);
    docs.push(doc);
  }
  return docs;
}

export function detectNamedDocumentSwitch(
  text: string,
  state: Pick<IntelligenceConversationState, "currentDocument" | "recentDocuments" | "entities">,
): { target: "company" | "recent"; matchedDocument: IntelligenceDocumentRef | null } | null {
  const trimmed = text.trim();
  if (!NAMED_SWITCH_VERB.test(trimmed)) return null;
  if (SOURCE_OR_URL.test(trimmed) && !/\b(find|search|look(?:ing)? (?:for|up)|pull up|go to|switch to)\b/i.test(trimmed)) {
    return null;
  }
  const topic = trimmed
    .replace(NAMED_SWITCH_VERB, "")
    .replace(/[.?!]+$/g, "")
    .replace(/^(me |us |the |a |an |that |this |our |my )/i, "")
    .trim();
  if (!topic || GENERIC_SWITCH_TOPIC.test(topic) || FOLLOWUP_FILLER.test(topic) || NOT_A_DOCUMENT_TOPIC.test(topic)) {
    return null;
  }
  const strong = distinctiveTopicTokens(topic);
  if (!strong.length) return null;
  const currentTitle = state.currentDocument?.title ?? "";
  const currentHits = titleTokenOverlap(topic, currentTitle);
  if (state.currentDocument && (currentHits >= 2 || (strong.length === 1 && titleTokens(currentTitle).includes(strong[0]!)))) {
    return null;
  }
  const remembered = rememberedDocuments(state).filter((doc) => doc.id !== state.currentDocument?.id);
  const matched = remembered.find((doc) => titleTokenOverlap(topic, doc.title) >= 2) ?? null;
  if (matched) return { target: "recent", matchedDocument: matched };
  return { target: "company", matchedDocument: null };
}

export function isCorpusInventoryAsk(text: string): boolean {
  const features = extractFeatures(text);
  return features.quantityAsk && features.corpusNoun && !features.contentMention;
}

export function classifyScope(
  text: string,
  state: Pick<
    IntelligenceConversationState,
    | "currentDocument"
    | "currentScope"
    | "lastAnswerTopic"
    | "lastUserIntent"
    | "userCorrection"
    | "recentDocuments"
    | "currentBusinessSystem"
    | "lastSuccessfulTool"
  >,
): ScopeDecision {
  const features = extractFeatures(text);
  const hasCurrent = Boolean(state.currentDocument);
  const lastTopic = state.lastAnswerTopic ?? null;
  const switchTo = features.scopeSwitch;
  const namedSwitch = detectNamedDocumentSwitch(text, state);
  const financeFollowUp = isFinancePeriodFollowUp(text, state, features);

  if (features.writeIntent) {
    return decide("CONTROLLED_ACTION", features, {
      tool: null,
      noTool: true,
      lastUserIntent: "controlled_action",
    });
  }

  if (features.adminOpsAsk) {
    return decide("SYSTEM_META", features, {
      tool: "get_company_system_summary",
      lastAnswerTopic: "admin_ops",
      lastUserIntent: "admin_ops",
    });
  }

  if (features.capabilityAsk && !features.quantityAsk) {
    return decide("CONNECTOR_CAPABILITY", features, {
      tool: "get_user_capabilities",
      lastAnswerTopic: "capabilities",
      lastUserIntent: "capabilities",
    });
  }

  if (features.connectorAsk && !features.quantityAsk) {
    return decide("CONNECTOR_CAPABILITY", features, {
      tool: "get_connector_status",
      lastAnswerTopic: "connectors",
      lastUserIntent: "connectors",
    });
  }

  if (
    /\b(sales|xero)\b/i.test(text) &&
    /\b(and then|then show|and show)\b/i.test(text) &&
    /\b(email|inbox)\b/i.test(text) &&
    !features.writeIntent
  ) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: "xero_sales_summary",
      lastAnswerTopic: "finance",
      lastUserIntent: "finance",
    });
  }

  const businessIntent = resolveBusinessSystemIntent(text);
  const mailboxIntent =
    businessIntent?.capability === "finance_mailbox" ||
    businessIntent?.capability === "info_mailbox" ||
    businessIntent?.connectorDefinitionId === "conn_outlook_shared";
  if (
    businessIntent &&
    mailboxIntent &&
    !features.connectorAsk &&
    !features.capabilityAsk &&
    !features.writeIntent
  ) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: pickMailboxTool(text),
      lastAnswerTopic: "email",
      lastUserIntent: "email",
    });
  }
  if (/\bemails? behind\b/i.test(text) && !features.writeIntent) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: "outlook_search_mailbox",
      lastAnswerTopic: "email",
      lastUserIntent: "email",
    });
  }
  if (
    (lastTopic === "email" || state.currentBusinessSystem === "email") &&
    PERIOD_FOLLOW.test(text) &&
    !features.financeAsk &&
    !features.writeIntent
  ) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: pickMailboxTool(text),
      lastAnswerTopic: "email",
      lastUserIntent: "email",
    });
  }
  if (
    businessIntent &&
    !features.connectorAsk &&
    !features.capabilityAsk &&
    !features.systemLocus &&
    !features.companyLocus &&
    !switchTo &&
    !features.emailAsk &&
    businessIntent.capability !== "admin" &&
    businessIntent.capability !== "restricted_knowledge"
  ) {
    if (businessIntent.capability === "payments" || features.writeIntent) {
      return decide("CONTROLLED_ACTION", features, {
        tool: null,
        noTool: true,
        lastUserIntent: "controlled_action",
      });
    }
    if (
      businessIntent.capability === "finance_mailbox" ||
      businessIntent.capability === "info_mailbox" ||
      businessIntent.connectorDefinitionId === "conn_outlook_shared"
    ) {
      return decide("BUSINESS_SYSTEM", features, {
        tool: pickMailboxTool(text),
        lastAnswerTopic: "email",
        lastUserIntent: "email",
      });
    }
    if (businessIntent.capability === "xero" || businessIntent.connectorDefinitionId === "conn_xero") {
      return decide("BUSINESS_SYSTEM", features, {
        tool: pickBusinessTool(text, state.lastSuccessfulTool),
        lastAnswerTopic: "finance",
        lastUserIntent: "finance",
      });
    }
    return decide("BUSINESS_SYSTEM", features, {
      tool: null,
      noTool: true,
      lastAnswerTopic: businessIntent.connectorDefinitionId.replace(/^conn_/, ""),
      lastUserIntent: "business_system",
    });
  }

  if (isCatalogueListingAsk(text) && !features.financeAsk && !features.writeIntent) {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: "list_documents",
      lastAnswerTopic: "document_catalogue",
      lastUserIntent: "document_catalogue",
    });
  }

  const allowNamedSwitch =
    hasCurrent &&
    Boolean(namedSwitch) &&
    !features.financeAsk &&
    !features.emailAsk &&
    !features.quantityAsk &&
    !features.capabilityAsk &&
    !features.connectorAsk &&
    !features.writeIntent;

  if (allowNamedSwitch && namedSwitch?.target === "recent" && namedSwitch.matchedDocument) {
    return decide("RECENT_ENTITY", features, {
      tool: "get_knowledge_document",
      restoreRecentDocument: true,
      matchedDocument: namedSwitch.matchedDocument,
      lastAnswerTopic: "document",
      lastUserIntent: "named_recent_document",
    });
  }

  if (allowNamedSwitch && namedSwitch?.target === "company") {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: "search_company_knowledge",
      clearCurrentDocument: hasCurrent,
      lastAnswerTopic: "company_knowledge",
      lastUserIntent: "named_document_switch",
    });
  }

  if (switchTo === "recent") {
    const remembered = rememberedDocuments(state);
    const namedRecent =
      remembered.find((doc) => titleTokenOverlap(text, doc.title) >= 2) ??
      remembered.find((doc) => doc.id !== state.currentDocument?.id) ??
      remembered[0] ??
      null;
    return decide("RECENT_ENTITY", features, {
      tool: "get_knowledge_document",
      restoreRecentDocument: true,
      matchedDocument: namedRecent,
      lastAnswerTopic: "document",
      lastUserIntent: "restore_recent",
    });
  }

  if (features.rephraseLastAnswer) {
    return decide("GENERAL_CONVERSATION", features, {
      tool: null,
      noTool: true,
      lastAnswerTopic: lastTopic,
      lastUserIntent: "rephrase",
    });
  }

  if (features.memoryRecall && !features.quantityAsk && !features.findDocument && !features.financeAsk) {
    return decide("GENERAL_CONVERSATION", features, {
      tool: null,
      noTool: true,
      lastAnswerTopic: lastTopic,
      lastUserIntent: "memory",
    });
  }

  if (features.discourse && !features.quantityAsk && !features.findDocument && !features.financeAsk && !features.connectorAsk) {
    return decide("GENERAL_CONVERSATION", features, {
      tool: null,
      noTool: true,
      lastUserIntent: "conversation",
    });
  }

  if (features.automationAsk && !features.findDocument) {
    return decide("SYSTEM_META", features, {
      tool: "get_active_automations",
      lastAnswerTopic: "automations",
      lastUserIntent: "automations",
    });
  }

  if (features.userOrCompanyAsk) {
    return decide("SYSTEM_META", features, {
      tool: "get_company_system_summary",
      lastAnswerTopic: "company_summary",
      lastUserIntent: "company_summary",
    });
  }

  if (features.syncAsk && !features.contentMention && !features.findDocument) {
    return decide("SYSTEM_META", features, {
      tool: "get_recent_sync_status",
      lastAnswerTopic: "index_stats",
      lastUserIntent: "sync_status",
    });
  }

  if (features.underspecifiedQuantity) {
    if (lastTopic === "index_stats" || state.currentScope === "SYSTEM_META") {
      return decide("SYSTEM_META", features, {
        tool: features.sourceBreakdown ? "get_document_index_stats" : "get_document_index_stats",
        lastAnswerTopic: "index_stats",
        lastUserIntent: "index_followup",
      });
    }
    if (hasCurrent && (lastTopic === "document" || state.currentScope === "CURRENT_DOCUMENT")) {
      return decide("CURRENT_DOCUMENT", features, {
        tool: "search_document",
        lastAnswerTopic: "document",
        lastUserIntent: "document_followup",
      });
    }
    return decide("AMBIGUOUS", features, {
      tool: null,
      noTool: true,
      clarify: true,
      clarifyText: "Do you mean how many documents are indexed for the company, or something in the current file?",
      lastUserIntent: "ambiguous_quantity",
    });
  }

  if (features.quantityAsk && features.corpusNoun && features.contentMention && features.currentLocus) {
    return decide("CURRENT_DOCUMENT", features, {
      tool: "search_document",
      lastAnswerTopic: "document",
      lastUserIntent: "document_mention_count",
    });
  }

  if (features.quantityAsk && features.corpusNoun && features.contentMention && !features.currentLocus) {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: "search_company_knowledge",
      clearCurrentDocument: switchTo === "company" || switchTo === "system" || Boolean(state.userCorrection && (features.companyLocus || features.systemLocus)),
      lastAnswerTopic: "company_knowledge",
      lastUserIntent: "company_mention_count",
    });
  }

  if (features.quantityAsk && features.corpusNoun && !features.contentMention) {
    if (features.currentLocus && !features.systemLocus && !features.companyLocus) {
      return decide("CURRENT_DOCUMENT", features, {
        tool: "search_document",
        lastAnswerTopic: "document",
        lastUserIntent: "document_quantity",
      });
    }
    return decide("SYSTEM_META", features, {
      tool: features.sourceBreakdown || features.typeBreakdown ? "get_document_index_stats" : "get_document_index_stats",
      clearCurrentDocument: Boolean(state.userCorrection && (features.systemLocus || features.companyLocus || switchTo === "system")),
      lastAnswerTopic: "index_stats",
      lastUserIntent: "index_stats",
    });
  }

  if (
    (features.sourceBreakdown || features.typeBreakdown) &&
    (lastTopic === "index_stats" ||
      state.currentScope === "SYSTEM_META" ||
      features.corpusNoun ||
      features.quantityAsk)
  ) {
    return decide("SYSTEM_META", features, {
      tool: "get_document_index_stats",
      lastAnswerTopic: "index_stats",
      lastUserIntent: "index_followup",
    });
  }

  if (switchTo === "system" || (state.userCorrection && features.systemLocus)) {
    return decide(features.contentMention ? "COMPANY_KNOWLEDGE" : "SYSTEM_META", features, {
      tool: features.contentMention ? "search_company_knowledge" : "get_document_index_stats",
      clearCurrentDocument: true,
      lastAnswerTopic: features.contentMention ? "company_knowledge" : "index_stats",
      lastUserIntent: "scope_switch_system",
    });
  }

  if (switchTo === "company" || (state.userCorrection && features.companyLocus)) {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: "search_company_knowledge",
      clearCurrentDocument: true,
      lastAnswerTopic: "company_knowledge",
      lastUserIntent: "scope_switch_company",
    });
  }

  if (switchTo === "clear") {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: features.findDocument ? "search_company_knowledge" : null,
      noTool: !features.findDocument,
      clearCurrentDocument: true,
      lastUserIntent: "clear_document",
    });
  }

  if (switchTo === "current") {
    return decide("CURRENT_DOCUMENT", features, {
      tool: hasCurrent ? "search_document" : null,
      noTool: !hasCurrent,
      clarify: !hasCurrent,
      clarifyText: hasCurrent ? undefined : "I don’t have a current file open. Which document should I stay on?",
      lastAnswerTopic: "document",
      lastUserIntent: "lock_current_document",
    });
  }

  if (
    switchTo === "business" ||
    financeFollowUp ||
    (features.financeAsk && (!features.corpusNoun || /\bxero\b/i.test(text)) && (!features.currentLocus || /\bxero\b/i.test(text) || switchTo === "business"))
  ) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: pickBusinessTool(text, state.lastSuccessfulTool),
      lastAnswerTopic: "finance",
      lastUserIntent: "finance",
    });
  }

  if (switchTo === "email" || (features.emailAsk && !features.currentLocus && !hasCurrent)) {
    return decide("BUSINESS_SYSTEM", features, {
      tool: pickMailboxTool(text),
      lastAnswerTopic: "email",
      lastUserIntent: "email",
    });
  }

  if (features.findDocument && (!hasCurrent || !features.currentLocus || /\banother\b/i.test(text))) {
    return decide("COMPANY_KNOWLEDGE", features, {
      tool: "search_company_knowledge",
      clearCurrentDocument: Boolean(hasCurrent && !features.currentLocus),
      lastAnswerTopic: "company_knowledge",
      lastUserIntent: "find_document",
    });
  }

  if (features.currentLocus && hasCurrent) {
    return decide("CURRENT_DOCUMENT", features, {
      tool: "search_document",
      lastAnswerTopic: "document",
      lastUserIntent: "current_document",
    });
  }

  if (hasCurrent && !features.systemLocus && !features.companyLocus && !features.financeAsk && !features.capabilityAsk) {
    if (/\b(where did you get|source (url|link)|open the source)\b/i.test(text)) {
      return decide("CURRENT_DOCUMENT", features, {
        tool: "get_knowledge_document",
        lastAnswerTopic: "document",
        lastUserIntent: "source",
      });
    }
    return decide("CURRENT_DOCUMENT", features, {
      tool: "search_document",
      lastAnswerTopic: "document",
      lastUserIntent: "current_document",
    });
  }

  if (
    !hasCurrent &&
    !features.findDocument &&
    !NAMED_FILE.test(text) &&
    !features.quantityAsk &&
    (/\b(the policy|that file|the document|the other one)\b/i.test(text) ||
      /\b((send me )?(the )?(url|link)|download it|copy of it)\b/i.test(text))
  ) {
    return decide("AMBIGUOUS", features, {
      tool: null,
      noTool: true,
      clarify: true,
      clarifyText: "Which document do you mean?",
      lastUserIntent: "ambiguous_document",
    });
  }

  if (state.recentDocuments && state.recentDocuments.length > 0 && /\b(that (one|file|document)|the last one)\b/i.test(text)) {
    return decide("RECENT_ENTITY", features, {
      tool: "get_knowledge_document",
      restoreRecentDocument: true,
      lastAnswerTopic: "document",
      lastUserIntent: "recent_entity",
    });
  }

  return decide("COMPANY_KNOWLEDGE", features, {
    tool: "search_company_knowledge",
    lastAnswerTopic: /\b(po process|purchase order)\b/i.test(text) ? "the PO process" : "company_knowledge",
    lastUserIntent: "company_knowledge",
  });
}

function decide(
  scope: IntelligenceScope,
  features: ScopeFeatures,
  extra: Partial<Omit<ScopeDecision, "scope" | "features">>,
): ScopeDecision {
  return {
    scope,
    features,
    tool: extra.tool ?? null,
    noTool: Boolean(extra.noTool),
    clarify: Boolean(extra.clarify),
    clarifyText: extra.clarifyText,
    clearCurrentDocument: Boolean(extra.clearCurrentDocument),
    restoreRecentDocument: Boolean(extra.restoreRecentDocument),
    lastAnswerTopic: extra.lastAnswerTopic ?? null,
    lastUserIntent: extra.lastUserIntent ?? scope.toLowerCase(),
    matchedDocument: extra.matchedDocument ?? null,
  };
}

export function persistableScope(scope: IntelligenceScope): IntelligenceScope | null {
  if (scope === "GENERAL_CONVERSATION" || scope === "AMBIGUOUS") return null;
  return scope;
}
