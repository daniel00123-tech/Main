import type { IntelligenceToolSpec } from "./types.js";

/**
 * Controlled catalogue only. Tools still execute through INFRA tenant/RBAC.
 * Names match existing gateway tools except `search_document` (local retrieval).
 */
export const INTELLIGENCE_TOOLS: IntelligenceToolSpec[] = [
  {
    name: "search_company_knowledge",
    description:
      "Search company documents by meaning. Use to find a document. Returns titles, ids, snippets, and source URLs — not full text.",
    parameters: { query: "natural-language search text", limit: "optional number, default 5" },
  },
  {
    name: "search_document",
    description:
      "Retrieve ranked chunks from one already-identified document_id. Use for questions, summaries, more detail, and follow-ups about the current document.",
    parameters: { document_id: "document id", query: "what to look for in that document" },
  },
  {
    name: "get_knowledge_document",
    description:
      "Load one document's metadata, source URL, and extracted text/chunks by document_id. Use after search identifies the right document, or when the user asks for the source.",
    parameters: { document_id: "document id" },
  },
  {
    name: "fetch",
    description: "Fetch a company document by the id returned from search.",
    parameters: { id: "document id" },
  },
  {
    name: "database_summary",
    description: "Summarise connected company systems and connector health. Not a document search.",
    parameters: {},
  },
  {
    name: "system_health",
    description: "Read platform/system health for this company.",
    parameters: {},
  },
  {
    name: "xero_sales_summary",
    description: "Read Xero sales/invoice summary when the user asks about invoices, sales, or overdue amounts.",
    parameters: {},
  },
  {
    name: "xero_list_overdue_invoices",
    description: "List overdue Xero invoices.",
    parameters: { limit: "optional number" },
  },
  {
    name: "xero_get_invoice",
    description: "Get one Xero invoice by invoice_id.",
    parameters: { invoice_id: "Xero invoice id" },
  },
  {
    name: "xero_search_invoices",
    description: "Search recent Xero invoices.",
    parameters: { query: "optional search", limit: "optional number" },
  },
  {
    name: "xero_search_contacts",
    description: "Search Xero contacts.",
    parameters: { search: "optional name search" },
  },
  {
    name: "xero_profit_and_loss",
    description: "Read Xero profit and loss.",
    parameters: {},
  },
  {
    name: "xero_aged_receivables",
    description: "Read Xero aged receivables.",
    parameters: {},
  },
  {
    name: "xero_get_organisation",
    description: "Read the connected Xero organisation profile.",
    parameters: {},
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
  xero_sales_summary: "xero_sales_summary",
  xero_list_overdue_invoices: "xero_list_overdue_invoices",
  xero_get_invoice: "xero_get_invoice",
  xero_search_invoices: "xero_search_invoices",
  xero_search_contacts: "xero_search_contacts",
  xero_profit_and_loss: "xero_profit_and_loss",
  xero_aged_receivables: "xero_aged_receivables",
  xero_get_organisation: "xero_get_organisation",
};

export function describeToolCatalogue(): string {
  return INTELLIGENCE_TOOLS.map((tool) => {
    const params = Object.entries(tool.parameters)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
    return `- ${tool.name}: ${tool.description}${params ? ` (${params})` : ""}`;
  }).join("\n");
}
