import type { OvernightQuestion } from "./types";

const D = "director" as const;
const O = "office_staff" as const;

export const OVERNIGHT_WHATSAPP: OvernightQuestion[] = [
  { id: "WA01", channel: "whatsapp", text: "How much have we taken in sales so far this month?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "WA02", channel: "whatsapp", text: "What did last month's invoiced sales come to?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WA03", channel: "whatsapp", text: "Which customer invoices are currently overdue?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "WA04", channel: "whatsapp", text: "Look up invoice INV-02268 and tell me whether it is still outstanding.", actor: D, family: "xero_live", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "WA05", channel: "whatsapp", text: "Who are the highest-value customers in the current period?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "WA06", channel: "whatsapp", text: "What's the latest email sitting in the info mailbox?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA07", channel: "whatsapp", text: "What's the newest message in the finance inbox?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA08", channel: "whatsapp", text: "Show me recent emails sent by Sharon.", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA09", channel: "whatsapp", text: "Find emails whose subject mentions invoice.", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA10", channel: "whatsapp", text: "From the newest info email, what are they asking us to do?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA11", channel: "whatsapp", text: "What's our purchase-order process?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "WA12", channel: "whatsapp", text: "What does the company health and safety document say about site visits?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "WA13", channel: "whatsapp", text: "Is there a knowledge document about intergalactic onboarding fees?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, notes: "honest no-result expected if nothing matches" },
  { id: "WA14", channel: "whatsapp", text: "Using that PO document, what happens after approval?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "WA15", channel: "whatsapp", text: "What's the newest file in OneDrive?", actor: D, family: "catalogue", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "WA16", channel: "whatsapp", text: "Which documents were added most recently?", actor: D, family: "catalogue", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "WA17", channel: "whatsapp", text: "Give me this month's sales and the latest info email.", actor: D, family: "mixed", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false, notes: "compound Xero + Outlook" },
  { id: "WA18", channel: "whatsapp", text: "Combine last month's Xero sales with the PO process.", actor: D, family: "mixed", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WA19", channel: "whatsapp", text: "Find the latest finance email and the newest OneDrive file.", actor: D, family: "mixed", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "WA20", channel: "whatsapp", text: "No, I meant email.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
];

export const OVERNIGHT_PORTAL: OvernightQuestion[] = [
  { id: "PC01", channel: "portal", text: "Can you give me the current-period Xero sales total?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "PC02", channel: "portal", text: "How do August sales compare with July?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "PC03", channel: "portal", text: "Open the info mailbox and show the most recent message.", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "PC04", channel: "portal", text: "Search the mailbox for messages from Lauren.", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "PC05", channel: "portal", text: "Summarise what the latest info email is asking, without sending anything.", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "PC06", channel: "portal", text: "Draft a short reply in chat only — do not send it.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "portal-email", sequenceIndex: 2 },
  { id: "PC07", channel: "portal", text: "Make that draft shorter.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "portal-email", sequenceIndex: 3 },
  { id: "PC08", channel: "portal", text: "Make it friendlier.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "portal-email", sequenceIndex: 4 },
  { id: "PC09", channel: "portal", text: "Look up the purchase order process in company knowledge.", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "PC10", channel: "portal", text: "What is the newest indexed document?", actor: D, family: "catalogue", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "PC11", channel: "portal", text: "I need this month's sales plus the newest info mailbox item.", actor: D, family: "mixed", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "PC12", channel: "portal", text: "Check company knowledge for the PO process and also the latest info email.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "PC13", channel: "portal", text: "No, I meant the mailbox, not Xero.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "PC14", channel: "portal", text: "If we added one more cleaning round per site, what operational risks should we think about?", actor: D, family: "no_tool", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "PC15", channel: "portal", text: "What is 17.5% of 2400?", actor: D, family: "no_tool", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "PC16", channel: "portal", text: "Are any invoices overdue right now?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "PC17", channel: "portal", text: "How many invoices did we raise in April?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "PC18", channel: "portal", text: "Has INV-02268 been paid yet?", actor: D, family: "xero_live", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "PC19", channel: "portal", text: "What were we just discussing?", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "PC20", channel: "portal", text: "Tell me our Xero sales this month.", actor: O, family: "rbac", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: true },
];

export const OVERNIGHT_MCP: OvernightQuestion[] = [
  { id: "MCP01", channel: "mcp", text: "Current-period sales summary", actor: D, family: "xero_live", expectedToolPrefix: "xero_sales_summary", expectedSource: "xero_live", expectedDeny: false, mcpTool: "xero_sales_summary", mcpArgs: {} },
  { id: "MCP02", channel: "mcp", text: "March historical sales from warehouse", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_sales_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_sales_analysis", mcpArgs: { fromDate: "2026-03-01", toDate: "2026-03-31", aggregation: "sales_total" } },
  { id: "MCP03", channel: "mcp", text: "List overdue invoices live", actor: D, family: "xero_live", expectedToolPrefix: "xero_list_overdue_invoices", expectedSource: "xero_live", expectedDeny: false, mcpTool: "xero_list_overdue_invoices", mcpArgs: {} },
  { id: "MCP04", channel: "mcp", text: "Exact invoice INV-02268", actor: D, family: "xero_live", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false, mcpTool: "xero_get_invoice", mcpArgs: { invoiceNumber: "INV-02268" } },
  { id: "MCP05", channel: "mcp", text: "Top customers live", actor: D, family: "xero_live", expectedToolPrefix: "xero_top_customers", expectedSource: "xero_live", expectedDeny: false, mcpTool: "xero_top_customers", mcpArgs: {} },
  { id: "MCP06", channel: "mcp", text: "Latest info mailbox messages", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, mcpTool: "outlook_list_messages", mcpArgs: { mailboxAddress: "info@elvexpropertyservices.com", limit: 1 } },
  { id: "MCP07", channel: "mcp", text: "Search mailbox for Sharon", actor: D, family: "outlook", expectedToolPrefix: "outlook_search_mailbox", expectedSource: "outlook", expectedDeny: false, mcpTool: "outlook_search_mailbox", mcpArgs: { query: "Sharon", mailboxAddress: "info@elvexpropertyservices.com" } },
  { id: "MCP08", channel: "mcp", text: "Company knowledge PO process", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, mcpTool: "search_company_knowledge", mcpArgs: { query: "purchase order process" } },
  { id: "MCP09", channel: "mcp", text: "Honest no-result knowledge", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, mcpTool: "search_company_knowledge", mcpArgs: { query: "intergalactic onboarding fees zx9" } },
  { id: "MCP10", channel: "mcp", text: "Newest catalogue documents", actor: D, family: "catalogue", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false, mcpTool: "list_documents", mcpArgs: { limit: 5 } },
  { id: "MCP11", channel: "mcp", text: "April warehouse invoice count", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_invoice_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_invoice_analysis", mcpArgs: { fromDate: "2026-04-01", toDate: "2026-04-30" } },
  { id: "MCP12", channel: "mcp", text: "May warehouse sales", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_sales_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_sales_analysis", mcpArgs: { fromDate: "2026-05-01", toDate: "2026-05-31", aggregation: "sales_total" } },
  { id: "MCP13", channel: "mcp", text: "Last six months warehouse trend", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_sales_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_sales_analysis", mcpArgs: { fromDate: "2026-03-01", toDate: "2026-08-31", aggregation: "sales_by_month" } },
  { id: "MCP14", channel: "mcp", text: "Warehouse customer analysis", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_customer_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_customer_analysis", mcpArgs: { fromDate: "2026-03-01", toDate: "2026-08-31", limit: 10 } },
  { id: "MCP15", channel: "mcp", text: "Finance mailbox list", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, mcpTool: "outlook_list_messages", mcpArgs: { mailboxAddress: "finance@elvexpropertyservices.com", limit: 1 } },
  { id: "MCP16", channel: "mcp", text: "Office staff Xero denied", actor: O, family: "rbac", expectedToolPrefix: "xero_sales_summary", expectedSource: "xero_live", expectedDeny: true, mcpTool: "xero_sales_summary", mcpArgs: {} },
  { id: "MCP17", channel: "mcp", text: "Office staff finance mailbox denied", actor: O, family: "rbac", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: true, mcpTool: "outlook_list_messages", mcpArgs: { mailboxAddress: "finance@elvexpropertyservices.com", limit: 1 } },
  { id: "MCP18", channel: "mcp", text: "Office staff info mailbox allowed", actor: O, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, mcpTool: "outlook_list_messages", mcpArgs: { mailboxAddress: "info@elvexpropertyservices.com", limit: 1 } },
  { id: "MCP19", channel: "mcp", text: "Warehouse receivables historical", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_receivables_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_receivables_analysis", mcpArgs: { aggregation: "overdue_total" } },
  { id: "MCP20", channel: "mcp", text: "Live organisation profile", actor: D, family: "xero_live", expectedToolPrefix: "xero_get_organisation", expectedSource: "xero_live", expectedDeny: false, mcpTool: "xero_get_organisation", mcpArgs: {} },
];

export const OVERNIGHT_WAREHOUSE: OvernightQuestion[] = [
  { id: "WH01", channel: "warehouse", text: "What were sales in March?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH02", channel: "warehouse", text: "What were April sales?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH03", channel: "warehouse", text: "What were May sales?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH04", channel: "warehouse", text: "Give me a month-over-month sales comparison for the last few completed months.", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH05", channel: "warehouse", text: "Summarise sales for the last 3 completed months.", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH06", channel: "warehouse", text: "How did sales move over the last 6 months?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH07", channel: "warehouse", text: "How many invoices did we raise historically in April?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH08", channel: "warehouse", text: "How has overdue debt moved over the last few months?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH09", channel: "warehouse", text: "Who were the highest-value customers over this historical period?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "WH10", channel: "warehouse", text: "Give me a trend summary of invoiced sales across completed months.", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
];

export const OVERNIGHT_FOLLOWUP: OvernightQuestion[] = [
  { id: "FU01", channel: "followup", text: "What's the latest email in the info inbox?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "email", sequenceIndex: 1 },
  { id: "FU02", channel: "followup", text: "What are they asking?", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email", sequenceIndex: 2 },
  { id: "FU03", channel: "followup", text: "Draft a reply in chat only. Do not send it.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email", sequenceIndex: 3 },
  { id: "FU04", channel: "followup", text: "Make it shorter.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email", sequenceIndex: 4 },
  { id: "FU05", channel: "followup", text: "Make it friendlier.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email", sequenceIndex: 5 },
  { id: "FU06", channel: "followup", text: "What are sales this month?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false, sequence: "xero", sequenceIndex: 1 },
  { id: "FU07", channel: "followup", text: "What about last month?", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false, sequence: "xero", sequenceIndex: 2 },
  { id: "FU08", channel: "followup", text: "Is that better?", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "xero", sequenceIndex: 3 },
  { id: "FU09", channel: "followup", text: "Give me a management summary.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "xero", sequenceIndex: 4 },
  { id: "FU10", channel: "followup", text: "No, I meant email.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "xero", sequenceIndex: 5 },
];

export const OVERNIGHT_ROUTING: OvernightQuestion[] = [
  { id: "RT01", channel: "whatsapp", text: "What are sales right now?", actor: D, family: "routing", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "RT02", channel: "whatsapp", text: "What were sales in March?", actor: D, family: "routing", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "RT03", channel: "whatsapp", text: "Has INV-02268 been paid?", actor: D, family: "routing", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "RT04", channel: "whatsapp", text: "How many invoices did we raise in April?", actor: D, family: "routing", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "RT05", channel: "whatsapp", text: "What are overdue invoices right now?", actor: D, family: "routing", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "RT06", channel: "whatsapp", text: "How has overdue debt moved over the last few months?", actor: D, family: "routing", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
];

export const OVERNIGHT_PRIMARY: OvernightQuestion[] = [
  ...OVERNIGHT_WHATSAPP,
  ...OVERNIGHT_PORTAL,
  ...OVERNIGHT_MCP,
  ...OVERNIGHT_WAREHOUSE,
  ...OVERNIGHT_FOLLOWUP,
];

export const OVERNIGHT_ALL: OvernightQuestion[] = [...OVERNIGHT_PRIMARY, ...OVERNIGHT_ROUTING];

export function questionsForStage(stage: string, ids?: string[]): OvernightQuestion[] {
  const map: Record<string, OvernightQuestion[]> = {
    whatsapp: OVERNIGHT_WHATSAPP,
    portal: OVERNIGHT_PORTAL,
    mcp: OVERNIGHT_MCP,
    warehouse: OVERNIGHT_WAREHOUSE,
    followup: OVERNIGHT_FOLLOWUP,
    routing: OVERNIGHT_ROUTING,
    primary: OVERNIGHT_PRIMARY,
    all: OVERNIGHT_ALL,
    retest: FRESH_RETEST_SETS[0] ?? [],
  };
  const rows = map[stage] ?? OVERNIGHT_PRIMARY;
  if (ids?.length) return rows.filter((row) => ids.includes(row.id));
  return rows;
}

export const FRESH_RETEST_SETS: OvernightQuestion[][] = [
  [
    { id: "R1A01", channel: "whatsapp", text: "What is the invoiced total for the current month so far?", actor: D, family: "xero_live", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
    { id: "R1A02", channel: "whatsapp", text: "Show March invoiced sales from stored history.", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
    { id: "R1A03", channel: "portal", text: "Who emailed info most recently?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
    { id: "R1A04", channel: "portal", text: "Where is the written PO process kept?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
    { id: "R1A05", channel: "mcp", text: "Warehouse June sales if present", actor: D, family: "xero_warehouse", expectedToolPrefix: "warehouse_sales_analysis", expectedSource: "xero_warehouse", expectedDeny: false, mcpTool: "warehouse_sales_analysis", mcpArgs: { fromDate: "2026-06-01", toDate: "2026-06-30", aggregation: "sales_total" } },
    { id: "R1A06", channel: "whatsapp", text: "Is invoice INV-02268 paid yet?", actor: D, family: "xero_live", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
    { id: "R1A07", channel: "portal", text: "List the most recently indexed files.", actor: D, family: "catalogue", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
    { id: "R1A08", channel: "followup", text: "Using the last info email, what do they want from us?", actor: D, family: "outlook", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
    { id: "R1A09", channel: "whatsapp", text: "No — I wanted the mailbox, not the ledger.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
    { id: "R1A10", channel: "portal", text: "What is 12% of 850?", actor: D, family: "no_tool", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  ],
];
