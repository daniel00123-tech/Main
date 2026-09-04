import type { IntelligenceToolFamily, IntelligenceToolSpec } from "./types.js";

/**
 * Controlled catalogue only. Tools still execute through INFRA tenant/RBAC.
 * `fetch` is an internal alias of get_knowledge_document — not shown to the model.
 *
 * Descriptions are generic. They must not contain customer names, mailboxes, or phrases.
 */
export const CURRENT_BUSINESS_DATA_PROTOCOL = `Current or private company data is never guessed from world knowledge.
If the answer depends on CURRENT or private company data (mailbox, Xero, indexed knowledge, file catalogue) that is not already in authorised recent evidence, you MUST call the matching INFRA function tool before answering.
If authorised recent evidence already contains the requested facts, do not call a business tool — answer from that evidence.
Named shared inboxes (info, finance, office, shared mailbox) are mailbox tools, never knowledge search and never Xero.
outlook_list_messages = newest/latest/recent/unread/last-N mailbox listing with no sender, subject, or content filter.
outlook_search_mailbox = sender, subject, body, date, or search terms.
Do not use Xero for email. Do not use email or knowledge for live Xero figures. Do not use knowledge search for newest-file lists.
Conversational turns (professional reply, shorter, friendlier, explain simply, 2+2, brainstorm, thanks) use no business tools unless the answer still depends on missing current data.
After a tool result, write a natural first answer that includes the useful structured values (totals, dates, subjects, senders). Never return raw tool JSON as the customer reply. Never ask for More Detail when the tool already returned the facts.`;

export const INTELLIGENCE_TOOLS: IntelligenceToolSpec[] = [
  {
    name: "search_company_knowledge",
    description:
      "Indexed company-document search by meaning. Live: no — searches the knowledge index, not Xero or mailboxes. Returns titles, ids, snippets, and source URLs — not full text.",
    whenToUse:
      "The user wants a policy, procedure, project file, or other document by topic, or no current document is set. First step of document discovery.",
    whenNotToUse:
      "Do not use for follow-ups about the already-open document. Do not use for newest/latest/uploaded file lists — call list_documents. Do not use for live mailbox or Xero figures.",
    live: false,
    intentClass: "knowledge_search",
    intentExamples: "find the vehicle policy; what is the purchase-order process; search company knowledge for a topic",
    parameters: {
      query: { description: "Natural-language search text", required: true },
      limit: { type: "number", description: "Optional hit cap, default 5" },
    },
    outputShape: "{ results: [{ id, title, url, snippet }] }",
    permission: "company knowledge read",
  },
  {
    name: "search_document",
    description: "Retrieve ranked chunks from one already-identified document_id. Live: no — reads indexed chunks only.",
    whenToUse:
      "Questions, summaries, more detail, dates, roles, rules, and pronoun follow-ups about the current document.",
    whenNotToUse: "Do not use to hunt a different file. Do not use when no document_id is known. Not for mailbox or Xero.",
    live: false,
    intentClass: "knowledge_current_document",
    intentExamples: "what does this file say about fuel; summarise the current document",
    parameters: {
      document_id: { description: "Current document id", required: true },
      query: { description: "What to look for in that document", required: true },
    },
    outputShape: "{ document_id, title, url, none, chunks: [{ id, heading, score, text }] }",
    permission: "company knowledge read",
  },
  {
    name: "get_knowledge_document",
    description: "Load one document's metadata, source URL, and extracted chunks by document_id. Live: no.",
    whenToUse: "After search identifies the right document, or when the user asks for the source/URL of a known id.",
    whenNotToUse: "Do not invent an id. Do not use for company-wide discovery, mailbox, or Xero.",
    live: false,
    intentClass: "knowledge_fetch",
    intentExamples: "open the document id from search; get the source URL of the current file",
    parameters: { document_id: { description: "Document id from search or current state", required: true } },
    outputShape: "{ document_id, title, url, source, chunks }",
    permission: "company knowledge read",
  },
  {
    name: "database_summary",
    description: "Summarise connected company systems and connector health. Live: connector status only, not figures.",
    whenToUse: "User asks what systems are connected or whether a connector is healthy.",
    whenNotToUse: "Not a document search. Not Xero figures. Not mailbox contents.",
    live: true,
    intentClass: "system_connectors",
    intentExamples: "what systems are connected; is a connector healthy",
    parameters: {},
    outputShape: "{ connectors, health }",
    permission: "company read",
  },
  {
    name: "system_health",
    description: "Read platform/system health for this company. Live: yes.",
    whenToUse: "User asks if the platform or a connected system is up.",
    whenNotToUse: "Not for document, mailbox, or invoice content.",
    live: true,
    intentClass: "system_health",
    intentExamples: "is the platform up; system health",
    parameters: {},
    outputShape: "{ status }",
    permission: "company read",
  },
  {
    name: "outlook_search_mailbox",
    description:
      "Live read-only search of a permitted company shared mailbox. Use when there is a sender, subject, body term, or date filter. Company-mailbox scope only — never a personal inbox. Office-staff roles may be limited to the info/office mailbox and must never read finance.",
    whenToUse:
      "The user wants emails matching a sender, subject, content term, date, or other search phrase in a permitted shared mailbox.",
    whenNotToUse:
      "Do not use for newest/latest/recent/unread listing with no filter — call outlook_list_messages. Not for Drive/SharePoint, Xero, or knowledge. Do not use when authorised recent email evidence already answers a draft, edit, or recall.",
    live: true,
    intentClass: "mailbox_search",
    intentExamples: "emails from a named person; search the mailbox for a purchase order; emails containing a quote; look in Outlook for a topic",
    parameters: {
      query: { description: "Sender, subject, body, or date search terms", required: true },
      mailboxAddress: { description: "Permitted shared-mailbox SMTP if known; omit to use the role-allowed default" },
    },
    outputShape: "{ mailboxAddress, messages: [{ subject, from, receivedDateTime }] }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "outlook_list_messages",
    description:
      "Live read-only list of the newest messages in a permitted company shared mailbox. No semantic filter — recency order only. Named inboxes such as info, finance, office, or shared mailbox map here when the user wants latest/newest/recent/unread mail. Company-mailbox scope only. Office-staff roles may be limited to the info/office mailbox and must never read finance.",
    whenToUse:
      "The user asks for the newest, latest, recent, last N, unread, or arrived-today messages in a shared inbox they may read, with no sender/subject/content filter.",
    whenNotToUse:
      "Do not use when they name a sender, subject, body term, or search phrase — call outlook_search_mailbox. Not for Drive/SharePoint or Xero. Writes are forbidden. Skip if authorised recent email evidence already answers a draft, edit, or recall.",
    live: true,
    intentClass: "mailbox_recency",
    intentExamples: "latest email in the info inbox; newest shared-mailbox message; last 5 emails; unread in the mailbox; what arrived today",
    parameters: {
      mailboxAddress: { description: "Permitted shared-mailbox SMTP if known; omit to use the role-allowed default" },
      limit: { type: "number", description: "How many recent messages to return, default 5" },
    },
    outputShape: "{ mailboxAddress, messages: [{ subject, from, receivedDateTime }] }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "outlook_get_message",
    description: "Live read-only full body of one shared-mailbox message by id. Company-mailbox scope only.",
    whenToUse: "User asks what an email says, or wants the full latest message after a list/search that returned an id.",
    whenNotToUse: "Not for Drive/SharePoint or Xero. Do not invent a message id.",
    live: true,
    intentClass: "mailbox_read_one",
    intentExamples: "open the latest inbox message; what does that email say",
    parameters: {
      mailboxAddress: { description: "Permitted shared-mailbox SMTP" },
      messageId: { description: "Stable id from list or search", required: true },
    },
    outputShape: "{ mailboxAddress, subject, from, body }",
    permission: "outlook shared mailbox read",
  },
  {
    name: "xero_sales_summary",
    description:
      "Live Xero sales/invoice totals for a real date range. Use for current sales, revenue, invoiced amounts, sales today/this week/this month/last 7 days, or a sales summary. Required args: fromDate and toDate as YYYY-MM-DD in Europe/London when the period is known.",
    whenToUse:
      "The user asks for live sales, revenue, invoiced totals, or a sales summary for a period, and authorised evidence does not already contain that period.",
    whenNotToUse:
      "Not for documents or mailbox. Not for creating invoices. Not for top-customer ranking (use xero_top_customers), overdue lists, or P&L. Do not call with empty dates when a period was asked.",
    live: true,
    intentClass: "xero_sales",
    intentExamples: "sales this month; revenue this week; sales last 7 days; Xero sales summary; how much did we invoice",
    parameters: {
      fromDate: { description: "Inclusive start date YYYY-MM-DD in Europe/London" },
      toDate: { description: "Inclusive end date YYYY-MM-DD in Europe/London" },
    },
    outputShape: "{ summary }",
    permission: "xero read",
  },
  {
    name: "xero_list_overdue_invoices",
    description: "Live list of overdue Xero invoices. Required: none. Optional limit.",
    whenToUse: "User asks who is overdue, which invoices are late, or who owes money.",
    whenNotToUse: "Not for document search or mailbox. Not for a period sales total.",
    live: true,
    intentClass: "xero_overdue",
    intentExamples: "show overdue invoices; who owes us money; unpaid late invoices",
    parameters: { limit: { type: "number", description: "Optional cap" } },
    outputShape: "{ invoices: [{ invoice_id, contact, amount, due }] }",
    permission: "xero read",
  },
  {
    name: "xero_get_invoice",
    description: "Live fetch of one Xero invoice by invoice_id or invoice number (for example INV-XXXXX).",
    whenToUse: "User names a specific invoice id or invoice number.",
    whenNotToUse: "Do not invent an invoice id. Not for mailbox or documents.",
    live: true,
    intentClass: "xero_invoice_one",
    intentExamples: "find invoice INV-02268; open that invoice number",
    parameters: {
      invoice_id: { description: "Xero invoice UUID if known" },
      invoiceNumber: { description: "Human invoice number such as INV-02268" },
    },
    outputShape: "{ invoice }",
    permission: "xero read",
  },
  {
    name: "xero_search_invoices",
    description: "Live search of recent Xero invoices by customer, reference, status, or date. Not a mailbox search.",
    whenToUse: "User wants to find invoices by customer, PO/reference, status, or a date range list.",
    whenNotToUse: "Not for company documents or email. Not for a single named invoice number (use xero_get_invoice).",
    live: true,
    intentClass: "xero_invoice_search",
    intentExamples: "search invoices for a purchase order; invoices raised yesterday; find invoices for a customer",
    parameters: {
      query: { description: "Optional search" },
      limit: { type: "number", description: "Optional cap" },
    },
    outputShape: "{ invoices }",
    permission: "xero read",
  },
  {
    name: "xero_top_customers",
    description: "Live top Xero customers by invoiced amount for a date range. Amounts use currencyCode. Required period dates when known.",
    whenToUse: "User asks who the top, biggest, or highest-value customers are for a period.",
    whenNotToUse: "Not for documents, mailbox, or a company-wide sales total (use xero_sales_summary).",
    live: true,
    intentClass: "xero_top_customers",
    intentExamples: "who are the top customers; biggest customer this quarter",
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
    description: "Live search of Xero contacts (customers and suppliers).",
    whenToUse: "User asks who a customer/supplier is in Xero.",
    whenNotToUse: "Not for people named only in documents or email.",
    live: true,
    intentClass: "xero_contacts",
    intentExamples: "find a Xero contact; who is this customer in Xero",
    parameters: { search: { description: "Optional name search" } },
    outputShape: "{ contacts }",
    permission: "xero read",
  },
  {
    name: "xero_profit_and_loss",
    description: "Live Xero Profit & Loss for a real date range. Required: fromDate/toDate as YYYY-MM-DD.",
    whenToUse: "User asks for P&L or profit. Comparative columns only when the user compares periods.",
    whenNotToUse: "Not for documents or mailbox. Do not call with empty dates.",
    live: true,
    intentClass: "xero_pnl",
    intentExamples: "profit and loss this month; what was profit last quarter",
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
    description: "Live Xero aged receivables or payables.",
    whenToUse: "User asks who owes money in aged-debt terms, or aged receivables/payables.",
    whenNotToUse: "Not for documents or mailbox.",
    live: true,
    intentClass: "xero_aged",
    intentExamples: "aged receivables; aged debt position",
    parameters: {},
    outputShape: "{ report }",
    permission: "xero read",
  },
  {
    name: "xero_get_organisation",
    description: "Live connected Xero organisation profile.",
    whenToUse: "User asks which Xero organisation is connected.",
    whenNotToUse: "Not for invoices, documents, or mailbox.",
    live: true,
    intentClass: "xero_org",
    intentExamples: "Xero organisation name; which Xero org is connected",
    parameters: {},
    outputShape: "{ organisation }",
    permission: "xero read",
  },
  {
    name: "get_company_system_summary",
    description: "Read-only tenant snapshot: indexed document totals, connected systems, automations, last sync.",
    whenToUse: "Company-wide system questions, inventory of indexed files, or a compact platform summary.",
    whenNotToUse: "Not for reading a document's contents. Not for inventing counts. Not mailbox or Xero figures.",
    live: true,
    intentClass: "catalogue_summary",
    intentExamples: "company system snapshot; compact platform summary",
    parameters: {},
    outputShape: "{ company, indexed, connectors, automations, lastSyncAt }",
    permission: "company read",
  },
  {
    name: "get_document_index_stats",
    description: "Tenant-scoped indexed document counts by source and file type. Real aggregates only. Live: index metadata.",
    whenToUse: "How many documents are indexed, where they come from, or type/source breakdowns.",
    whenNotToUse: "Not for searching document text. Not when the user means the current file's contents. Not for listing newest/latest files.",
    live: true,
    intentClass: "catalogue_stats",
    intentExamples: "how many files are indexed; document counts by source",
    parameters: {},
    outputShape: "{ totalIndexed, bySource, byType, lastSyncAt }",
    permission: "company knowledge read",
  },
  {
    name: "list_documents",
    description:
      "List real connected document metadata by recency. Newest, latest, uploaded, or recently modified files. Not semantic search and not mailbox.",
    whenToUse:
      "Newest document, latest ten files, uploaded today, changed this week, latest SharePoint/OneDrive files, or what the newest files are about.",
    whenNotToUse:
      "Do not use for 'how many documents' (index stats). Do not use to find a document about a topic. Do not invent files. Not for inbox listing.",
    live: true,
    intentClass: "catalogue_recency",
    intentExamples: "newest document; latest ten files; recent OneDrive files; documents changed this week",
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
    whenNotToUse: "Do not list disconnected products as available. Not mailbox or Xero figures.",
    live: true,
    intentClass: "catalogue_connectors",
    intentExamples: "what systems are connected; which data sources are live",
    parameters: {},
    outputShape: "{ connected: [label] }",
    permission: "company read",
  },
  {
    name: "get_active_automations",
    description: "Active and paused automations for this company. Names only, no internal ids.",
    whenToUse: "User asks what automations are running or scheduled.",
    whenNotToUse: "Not for creating or changing automations.",
    live: true,
    intentClass: "catalogue_automations",
    intentExamples: "what automations are running",
    parameters: {},
    outputShape: "{ active: [name], paused: [name] }",
    permission: "automation read",
  },
  {
    name: "get_user_capabilities",
    description: "What this user can ask about, from live connectors and permitted read tools.",
    whenToUse: "What can you do, what data can you access, or what else you can help with.",
    whenNotToUse: "Do not advertise systems that are not connected or not permitted.",
    live: true,
    intentClass: "catalogue_capabilities",
    intentExamples: "what can you do; who are you; what data can you access",
    parameters: {},
    outputShape: "{ canHelpWith, connectedSystems, permittedReads }",
    permission: "company read",
  },
  {
    name: "get_recent_sync_status",
    description: "Last successful index/sync time for connected knowledge sources.",
    whenToUse: "When the user asks when files last synced or how fresh the index is.",
    whenNotToUse: "Not a document search, mailbox, or Xero read.",
    live: true,
    intentClass: "catalogue_sync",
    intentExamples: "when did files last sync; how fresh is the index",
    parameters: {},
    outputShape: "{ lastSyncAt, bySource }",
    permission: "company knowledge read",
  },
  {
    name: "web_search",
    description: "Approved public web search for live public information only.",
    whenToUse:
      "Weather, public news, public company info, or a public website. Never a substitute for Xero, Outlook, SharePoint, or internal procedures.",
    whenNotToUse:
      "Do not use for private Xero, emails, SharePoint, customer records, holiday entitlement, or company procedures when internal knowledge exists. Business systems outrank public web.",
    live: true,
    intentClass: "public_web",
    intentExamples: "weather in a city; public news headline",
    parameters: { query: { description: "Public web query", required: true } },
    outputShape: "{ source: 'public_web', heading, abstract, results }",
    permission: "public web",
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
  web_search: "web_search",
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

export function toolFamilyOf(name?: string | null): IntelligenceToolFamily {
  const tool = String(name ?? "");
  if (tool.startsWith("xero_")) return "xero";
  if (/outlook/i.test(tool)) return "outlook";
  if (tool === "list_documents" || SYSTEM_META_TOOLS.has(tool) || tool === "database_summary" || tool === "system_health") {
    return tool === "database_summary" || tool === "system_health" ? "system" : "catalogue";
  }
  if (/knowledge|search_document|ask_document|fetch/.test(tool)) return "knowledge";
  if (tool === "web_search") return "web";
  return tool ? "none" : "none";
}

export function familiesOf(names: Iterable<string>): IntelligenceToolFamily[] {
  return [...new Set([...names].map((name) => toolFamilyOf(name)).filter((family) => family !== "none"))];
}

export function formatToolForModel(tool: IntelligenceToolSpec): string {
  const params = Object.entries(tool.parameters)
    .map(([key, value]) => `${key}${value.required ? "*" : ""}: ${value.description}`)
    .join("; ");
  return [
    tool.description,
    `Live current data: ${tool.live ? "yes" : "no"}.`,
    `Intent class: ${tool.intentClass}.`,
    `When to use: ${tool.whenToUse}`,
    `Examples: ${tool.intentExamples}.`,
    `When not: ${tool.whenNotToUse}`,
    params ? `Required/optional args: ${params}.` : "Args: none.",
    `Returns: ${tool.outputShape}.`,
  ].join(" ");
}

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
    .map((tool) => `- ${tool.name}: ${formatToolForModel(tool)}`)
    .join("\n");
}
