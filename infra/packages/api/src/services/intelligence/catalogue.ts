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
      "Do not use for follow-ups about the already-open document (he/that/when/managing). Do not use just because a new keyword appeared. Do not use for newest/latest/uploaded/recently modified listing — call list_documents.",
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
    name: "outlook_list_messages",
    description: "List the newest messages in an included shared mailbox (read only).",
    whenToUse: "User asks for the newest, latest, or recent email in an inbox they may read.",
    whenNotToUse: "Not for Drive/SharePoint documents. Writes are forbidden. Use search when they name a sender or subject.",
    parameters: {
      mailboxAddress: { description: "Included shared mailbox SMTP if known" },
      limit: { type: "number", description: "How many recent messages to return, default 5" },
    },
    outputShape: "{ mailboxAddress, messages: [{ subject, from, receivedDateTime }] }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "outlook_get_message",
    description: "Read the full body of one shared-mailbox message by id (read only).",
    whenToUse: "User asks what an email says, or wants the full latest message after a list/search.",
    whenNotToUse: "Not for Drive/SharePoint. Do not invent a message id.",
    parameters: {
      mailboxAddress: { description: "Included shared mailbox SMTP" },
      messageId: { description: "Stable id from list or search", required: true },
    },
    outputShape: "{ mailboxAddress, subject, from, body }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "xero_sales_summary",
    description: "Read Xero sales/invoice summary for a real date range.",
    whenToUse: "User asks about sales, invoices, or overdue amounts in general.",
    whenNotToUse: "Not for documents. Not for creating or sending invoices. Do not call with empty dates.",
    parameters: {
      fromDate: { description: "Inclusive start date YYYY-MM-DD in Europe/London" },
      toDate: { description: "Inclusive end date YYYY-MM-DD in Europe/London" },
    },
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
    parameters: {
      invoice_id: { description: "Xero invoice UUID if known" },
      invoiceNumber: { description: "Human invoice number such as INV-02268" },
    },
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
    name: "xero_top_customers",
    description: "Read the top Xero customers by invoiced amount for a date range.",
    whenToUse: "User asks who the top or biggest customers are.",
    whenNotToUse: "Not for documents. Not for creating contacts.",
    parameters: {
      fromDate: { description: "Inclusive start date YYYY-MM-DD" },
      toDate: { description: "Inclusive end date YYYY-MM-DD" },
      limit: { type: "number", description: "How many customers, default 5" },
    },
    outputShape: "{ customers: [{ name, total }] }",
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
    description: "Read Xero profit and loss for a real date range.",
    whenToUse: "User asks for P&L or profit. Comparative columns only when the user compares periods.",
    whenNotToUse: "Not for documents. Do not call with empty dates.",
    parameters: {
      fromDate: { description: "Inclusive start date YYYY-MM-DD in Europe/London" },
      toDate: { description: "Inclusive end date YYYY-MM-DD in Europe/London" },
      periods: { type: "number", description: "Optional comparative columns, only when comparing periods" },
      timeframe: { description: "MONTH, QUARTER, or YEAR when periods is set" },
    },
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
  {
    name: "get_company_system_summary",
    description: "Read-only tenant snapshot: indexed document totals, connected systems, automations, last sync.",
    whenToUse: "Company-wide system questions, inventory of indexed files, or a compact platform summary.",
    whenNotToUse: "Not for reading a document's contents. Not for inventing counts.",
    parameters: {},
    outputShape: "{ company, indexed, connectors, automations, lastSyncAt }",
    permission: "company read",
  },
  {
    name: "get_document_index_stats",
    description: "Tenant-scoped indexed document counts by source and file type. Real aggregates only.",
    whenToUse: "How many documents are indexed, where they come from, or type/source breakdowns.",
    whenNotToUse: "Not for searching document text. Not when the user means the current file's contents. Not for listing newest/latest files.",
    parameters: {},
    outputShape: "{ totalIndexed, bySource, byType, lastSyncAt }",
    permission: "company knowledge read",
  },
  {
    name: "list_documents",
    description:
      "List real connected document metadata by recency. Newest, latest, uploaded, or recently modified files. Not semantic search.",
    whenToUse:
      "Newest document, latest ten files, uploaded today, changed this week, latest SharePoint PDFs, or what the newest files are about.",
    whenNotToUse:
      "Do not use for 'how many documents' (index stats). Do not use to find a document about a topic. Do not invent files.",
    parameters: {
      source: { description: "onedrive, sharepoint, drive, email, or all" },
      sort: { description: "newest, oldest, or recently_modified" },
      limit: { type: "number", description: "1–100, default 10" },
      file_type: { description: "Optional pdf/docx/xlsx" },
      date_from: { description: "Optional YYYY-MM-DD" },
      date_to: { description: "Optional YYYY-MM-DD" },
    },
    outputShape: "{ documents: [{ id, title, source, createdAt, modifiedAt, fileType, url, description }] }",
    permission: "company knowledge read",
  },
  {
    name: "get_connector_status",
    description: "Live connected systems for this company, using customer-facing names.",
    whenToUse: "What systems are connected or what data sources are live.",
    whenNotToUse: "Do not list disconnected products as available.",
    parameters: {},
    outputShape: "{ connected: [label] }",
    permission: "company read",
  },
  {
    name: "get_active_automations",
    description: "Active and paused automations for this company. Names only, no internal ids.",
    whenToUse: "User asks what automations are running or scheduled.",
    whenNotToUse: "Not for creating or changing automations.",
    parameters: {},
    outputShape: "{ active: [name], paused: [name] }",
    permission: "automation read",
  },
  {
    name: "get_user_capabilities",
    description: "What this user can ask about, from live connectors and permitted read tools.",
    whenToUse: "What can you do, what data can you access, or what else you can help with.",
    whenNotToUse: "Do not advertise systems that are not connected or not permitted.",
    parameters: {},
    outputShape: "{ canHelpWith, connectedSystems, permittedReads }",
    permission: "company read",
  },
  {
    name: "get_recent_sync_status",
    description: "Last successful index/sync time for connected knowledge sources.",
    whenToUse: "When the user asks when files last synced or how fresh the index is.",
    whenNotToUse: "Not a document search.",
    parameters: {},
    outputShape: "{ lastSyncAt, bySource }",
    permission: "company knowledge read",
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
  outlook_list_messages: "outlook_list_messages",
  outlook_get_message: "outlook_get_message",
  xero_sales_summary: "xero_sales_summary",
  xero_top_customers: "xero_top_customers",
  xero_list_overdue_invoices: "xero_list_overdue_invoices",
  xero_get_invoice: "xero_get_invoice",
  xero_search_invoices: "xero_search_invoices",
  xero_search_contacts: "xero_search_contacts",
  xero_profit_and_loss: "xero_profit_and_loss",
  xero_aged_receivables: "xero_aged_receivables",
  xero_get_organisation: "xero_get_organisation",
  ask_document: "ask_document",
  list_documents: "list_documents",
};

const XERO_TOOLS = new Set(INTELLIGENCE_TOOLS.filter((tool) => tool.name.startsWith("xero_")).map((tool) => tool.name));

export const SYSTEM_META_TOOLS = new Set([
  "get_company_system_summary",
  "get_document_index_stats",
  "get_connector_status",
  "get_active_automations",
  "get_user_capabilities",
  "get_recent_sync_status",
]);

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
    if (tool.name === "outlook_search_mailbox" || tool.name === "outlook_list_messages" || tool.name === "outlook_get_message") {
      return hasMailbox;
    }
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
