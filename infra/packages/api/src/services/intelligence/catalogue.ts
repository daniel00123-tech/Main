import type { IntelligenceToolSpec } from "./types.js";

/**
 * Controlled catalogue only. Tools still execute through INFRA tenant/RBAC.
 * `fetch` is an internal alias of get_knowledge_document — not shown to the model.
 */
export const INTELLIGENCE_TOOLS: IntelligenceToolSpec[] = [
  {
    name: "search_company_knowledge",
    description: "Find a company document by meaning. Returns titles, ids, snippets, and source URLs — not full text.",
    whenToUse:
      "The user names or wants a different document, or no current document is set. First step of document discovery.",
    whenNotToUse:
      "Do not use for follow-ups about the already-open document (he/that/when/managing). Do not use just because a new keyword appeared.",
    parameters: {
      query: { description: "Natural-language search text", required: true },
      limit: { type: "number", description: "Optional hit cap, default 5" },
    },
    outputShape: "{ results: [{ id, title, url, snippet }] }",
    permission: "company knowledge read",
  },
  {
    name: "search_document",
    description: "Retrieve ranked chunks from one already-identified document_id.",
    whenToUse:
      "Questions, summaries, more detail, dates, roles, rules, and pronoun follow-ups about the current document.",
    whenNotToUse: "Do not use to hunt a different file. Do not use when no document_id is known.",
    parameters: {
      document_id: { description: "Current document id", required: true },
      query: { description: "What to look for in that document", required: true },
    },
    outputShape: "{ document_id, title, url, none, chunks: [{ id, heading, score, text }] }",
    permission: "company knowledge read",
  },
  {
    name: "get_knowledge_document",
    description: "Load one document's metadata, source URL, and extracted chunks by document_id.",
    whenToUse: "After search identifies the right document, or when the user asks for the source/URL of a known id.",
    whenNotToUse: "Do not invent an id. Do not use for company-wide discovery.",
    parameters: { document_id: { description: "Document id from search or current state", required: true } },
    outputShape: "{ document_id, title, url, source, chunks }",
    permission: "company knowledge read",
  },
  {
    name: "database_summary",
    description: "Summarise connected company systems and connector health.",
    whenToUse: "User asks what systems are connected or whether a connector is healthy.",
    whenNotToUse: "Not a document search. Not Xero figures.",
    parameters: {},
    outputShape: "{ connectors, health }",
    permission: "company read",
  },
  {
    name: "system_health",
    description: "Read platform/system health for this company.",
    whenToUse: "User asks if the platform or a connected system is up.",
    whenNotToUse: "Not for document or invoice content.",
    parameters: {},
    outputShape: "{ status }",
    permission: "company read",
  },
  {
    name: "outlook_search_mailbox",
    description: "Search an included shared mailbox (read only).",
    whenToUse: "User asks about inbox, Outlook, or a shared mailbox message they are permitted to see.",
    whenNotToUse: "Not for Drive/SharePoint documents. Writes are forbidden.",
    parameters: {
      query: { description: "Subject/body/sender search", required: true },
      mailboxAddress: { description: "Included shared mailbox SMTP if known" },
    },
    outputShape: "{ mailboxAddress, messages: [{ subject, from, receivedDateTime }] }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "xero_sales_summary",
    description: "Read Xero sales/invoice summary.",
    whenToUse: "User asks about sales, invoices, or overdue amounts in general.",
    whenNotToUse: "Not for documents. Not for creating or sending invoices.",
    parameters: {},
    outputShape: "{ summary }",
    permission: "xero read",
  },
  {
    name: "xero_list_overdue_invoices",
    description: "List overdue Xero invoices.",
    whenToUse: "User asks who is overdue or which invoices are late.",
    whenNotToUse: "Not for document search.",
    parameters: { limit: { type: "number", description: "Optional cap" } },
    outputShape: "{ invoices: [{ invoice_id, contact, amount, due }] }",
    permission: "xero read",
  },
  {
    name: "xero_get_invoice",
    description: "Get one Xero invoice by invoice_id.",
    whenToUse: "User names a specific invoice id.",
    whenNotToUse: "Do not invent an invoice id.",
    parameters: { invoice_id: { description: "Xero invoice id", required: true } },
    outputShape: "{ invoice }",
    permission: "xero read",
  },
  {
    name: "xero_search_invoices",
    description: "Search recent Xero invoices.",
    whenToUse: "User wants to find invoices by customer or reference.",
    whenNotToUse: "Not for company documents.",
    parameters: {
      query: { description: "Optional search" },
      limit: { type: "number", description: "Optional cap" },
    },
    outputShape: "{ invoices }",
    permission: "xero read",
  },
  {
    name: "xero_search_contacts",
    description: "Search Xero contacts.",
    whenToUse: "User asks who a customer/supplier is in Xero.",
    whenNotToUse: "Not for people named only in documents.",
    parameters: { search: { description: "Optional name search" } },
    outputShape: "{ contacts }",
    permission: "xero read",
  },
  {
    name: "xero_profit_and_loss",
    description: "Read Xero profit and loss.",
    whenToUse: "User asks for P&L or profit.",
    whenNotToUse: "Not for documents.",
    parameters: {},
    outputShape: "{ report }",
    permission: "xero read",
  },
  {
    name: "xero_aged_receivables",
    description: "Read Xero aged receivables.",
    whenToUse: "User asks who owes money or aged debt.",
    whenNotToUse: "Not for documents.",
    parameters: {},
    outputShape: "{ report }",
    permission: "xero read",
  },
  {
    name: "xero_get_organisation",
    description: "Read the connected Xero organisation profile.",
    whenToUse: "User asks which Xero organisation is connected.",
    whenNotToUse: "Not for invoices or documents.",
    parameters: {},
    outputShape: "{ organisation }",
    permission: "xero read",
  },
];

export const INTELLIGENCE_TOOL_NAMES = new Set(INTELLIGENCE_TOOLS.map((tool) => tool.name));

export const GATEWAY_TOOL_ALIASES: Record<string, string> = {
  search_company_knowledge: "search_company_knowledge",
  get_knowledge_document: "get_knowledge_document",
  fetch: "fetch",
  search: "search_company_knowledge",
  database_summary: "database_summary",
  system_health: "system_health",
  outlook_search_mailbox: "outlook_search_mailbox",
  xero_sales_summary: "xero_sales_summary",
  xero_list_overdue_invoices: "xero_list_overdue_invoices",
  xero_get_invoice: "xero_get_invoice",
  xero_search_invoices: "xero_search_invoices",
  xero_search_contacts: "xero_search_contacts",
  xero_profit_and_loss: "xero_profit_and_loss",
  xero_aged_receivables: "xero_aged_receivables",
  xero_get_organisation: "xero_get_organisation",
};

const XERO_TOOLS = new Set(INTELLIGENCE_TOOLS.filter((tool) => tool.name.startsWith("xero_")).map((tool) => tool.name));

export function toolsForModel(permitted?: Iterable<string> | null): IntelligenceToolSpec[] {
  const allow = permitted ? new Set([...permitted]) : null;
  return INTELLIGENCE_TOOLS.filter((tool) => {
    if (allow && allow.size > 0 && !allow.has(tool.name)) return false;
    return true;
  });
}

export function permittedToolsForConnectors(connectors: string[]): string[] {
  const hasXero = connectors.includes("conn_xero");
  const hasMailbox = connectors.some((id) => /outlook|microsoft|mailbox/i.test(id));
  return INTELLIGENCE_TOOLS.filter((tool) => {
    if (XERO_TOOLS.has(tool.name)) return hasXero;
    if (tool.name === "outlook_search_mailbox") return hasMailbox;
    return true;
  }).map((tool) => tool.name);
}

export function describeToolCatalogue(permitted?: Iterable<string> | null): string {
  return toolsForModel(permitted)
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([key, value]) => `${key}${value.required ? "*" : ""}: ${value.description}`)
        .join("; ");
      return `- ${tool.name}: ${tool.description} Use when: ${tool.whenToUse} Avoid: ${tool.whenNotToUse}${
        params ? ` Args: ${params}` : ""
      } Output: ${tool.outputShape}`;
    })
    .join("\n");
}
