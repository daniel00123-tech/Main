/**
 * Frozen EL Business acceptance prompts. Do not reword between baseline and retest.
 */

export type CampaignFamily = "xero" | "outlook" | "knowledge" | "infra" | "rbac";
export type CampaignChannel = "shared" | "chatgpt" | "portal_chat" | "whatsapp_gated";

export type CampaignCase = {
  id: string;
  family: CampaignFamily;
  prompt: string;
  priorIds?: string[];
  expectedScope: string;
  expectedToolFamily: "xero" | "outlook" | "knowledge" | "catalogue" | "capability" | "conversation" | "controlled" | "system_meta";
  expectedTool?: string | null;
  expectedCapability: string;
  role?: "director" | "finance_team" | "office_staff";
  expectDenied?: boolean;
};

export const ROUND1_CASES: CampaignCase[] = [
  { id: "X1", family: "xero", prompt: "What are our Xero sales this month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_sales_summary", expectedCapability: "xero.sales.read" },
  { id: "X2", family: "xero", prompt: "What were our Xero sales last month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_sales_summary", expectedCapability: "xero.sales.read" },
  { id: "X3", family: "xero", prompt: "How much have we invoiced today?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_sales_summary", expectedCapability: "xero.sales.read" },
  { id: "X4", family: "xero", prompt: "What invoices are currently outstanding?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_search_invoices", expectedCapability: "xero.sales.read" },
  { id: "X5", family: "xero", prompt: "What invoices are overdue?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_list_overdue_invoices", expectedCapability: "xero.sales.read" },
  { id: "X6", family: "xero", prompt: "Who are our top customers this month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_top_customers", expectedCapability: "xero.sales.read" },
  { id: "X7", family: "xero", prompt: "Show me invoice INV-02268.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },
  { id: "X8", family: "xero", prompt: "What invoices make up this month’s sales?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_search_invoices", expectedCapability: "xero.sales.read" },
  { id: "X9", family: "xero", prompt: "whats our xero sales this mnth", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_sales_summary", expectedCapability: "xero.sales.read" },
  { id: "X10", family: "xero", prompt: "How did last month compare with this month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_sales_summary", expectedCapability: "xero.sales.read", priorIds: ["X1"] },

  { id: "O1", family: "outlook", prompt: "What is the newest email in the info inbox?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_list_messages", expectedCapability: "mail.info.read" },
  { id: "O2", family: "outlook", prompt: "What is the newest email in the finance inbox?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_list_messages", expectedCapability: "mail.finance.read" },
  { id: "O3", family: "outlook", prompt: "Who emailed info most recently?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_list_messages", expectedCapability: "mail.info.read" },
  { id: "O4", family: "outlook", prompt: "Show me emails received today.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "O5", family: "outlook", prompt: "Find emails from Sharon.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_search_mailbox", expectedCapability: "mail.info.read" },
  { id: "O6", family: "outlook", prompt: "How many emails has Sharon sent today?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_search_mailbox", expectedCapability: "mail.info.read" },
  { id: "O7", family: "outlook", prompt: "Find emails mentioning invoice.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedTool: "outlook_search_mailbox", expectedCapability: "mail.info.read" },
  { id: "O8", family: "outlook", prompt: "What does the latest email in info actually say?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "O9", family: "outlook", prompt: "Show me the last five emails in info.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "O10", family: "outlook", prompt: "find emials about PO", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },

  { id: "K1", family: "knowledge", prompt: "What is the PO process?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "K2", family: "knowledge", prompt: "Find the PO process document.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "K3", family: "knowledge", prompt: "What is the newest document in OneDrive?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "K4", family: "knowledge", prompt: "Show me the latest ten documents.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "K5", family: "knowledge", prompt: "Find documents about health and safety.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "K6", family: "knowledge", prompt: "Open the most relevant health and safety document and tell me what it says.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "K7", family: "knowledge", prompt: "Who created or last modified the newest file?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "K8", family: "knowledge", prompt: "What does our company information say about purchase orders?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "K9", family: "knowledge", prompt: "Give me more detail.", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "knowledge.company.read", priorIds: ["K8"] },
  { id: "K10", family: "knowledge", prompt: "What were we talking about?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "knowledge.company.read", priorIds: ["K8", "K9"] },

  { id: "I1", family: "infra", prompt: "What can you help me with for EL Business?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "system.health" },
  { id: "I2", family: "infra", prompt: "Which systems are connected?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedTool: "get_connector_status", expectedCapability: "system.health" },
  { id: "I3", family: "infra", prompt: "Can you access Xero?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "xero.sales.read" },
  { id: "I4", family: "infra", prompt: "Can you read emails?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "mail.info.read" },
  { id: "I5", family: "infra", prompt: "Can you send emails?", expectedScope: "CONTROLLED_ACTION", expectedToolFamily: "controlled", expectedCapability: "mail.info.write" },
  { id: "I6", family: "infra", prompt: "Can you create Xero invoices?", expectedScope: "CONTROLLED_ACTION", expectedToolFamily: "controlled", expectedCapability: "xero.draft.write" },
  { id: "I7", family: "infra", prompt: "Search emails for PO.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "I8", family: "infra", prompt: "No, I meant company documents.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read", priorIds: ["I7"] },
  { id: "I9", family: "infra", prompt: "Actually, check Xero instead.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", priorIds: ["I8"] },
  { id: "I10", family: "infra", prompt: "What were we just doing?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "system.health", priorIds: ["I9"] },
  { id: "I11", family: "infra", prompt: "Give me more detail.", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "system.health", priorIds: ["I9", "I10"] },
  { id: "I12", family: "infra", prompt: "Who was that from?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "mail.info.read", priorIds: ["O1"] },
  { id: "I13", family: "infra", prompt: "When did it arrive?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "mail.info.read", priorIds: ["O1", "I12"] },
  { id: "I14", family: "infra", prompt: "What about last month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", priorIds: ["X1"] },
  { id: "I15", family: "infra", prompt: "Find the newest file and tell me what it’s about.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "I16", family: "infra", prompt: "How many files do we have?", expectedScope: "SYSTEM_META", expectedToolFamily: "system_meta", expectedCapability: "knowledge.company.read" },
  { id: "I17", family: "infra", prompt: "What invoices are overdue and then show me the newest info email?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "I18", family: "infra", prompt: "Search info for INV-02268.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "I19", family: "infra", prompt: "Show me INV-02268 in Xero.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },
  { id: "I20", family: "infra", prompt: "Forget that — search the company files for invoice process.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read", priorIds: ["I19"] },

  { id: "RBAC-X-OFFICE", family: "rbac", prompt: "What are our Xero sales this month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", role: "office_staff", expectDenied: true },
  { id: "RBAC-X-FINANCE", family: "rbac", prompt: "What are our Xero sales this month?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", role: "finance_team" },
  { id: "RBAC-O-FINANCE-OFFICE", family: "rbac", prompt: "What is the newest email in finance?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.finance.read", role: "office_staff", expectDenied: true },
  { id: "RBAC-O-INFO-OFFICE", family: "rbac", prompt: "What is the newest email in info?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read", role: "office_staff" },
];

export const ROUND2_CASES: CampaignCase[] = [
  { id: "R2-X1", family: "xero", prompt: "How have sales looked over the past four weeks?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-X2", family: "xero", prompt: "Compare August sales with July.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-X3", family: "xero", prompt: "Which invoices are still unpaid?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_search_invoices", expectedCapability: "xero.sales.read" },
  { id: "R2-X4", family: "xero", prompt: "Rank our biggest customers this quarter.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_top_customers", expectedCapability: "xero.sales.read" },
  { id: "R2-X5", family: "xero", prompt: "Open Xero invoice INV-99999.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },
  { id: "R2-X6", family: "xero", prompt: "xero slaes yday", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-X7", family: "xero", prompt: "And the month before that?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", priorIds: ["R2-X1"] },
  { id: "R2-X8", family: "xero", prompt: "What did we invoice around month end?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-X9", family: "xero", prompt: "The email mentioned INV-02268 — look that invoice up in Xero.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },
  { id: "R2-X10", family: "xero", prompt: "Show me invoice INV-00000.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },

  { id: "R2-O1", family: "outlook", prompt: "Has Lauren emailed info this week?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O2", family: "outlook", prompt: "Any info emails from yesterday?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O3", family: "outlook", prompt: "Count today’s info emails.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O4", family: "outlook", prompt: "What was the subject of the latest info email?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O5", family: "outlook", prompt: "Read the full newest info message.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O6", family: "outlook", prompt: "Check finance inbox, not info.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.finance.read" },
  { id: "R2-O7", family: "outlook", prompt: "Newest finance mailbox item.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.finance.read" },
  { id: "R2-O8", family: "outlook", prompt: "serch emial for quote", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O9", family: "outlook", prompt: "Find emails from Sam.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-O10", family: "outlook", prompt: "Who sent that one?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "mail.info.read", priorIds: ["R2-O4"] },

  { id: "R2-K1", family: "knowledge", prompt: "What’s the most recently uploaded company file?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "R2-K2", family: "knowledge", prompt: "Which file was modified most recently?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedTool: "list_documents", expectedCapability: "knowledge.company.read" },
  { id: "R2-K3", family: "knowledge", prompt: "Search company files for induction.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "R2-K4", family: "knowledge", prompt: "Open that induction document and summarise it.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read", priorIds: ["R2-K3"] },
  { id: "R2-K5", family: "knowledge", prompt: "What’s the source URL for that file?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "knowledge.company.read", priorIds: ["R2-K4"] },
  { id: "R2-K6", family: "knowledge", prompt: "Tell me more about that same document.", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "knowledge.company.read", priorIds: ["R2-K4"] },
  { id: "R2-K7", family: "knowledge", prompt: "How do we raise a purchase order?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "R2-K8", family: "knowledge", prompt: "Find a document called ZZXQ-NO-SUCH-POLICY.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "R2-K9", family: "knowledge", prompt: "Open the safety file.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "R2-K10", family: "knowledge", prompt: "Switch to the vehicle policy instead.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read", priorIds: ["R2-K9"] },

  { id: "R2-I1", family: "infra", prompt: "What are you allowed to do for EL?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "system.health" },
  { id: "R2-I2", family: "infra", prompt: "Is BigChange connected?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "system.health" },
  { id: "R2-I3", family: "infra", prompt: "Sorry — I meant emails, not Xero.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read", priorIds: ["X1"] },
  { id: "R2-I4", family: "infra", prompt: "Now look in company knowledge instead.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read", priorIds: ["R2-I3"] },
  { id: "R2-I5", family: "infra", prompt: "Remind me what we just asked.", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "system.health", priorIds: ["R2-I4"] },
  { id: "R2-I6", family: "infra", prompt: "Overdue invoices, then the newest info mail.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-I7", family: "infra", prompt: "Search company files for the last email subject.", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "knowledge", expectedCapability: "knowledge.company.read" },
  { id: "R2-I8", family: "infra", prompt: "What is the newest email in finance?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.finance.read", role: "office_staff", expectDenied: true },
  { id: "R2-I9", family: "infra", prompt: "If Xero is down, what should you say?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "system.health" },
  { id: "R2-I10", family: "infra", prompt: "Find a Xero invoice called NOT-A-REAL-INV.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read" },
  { id: "R2-I11", family: "infra", prompt: "More detail.", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "system.health", priorIds: ["R2-I6"] },
  { id: "R2-I12", family: "infra", prompt: "What exactly did that invoice say?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", priorIds: ["X7"] },
  { id: "R2-I13", family: "infra", prompt: "When was that email received?", expectedScope: "GENERAL_CONVERSATION", expectedToolFamily: "conversation", expectedCapability: "mail.info.read", priorIds: ["O1"] },
  { id: "R2-I14", family: "infra", prompt: "Who sent the latest info email?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-I15", family: "infra", prompt: "What’s the latest company document about?", expectedScope: "COMPANY_KNOWLEDGE", expectedToolFamily: "catalogue", expectedCapability: "knowledge.company.read" },
  { id: "R2-I16", family: "infra", prompt: "Show Sharon the finance mailbox.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.finance.read", role: "office_staff", expectDenied: true },
  { id: "R2-I17", family: "infra", prompt: "Sharon, what are our Xero sales?", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedCapability: "xero.sales.read", role: "office_staff", expectDenied: true },
  { id: "R2-I18", family: "infra", prompt: "Which live systems can EL use today?", expectedScope: "CONNECTOR_CAPABILITY", expectedToolFamily: "capability", expectedCapability: "system.health" },
  { id: "R2-I19", family: "infra", prompt: "Search info for purchase order.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "outlook", expectedCapability: "mail.info.read" },
  { id: "R2-I20", family: "infra", prompt: "Show me INV-02268 in Xero, not email.", expectedScope: "BUSINESS_SYSTEM", expectedToolFamily: "xero", expectedTool: "xero_get_invoice", expectedCapability: "xero.sales.read" },
];
