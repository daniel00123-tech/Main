/**
 * Internal evidence planning. Never expose subtask names to users.
 */

export type EvidenceSubtask =
  | "finance.metric"
  | "finance.invoice"
  | "finance.overdue"
  | "email.latest"
  | "email.search"
  | "email.body"
  | "knowledge.semantic"
  | "catalogue.list";

const SEMANTIC_KNOWLEDGE =
  /\b(what does (the |our )?(health|payment|booking|profit|finance|admin|policy|process|procedure|handbook|guidance|document)|explain (the |our )?(policy|process|procedure|document)|summarise (the |our )?(policy|process|procedure|document|finance admin)|how (do|should) we|how to handle|answer from|find (the )?(rule|value|requirement)|compare .{0,48}(policy|procedure|process)|search (company )?knowledge|company knowledge|in (the|our) (policy|handbook|procedure|knowledge))\b/i;
const SEMANTIC_CONTENT_VERB =
  /\b(policy|process|procedure|handbook|guidance|knowledge base).{0,32}(say|mean|require|cover|state|tell)\b/i;
const SEMANTIC_CONTENT_VERB_FLIP =
  /\b(say|mean|require|cover|state).{0,24}(policy|process|procedure|handbook|guidance)\b/i;
const NAMED_PROCEDURE =
  /\b(payment process|booking process|remittance|health\s*(?:and|&)\s*safety|lone[- ]working|asbestos|finance admin(?:istration)?(?:\s+(?:guide|knowledge(?: document)?))?|knowledge (?:base|document|file)|admin (?:guide|structure)|subcontractor (payment|booking|form)|profit margin(?: policy)?|sfr?m|srfm)\b/i;
const NAMED_DOCUMENT_CONTENT =
  /\b(the|our|together with the) (?!newest |latest |recent )([a-z0-9][\w &/-]{1,40}) documents?\b/i;
const MONTH_NAME =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const EXPLICIT_CATALOGUE =
  /\b((newest|latest|recent).{0,28}(file|document|pdf|onedrive|sharepoint|indexed file|filename)|list (the )?(newest |recent )?(files|documents)|recent documents|newest document filename|how many (files|documents) are indexed)\b/i;
const EMAIL_ASK =
  /\b(emails?|emailed|inbox|mailbox|outlook|unread mail|remittance email|customer email|(the|their) messages?)\b/i;
const ACCOUNTING_ASK =
  /\b(xero|sales|revenue|overdue|outstanding|p&l|pnl|invoice|aged (receivable|payable)|top customers?|warehouse)\b/i;
const REJECTS_FINANCE = /\bnot (xero|the ledger|finance)\b/i;

export function isPeriodCorrection(text: string): boolean {
  const value = String(text ?? "");
  return (
    /\b((i )?meant|not)\b/i.test(value) &&
    MONTH_NAME.test(value) &&
    !EMAIL_ASK.test(value) &&
    !/\b(document|file|policy|knowledge|handbook)\b/i.test(value)
  );
}

export function isExclusiveCapabilitySwitch(text: string): boolean {
  const value = String(text ?? "");
  if (/\b(and|plus|also|together with)\b/i.test(value) && isSemanticKnowledgeAsk(value) && ACCOUNTING_ASK.test(value)) {
    return false;
  }
  return (
    REJECTS_FINANCE.test(value) ||
    /\b(i )?meant the (email|emails|message|mailbox|inbox|document|file|policy)\b/i.test(value) ||
    /\b(no,? check (outlook|the inbox)|check outlook|sorry,? i meant the (email|document|message))\b/i.test(value) ||
    isPeriodCorrection(value)
  );
}

export function isSemanticKnowledgeAsk(text: string): boolean {
  const value = String(text ?? "");
  if (isExplicitCatalogueAsk(value) && !SEMANTIC_KNOWLEDGE.test(value) && !NAMED_PROCEDURE.test(value)) {
    return false;
  }
  return (
    SEMANTIC_KNOWLEDGE.test(value) ||
    SEMANTIC_CONTENT_VERB.test(value) ||
    SEMANTIC_CONTENT_VERB_FLIP.test(value) ||
    NAMED_PROCEDURE.test(value) ||
    NAMED_DOCUMENT_CONTENT.test(value)
  );
}

const FINANCE_WINDOW =
  /\b((january|february|march|april|may|june|july|august|september|october|november|december)(\s+20\d{2})?|last month|this month|previous month|mtd)\b/gi;
const FINANCE_METRIC = /\b(sales|revenue|figures|warehouse|xero|overdue|outstanding|top customers?)\b/gi;

function stripFinanceContamination(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/\b(give me|show me|what were|what are|tell me)\b/gi, " ")
    .replace(new RegExp(`(?:${FINANCE_WINDOW.source})\\s+(?:${FINANCE_METRIC.source})`, "gi"), " ")
    .replace(new RegExp(`(?:${FINANCE_METRIC.source})\\s+(?:${FINANCE_WINDOW.source})`, "gi"), " ")
    .replace(/\b(warehouse|xero)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || text;
}

export function knowledgeQueryFromText(text: string): string {
  const value = String(text ?? "").trim();
  const clauses = value.split(/\b(?:and|plus|also|together with|,)\b/i).map((part) => part.trim()).filter(Boolean);
  const knowledgeClauses = clauses.filter(
    (clause) => isSemanticKnowledgeAsk(clause) || /\b(policy|procedure|process|handbook|guidance|document|knowledge)\b/i.test(clause),
  );
  const focused =
    knowledgeClauses.find((clause) => !ACCOUNTING_ASK.test(clause) && !EMAIL_ASK.test(clause)) ??
    knowledgeClauses.find((clause) => isSemanticKnowledgeAsk(clause)) ??
    knowledgeClauses[0];
  return stripFinanceContamination(focused || value);
}

export function isExplicitCatalogueAsk(text: string): boolean {
  return EXPLICIT_CATALOGUE.test(String(text ?? ""));
}

export function isExplicitInvoiceWarehouseCompound(text: string): boolean {
  const value = String(text ?? "");
  if (!/\bINV-\d+\b/i.test(value)) return false;
  if (!/\b(and|plus|also|together with)\b/i.test(value)) return false;
  if (!/\b(warehouse|sales|revenue|figures)\b/i.test(value)) return false;
  return MONTH_NAME.test(value) || /\b(last month|this month|previous month|q[1-4])\b/i.test(value);
}

export function decomposeEvidenceNeeds(text: string): EvidenceSubtask[] {
  const value = String(text ?? "");
  const exclusive = isExclusiveCapabilitySwitch(value);
  const exclusiveEmail = exclusive && EMAIL_ASK.test(value);
  const exclusivePeriod = exclusive && isPeriodCorrection(value);
  const exclusiveKnowledge =
    exclusive && /\b(document|file|policy|knowledge|handbook)\b/i.test(value) && !EMAIL_ASK.test(value) && !exclusivePeriod;
  const needs = new Set<EvidenceSubtask>();
  if (
    ((isSemanticKnowledgeAsk(value) ||
      (/\b(polic(?:y|ies)|handbook|procedure|guidance|knowledge (?:base|document|file))\b/i.test(value) &&
        !isExplicitCatalogueAsk(value))) &&
      !exclusiveEmail &&
      !exclusivePeriod) ||
    exclusiveKnowledge
  ) {
    needs.add("knowledge.semantic");
  }
  if (!exclusive && isExplicitCatalogueAsk(value)) needs.add("catalogue.list");
  if (EMAIL_ASK.test(value) && !exclusivePeriod && !exclusiveKnowledge) {
    if (
      /\b(what (do|did|are|were) they|they want|they after|what does it say|summaris|summariz|draft|body|actually say|key point|what do i need to do)\b/i.test(
        value,
      )
    ) {
      needs.add("email.body");
    } else if (
      /\b(search|from|containing|look in|quote|PO)\b/i.test(value) ||
      /\b((email|inbox|mailbox).{0,24}about|about .{0,24}(email|inbox|mailbox))\b/i.test(value)
    ) {
      needs.add("email.search");
    } else {
      needs.add("email.latest");
    }
  }
  if (exclusiveEmail) return [...needs];
  if (exclusivePeriod) {
    needs.add("finance.metric");
    return [...needs];
  }
  if (exclusiveKnowledge) return [...needs];
  if (REJECTS_FINANCE.test(value)) return [...needs];
  if (/\bINV-\d+\b/i.test(value) || /\b(find invoice|invoice (id|number))\b/i.test(value)) {
    needs.add("finance.invoice");
  }
  if (isExplicitInvoiceWarehouseCompound(value)) {
    needs.add("finance.metric");
  } else if (needs.has("finance.invoice")) {
    // Simple INV- asks stay invoice-only unless an explicit warehouse companion is present.
  } else if (/\b(overdue|outstanding|unpaid)\b/i.test(value)) {
    needs.add("finance.overdue");
  } else if (ACCOUNTING_ASK.test(value) && !EMAIL_ASK.test(value.replace(/\b(invoice|invoices)\b/gi, " "))) {
    needs.add("finance.metric");
  } else if (ACCOUNTING_ASK.test(value) && /\b(xero|sales|revenue|warehouse|overdue|customers?)\b/i.test(value)) {
    needs.add("finance.metric");
  }
  return [...needs];
}

export function toolForEvidenceSubtask(subtask: EvidenceSubtask): string {
  switch (subtask) {
    case "knowledge.semantic":
      return "search_company_knowledge";
    case "catalogue.list":
      return "list_documents";
    case "email.body":
      return "outlook_get_message";
    case "email.search":
      return "outlook_search_mailbox";
    case "email.latest":
      return "outlook_list_messages";
    case "finance.invoice":
      return "xero_get_invoice";
    case "finance.overdue":
      return "xero_list_overdue_invoices";
    case "finance.metric":
      return "warehouse_sales_analysis";
  }
}

export function minimumToolsForText(text: string): string[] {
  const needs = decomposeEvidenceNeeds(text);
  const tools = needs.map(toolForEvidenceSubtask);
  if (needs.includes("finance.metric") && /\b(this month|right now|current|live)\b/i.test(text) && !/\b(march|april|may|june|july|august|january|february|last month|completed)\b/i.test(text)) {
    return tools.map((name) => (name === "warehouse_sales_analysis" ? "xero_sales_summary" : name));
  }
  return [...new Set(tools)];
}
