import type { TargetedQuestion } from "./types";

const D = "director" as const;

export const TARGETED_PRIMARY: TargetedQuestion[] = [
  { id: "K01", channel: "portal", text: "What does the Health & Safety Policy say about reporting an accident?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K02", channel: "portal", text: "What does the Profit Margin Policy say about invoices or job references?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K03", channel: "portal", text: "Is there a Finance Admin knowledge document, and what does it cover?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K04", channel: "portal", text: "What does the Subcontractor Booking process document say?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K05", channel: "portal", text: "How should a leak or gas emergency be handled according to the Health and Safety Policy?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K06", channel: "portal", text: "What does the Subcontractor Payment Process say?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K07", channel: "portal", text: "What does Admin Structure September 2026 cover?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K08", channel: "portal", text: "What does the SRFM Sub Contractor MASTER document cover?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K09", channel: "portal", text: "Search company knowledge for the Finance Admin AI Knowledge Base and summarise it.", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "K10", channel: "portal", text: "Is there a documented purchase-order process in company knowledge?", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, honestNoResultOk: true },

  { id: "O01", channel: "portal", text: "What is the newest subject sitting in the info inbox?", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },
  { id: "O02", channel: "portal", text: "Who sent the most recent finance mailbox email?", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },
  { id: "O03", channel: "portal", text: "What are they asking in the latest info email?", actor: D, family: "outlook", expectedToolPrefix: "outlook_get_message", expectedSource: "outlook", expectedDeny: false },
  { id: "O04", channel: "portal", text: "Summarise the newest email in info.", actor: D, family: "outlook", expectedToolPrefix: "outlook_get_message", expectedSource: "outlook", expectedDeny: false },
  { id: "O05", channel: "followup", text: "Draft a response I can send.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email_body", sequenceIndex: 3 },
  { id: "O06", channel: "portal", text: "Search the info inbox for anything about a quote.", actor: D, family: "outlook", expectedToolPrefix: "outlook_search_mailbox", expectedSource: "outlook", expectedDeny: false },
  { id: "O07", channel: "portal", text: "Show the last three emails in the info mailbox.", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },
  { id: "O08", channel: "portal", text: "What does the latest finance email actually say?", actor: D, family: "outlook", expectedToolPrefix: "outlook_get_message", expectedSource: "outlook", expectedDeny: false },
  { id: "O09", channel: "portal", text: "When did the newest info email arrive?", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },
  { id: "O10", channel: "portal", text: "Are there unread messages in the info mailbox?", actor: D, family: "outlook", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },

  { id: "M01", channel: "portal", text: "What were March sales and what does our payment process say?", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M02", channel: "portal", text: "Latest finance email plus the health and safety accident rule.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M03", channel: "portal", text: "Any overdue invoices right now, and what does the subcontractor booking process say?", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M04", channel: "portal", text: "Look up invoice INV-02268 and summarise the finance admin procedure.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M05", channel: "portal", text: "Last month’s sales and what the remittance process requires.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M06", channel: "portal", text: "What is the newest document filename, and what were March sales?", actor: D, family: "mixed", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "M07", channel: "portal", text: "List recent documents and the newest info email subject.", actor: D, family: "mixed", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "M08", channel: "portal", text: "Warehouse sales trend and what the profit margin policy requires.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M09", channel: "portal", text: "What does the latest info email say, compared with the leak procedure in knowledge?", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M10", channel: "portal", text: "Customer invoice INV-02268 and the payment process rule.", actor: D, family: "mixed", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "M11", channel: "portal", text: "Tell me last month’s sales and summarise the latest finance email.", actor: D, family: "mixed", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "M12", channel: "portal", text: "April warehouse sales together with the admin structure document.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M13", channel: "portal", text: "Current Xero sales this month and the newest finance mailbox subject.", actor: D, family: "mixed", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "M14", channel: "portal", text: "What does Health & Safety say about gas, and who emailed info last?", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M15", channel: "portal", text: "SRFM subcontractor form coverage plus live overdue invoices.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M16", channel: "portal", text: "March warehouse figures and the subcontractor payment process.", actor: D, family: "mixed", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "M17", channel: "portal", text: "Search company knowledge for asbestos and list the newest files.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M18", channel: "portal", text: "Finance admin knowledge base plus the latest info inbox subject.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M19", channel: "portal", text: "Lone-working guidance and top customers this month.", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "M20", channel: "portal", text: "What does the booking process require, and are there unread info emails?", actor: D, family: "mixed", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },

  { id: "D01", channel: "portal", text: "Search the info inbox for anything about a quote request.", actor: D, family: "outlook", expectedToolPrefix: "outlook_search_mailbox", expectedSource: "outlook", expectedDeny: false },
  { id: "D02", channel: "portal", text: "Look up invoice INV-02268 twice in one go — status only.", actor: D, family: "outlook", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "D03", channel: "portal", text: "Search company knowledge for the profit margin policy once.", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "D04", channel: "portal", text: "Warehouse March sales once, no extra live Xero.", actor: D, family: "mixed", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "D05", channel: "portal", text: "Search the info mailbox for Davies and stop after one search.", actor: D, family: "outlook", expectedToolPrefix: "outlook_search_mailbox", expectedSource: "outlook", expectedDeny: false },
  { id: "D06", channel: "portal", text: "Find invoice INV-02268 and do not fetch it again.", actor: D, family: "outlook", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },
  { id: "D07", channel: "portal", text: "Search knowledge for Finance Admin AI Knowledge Base.", actor: D, family: "knowledge", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "D08", channel: "portal", text: "April warehouse sales analysis only.", actor: D, family: "mixed", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "D09", channel: "portal", text: "Search info for Lewis Street quote.", actor: D, family: "outlook", expectedToolPrefix: "outlook_search_mailbox", expectedSource: "outlook", expectedDeny: false },
  { id: "D10", channel: "portal", text: "Look up INV-02268 status from Xero.", actor: D, family: "outlook", expectedToolPrefix: "xero_get_invoice", expectedSource: "xero_live", expectedDeny: false },

  { id: "C11", channel: "followup", text: "What are live Xero sales this month?", actor: D, family: "correction", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false, sequence: "corr2", sequenceIndex: 1 },
  { id: "C12", channel: "followup", text: "I meant the email.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr2", sequenceIndex: 2 },
  { id: "C13", channel: "followup", text: "No, check Outlook.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr2", sequenceIndex: 3 },
  { id: "C14", channel: "followup", text: "Sorry, I meant the document.", actor: D, family: "correction", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, sequence: "corr2", sequenceIndex: 4 },
  { id: "C15", channel: "followup", text: "Not Xero, the message.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr2", sequenceIndex: 5 },
  { id: "C16", channel: "followup", text: "Warehouse sales for September.", actor: D, family: "correction", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false, sequence: "corr3", sequenceIndex: 1 },
  { id: "C17", channel: "followup", text: "I meant August, not September.", actor: D, family: "correction", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false, sequence: "corr3", sequenceIndex: 2 },
  { id: "C18", channel: "followup", text: "Show me live Xero overdue.", actor: D, family: "correction", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false, sequence: "corr4", sequenceIndex: 1 },
  { id: "C19", channel: "followup", text: "I meant the email.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr4", sequenceIndex: 2 },
  { id: "C20", channel: "followup", text: "Sorry, I meant the document.", actor: D, family: "correction", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, sequence: "corr4", sequenceIndex: 3 },

  { id: "F01", channel: "followup", text: "What is the newest email in the info inbox?", actor: D, family: "followup", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, sequence: "email_body", sequenceIndex: 1 },
  { id: "F02", channel: "followup", text: "What are they asking?", actor: D, family: "followup", expectedToolPrefix: "outlook_get_message", expectedSource: "outlook", expectedDeny: false, sequence: "email_body", sequenceIndex: 2 },
  { id: "F03", channel: "followup", text: "Draft a reply I can copy.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email_body", sequenceIndex: 3 },
  { id: "F04", channel: "followup", text: "Shorter.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email_body", sequenceIndex: 4 },
  { id: "F05", channel: "followup", text: "Friendlier.", actor: D, family: "followup", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false, sequence: "email_body", sequenceIndex: 5 },
  { id: "C01", channel: "followup", text: "What are live Xero sales this month?", actor: D, family: "correction", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false, sequence: "corr_email", sequenceIndex: 1 },
  { id: "C02", channel: "followup", text: "No, check the inbox instead.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr_email", sequenceIndex: 2 },
  { id: "C03", channel: "followup", text: "I was talking about the email.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr_email", sequenceIndex: 3 },
  { id: "C04", channel: "followup", text: "Not Xero — the message from them.", actor: D, family: "correction", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false, sequence: "corr_email", sequenceIndex: 4 },
  { id: "C05", channel: "followup", text: "Sorry, I meant the document.", actor: D, family: "correction", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false, sequence: "corr_email", sequenceIndex: 5 },

  { id: "P01", channel: "portal", text: "Ping the portal with a short status check.", actor: D, family: "portal", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "P02", channel: "portal", text: "Continue in this same chat: what can you access?", actor: D, family: "portal", expectedToolPrefix: "get_user_capabilities", expectedSource: null, expectedDeny: false },
  { id: "P03", channel: "portal", text: "Open a second thought: how many files are indexed?", actor: D, family: "portal", expectedToolPrefix: "get_document_index_stats", expectedSource: "catalogue", expectedDeny: false },
  { id: "P04", channel: "portal", text: "Stay on this conversation and remind me what I just asked.", actor: D, family: "portal", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "P05", channel: "portal", text: "What systems are connected for EL?", actor: D, family: "portal", expectedToolPrefix: "get_connector_status", expectedSource: null, expectedDeny: false },
  { id: "P06", channel: "portal", text: "List the most recently indexed files.", actor: D, family: "portal", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "P07", channel: "portal", text: "Thanks — that helps.", actor: D, family: "portal", expectedToolPrefix: null, expectedSource: "none", expectedDeny: false },
  { id: "P08", channel: "portal", text: "Give me the company system snapshot.", actor: D, family: "portal", expectedToolPrefix: "get_company_system_summary", expectedSource: null, expectedDeny: false },
  { id: "P09", channel: "portal", text: "Which automations are active?", actor: D, family: "portal", expectedToolPrefix: "get_active_automations", expectedSource: null, expectedDeny: false },
  { id: "P10", channel: "portal", text: "When was knowledge last synced?", actor: D, family: "portal", expectedToolPrefix: "get_recent_sync_status", expectedSource: null, expectedDeny: false },

  { id: "T01", channel: "portal", text: "Telemetry probe: what is the newest info email subject?", actor: D, family: "telemetry", expectedToolPrefix: "outlook_list_messages", expectedSource: "outlook", expectedDeny: false, subjectOnly: true },
  { id: "T02", channel: "whatsapp", text: "Telemetry probe: live Xero sales this month?", actor: D, family: "telemetry", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "T03", channel: "portal", text: "Telemetry probe: search company knowledge for vans.", actor: D, family: "telemetry", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
  { id: "T04", channel: "portal", text: "Telemetry probe: who has portal access?", actor: D, family: "telemetry", expectedToolPrefix: "get_company_system_summary", expectedSource: null, expectedDeny: false },
  { id: "T05", channel: "whatsapp", text: "Telemetry probe: newest finance mailbox email?", actor: D, family: "telemetry", expectedToolPrefix: "outlook_", expectedSource: "outlook", expectedDeny: false },
  { id: "T06", channel: "portal", text: "Telemetry probe: warehouse March sales.", actor: D, family: "telemetry", expectedToolPrefix: "warehouse_", expectedSource: "xero_warehouse", expectedDeny: false },
  { id: "T07", channel: "portal", text: "Telemetry probe: capabilities for this role.", actor: D, family: "telemetry", expectedToolPrefix: "get_user_capabilities", expectedSource: null, expectedDeny: false },
  { id: "T08", channel: "portal", text: "Telemetry probe: list recent documents.", actor: D, family: "telemetry", expectedToolPrefix: "list_documents", expectedSource: "catalogue", expectedDeny: false },
  { id: "T09", channel: "whatsapp", text: "Telemetry probe: overdue invoices right now.", actor: D, family: "telemetry", expectedToolPrefix: "xero_", expectedSource: "xero_live", expectedDeny: false },
  { id: "T10", channel: "portal", text: "Telemetry probe: health and safety policy excerpt.", actor: D, family: "telemetry", expectedToolPrefix: "search_company_knowledge", expectedSource: "knowledge", expectedDeny: false },
];

export function questionsForStage(stage: string, ids?: string[]): TargetedQuestion[] {
  const wanted = new Set((ids ?? []).map((id) => id.toUpperCase()));
  const all = TARGETED_PRIMARY;
  if (wanted.size) return all.filter((row) => wanted.has(row.id));
  const key = stage.toLowerCase();
  if (key === "knowledge") return all.filter((row) => row.family === "knowledge" && row.id.startsWith("K"));
  if (key === "outlook") return all.filter((row) => row.family === "outlook" || row.id === "O05");
  if (key === "mixed") return all.filter((row) => row.family === "mixed" && row.id.startsWith("M"));
  if (key === "dedupe") return all.filter((row) => row.id.startsWith("D"));
  if (key === "correction") return all.filter((row) => /^C1[1-9]$|^C20$/.test(row.id));
  if (key === "followup") return all.filter((row) => row.family === "followup" || row.family === "correction");
  if (key === "portal") return all.filter((row) => row.family === "portal");
  if (key === "telemetry") return all.filter((row) => row.family === "telemetry");
  if (key === "primary") return all;
  return [];
}
