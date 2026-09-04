/**
 * Frozen EL Business WhatsApp 50-question suite.
 * Do not alter wording between baseline and rerun.
 */
export const SUITE_ID = "el-business-whatsapp-50-v1" as const;
export const SUITE_COMPANY_ID = "co_el" as const;

export type SuiteActor = "director" | "office_staff";
export type SuiteConversation = "xero" | "outlook" | "mixed" | "rbac_office" | "rbac_auth" | "failure";
export type SuiteFamily = "xero" | "outlook" | "knowledge" | "catalogue" | "memory" | "correction" | "rbac";

export type FrozenQuestion = {
  id: string;
  section: "A" | "B" | "C" | "D" | "E";
  text: string;
  actor: SuiteActor;
  conversation: SuiteConversation;
  family: SuiteFamily;
  expectedToolPrefix: string | null;
  expectedDeny: boolean;
  mailbox?: "info" | "finance";
  notes?: string;
};

export const EL_BUSINESS_WHATSAPP_50_V1: FrozenQuestion[] = [
  { id: "A1", section: "A", text: "What are our Xero sales today?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A2", section: "A", text: "What are our sales this month?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A3", section: "A", text: "What were our sales last month?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A4", section: "A", text: "What are our sales this week?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A5", section: "A", text: "What did we invoice yesterday?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A6", section: "A", text: "What invoices were raised today?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A7", section: "A", text: "Show me the invoices raised this month.", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A8", section: "A", text: "What are our outstanding invoices?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A9", section: "A", text: "What invoices are overdue?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A10", section: "A", text: "Who are our top customers this month?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A11", section: "A", text: "Show me invoice INV-02268.", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A12", section: "A", text: "How much have we invoiced in September?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A13", section: "A", text: "What were August sales?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A14", section: "A", text: "What invoices make up this month’s sales?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "A15", section: "A", text: "whats our xero sales this mnth", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "B1", section: "B", text: "What is the newest email in the info inbox?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "info" },
  { id: "B2", section: "B", text: "What is the newest email in the finance inbox?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "finance" },
  { id: "B3", section: "B", text: "Find emails from Sharon.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B4", section: "B", text: "Search emails with PO in the subject.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B5", section: "B", text: "How many emails has Sharon sent today?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B6", section: "B", text: "How many emails did we get today?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B7", section: "B", text: "Show me the latest unread email.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B8", section: "B", text: "Find emails containing invoice.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B9", section: "B", text: "Find emails containing PO.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B10", section: "B", text: "Show me the last 5 emails in info.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "info" },
  { id: "B11", section: "B", text: "What emails arrived today?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B12", section: "B", text: "find emials from Sharon", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B13", section: "B", text: "Who emailed us most recently?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "B14", section: "B", text: "What does the newest info email say?", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "info" },
  { id: "B15", section: "B", text: "Show me the full latest info email.", actor: "director", conversation: "outlook", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "info" },
  { id: "C1", section: "C", text: "What is the PO process?", actor: "director", conversation: "mixed", family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedDeny: false },
  { id: "C2", section: "C", text: "Find the PO process document.", actor: "director", conversation: "mixed", family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedDeny: false },
  { id: "C3", section: "C", text: "Search emails for PO.", actor: "director", conversation: "mixed", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "C4", section: "C", text: "Show Xero invoices with PO references.", actor: "director", conversation: "mixed", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "C5", section: "C", text: "Find the newest OneDrive document.", actor: "director", conversation: "mixed", family: "catalogue", expectedToolPrefix: "list_documents", expectedDeny: false },
  { id: "C6", section: "C", text: "What are our sales and then show the latest finance email?", actor: "director", conversation: "mixed", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false, notes: "compound: Xero then Outlook finance" },
  { id: "C7", section: "C", text: "No, I meant email.", actor: "director", conversation: "mixed", family: "correction", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "C8", section: "C", text: "No, I meant Xero.", actor: "director", conversation: "mixed", family: "correction", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "D1", section: "D", text: "More detail.", actor: "director", conversation: "xero", family: "memory", expectedToolPrefix: null, expectedDeny: false },
  { id: "D2", section: "D", text: "What exactly?", actor: "director", conversation: "xero", family: "memory", expectedToolPrefix: null, expectedDeny: false },
  { id: "D3", section: "D", text: "When?", actor: "director", conversation: "xero", family: "memory", expectedToolPrefix: null, expectedDeny: false },
  { id: "D4", section: "D", text: "Who?", actor: "director", conversation: "xero", family: "memory", expectedToolPrefix: null, expectedDeny: false },
  { id: "D5", section: "D", text: "What were we talking about?", actor: "director", conversation: "xero", family: "memory", expectedToolPrefix: null, expectedDeny: false },
  { id: "D6", section: "D", text: "What about last month?", actor: "director", conversation: "xero", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "D7", section: "D", text: "Show me the emails behind that.", actor: "director", conversation: "xero", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false },
  { id: "E1", section: "E", text: "What are our Xero sales today?", actor: "office_staff", conversation: "rbac_office", family: "rbac", expectedToolPrefix: "xero_", expectedDeny: true },
  { id: "E2", section: "E", text: "What is the newest email in the finance inbox?", actor: "office_staff", conversation: "rbac_office", family: "rbac", expectedToolPrefix: "outlook_", expectedDeny: true, mailbox: "finance" },
  { id: "E3", section: "E", text: "What is the newest email in the info inbox?", actor: "office_staff", conversation: "rbac_office", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, mailbox: "info" },
  { id: "E4", section: "E", text: "What are our Xero sales this month?", actor: "director", conversation: "rbac_auth", family: "xero", expectedToolPrefix: "xero_", expectedDeny: false },
  { id: "E5", section: "E", text: "What is the newest email in the info inbox?", actor: "director", conversation: "failure", family: "outlook", expectedToolPrefix: "outlook_", expectedDeny: false, notes: "controlled 502 simulation" },
];

export const REAL_META_SUBSET_IDS = ["A2", "A8", "A10", "B1", "B3", "B6", "C1", "C5", "C7", "D5"] as const;
