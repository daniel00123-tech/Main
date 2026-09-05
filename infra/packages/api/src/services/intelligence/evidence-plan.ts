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
  /\b(payment process|booking process|remittance|health and safety|lone[- ]working|asbestos|finance admin|subcontractor (payment|booking)|profit margin policy)\b/i;
const EXPLICIT_CATALOGUE =
  /\b((newest|latest|recent).{0,28}(file|document|pdf|onedrive|sharepoint|indexed file|filename)|list (the )?(newest |recent )?(files|documents)|recent documents|newest document filename|how many (files|documents) are indexed)\b/i;
const EMAIL_ASK =
  /\b(emails?|inbox|mailbox|outlook|unread mail|(the|their) messages?)\b/i;
const ACCOUNTING_ASK =
  /\b(xero|sales|revenue|overdue|outstanding|p&l|pnl|invoice|aged (receivable|payable)|top customers?|warehouse)\b/i;

export function isSemanticKnowledgeAsk(text: string): boolean {
  const value = String(text ?? "");
  return SEMANTIC_KNOWLEDGE.test(value) || SEMANTIC_CONTENT_VERB.test(value) || SEMANTIC_CONTENT_VERB_FLIP.test(value) || NAMED_PROCEDURE.test(value);
}

export function isExplicitCatalogueAsk(text: string): boolean {
  return EXPLICIT_CATALOGUE.test(String(text ?? ""));
}

export function decomposeEvidenceNeeds(text: string): EvidenceSubtask[] {
  const value = String(text ?? "");
  const needs = new Set<EvidenceSubtask>();
  if (isSemanticKnowledgeAsk(value)) needs.add("knowledge.semantic");
  if (isExplicitCatalogueAsk(value)) needs.add("catalogue.list");
  if (EMAIL_ASK.test(value)) {
    if (/\b(what are they asking|what does it say|summaris|summariz|draft|body|actually say)\b/i.test(value)) {
      needs.add("email.body");
    } else if (/\b(search|from|containing|about|look in|quote|PO)\b/i.test(value)) {
      needs.add("email.search");
    } else {
      needs.add("email.latest");
    }
  }
  if (/\bINV-\d+\b/i.test(value) || /\b(find invoice|invoice (id|number))\b/i.test(value)) {
    needs.add("finance.invoice");
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
