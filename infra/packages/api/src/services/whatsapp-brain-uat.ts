import { planWhatsAppTurn, type WhatsAppPlan } from "./whatsapp-plan";
import { emptyEntityMemory, type WhatsAppEntityMemory } from "./whatsapp-entities";
import { looksLikeRawToolDump } from "./whatsapp-compress";

export type WhatsAppUatCase = {
  id: number;
  group: string;
  prompt: string;
  memory?: WhatsAppEntityMemory;
  connectors?: string[];
  expect: {
    action?: WhatsAppPlan["action"];
    skipTools?: boolean;
    tool?: string | null;
    noWrite?: boolean;
  };
};

const coalDoc = {
  lastDocument: {
    id: "doc_coal",
    title: "Coal Search.pdf",
    url: "https://contoso.sharepoint.com/docs/CoalSearch.pdf",
    excerpt: "Payment confirmation £49.92 CAD021/01 coal search",
    amount: "£49.92",
    reference: "CAD021/01",
    sourceLabel: "Coal Search.pdf",
  },
};

export const WHATSAPP_BRAIN_UAT_CASES: WhatsAppUatCase[] = [
  { id: 1, group: "conversation", prompt: "Hi", expect: { action: "chat", skipTools: true } },
  { id: 2, group: "conversation", prompt: "Morning", expect: { action: "chat", skipTools: true } },
  { id: 3, group: "conversation", prompt: "How are you?", expect: { action: "chat", skipTools: true } },
  { id: 4, group: "conversation", prompt: "Thanks", expect: { action: "chat", skipTools: true } },
  { id: 5, group: "conversation", prompt: "What can you do?", expect: { action: "capabilities", skipTools: true } },
  { id: 6, group: "document", prompt: "Find the Coal Search document", expect: { action: "knowledge", tool: "search_company_knowledge" } },
  { id: 7, group: "document", prompt: "What is Coal Search about?", expect: { action: "knowledge" } },
  { id: 8, group: "document", prompt: "Summarise Coal Search", expect: { action: "knowledge" } },
  { id: 9, group: "document", prompt: "Find cold serch doc", expect: { action: "knowledge" } },
  { id: 10, group: "document", prompt: "Show me documents about Arnold Crescent", expect: { action: "knowledge" } },
  { id: 11, group: "follow-up", prompt: "Summarise it", memory: coalDoc, expect: { action: "memory_fact", useMemory: true } },
  { id: 12, group: "follow-up", prompt: "Give me more detail", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 13, group: "follow-up", prompt: "What was the amount?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 14, group: "follow-up", prompt: "Who sent it?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 15, group: "follow-up", prompt: "Send me the link", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 16, group: "follow-up", prompt: "Can I download it?", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 17, group: "follow-up", prompt: "Where did you get that from?", memory: coalDoc, expect: { action: "memory_source", skipTools: true } },
  { id: 18, group: "email", prompt: "Find the latest email about Coal Search", expect: { action: "knowledge" } },
  { id: 19, group: "email", prompt: "Summarise that email", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 20, group: "email", prompt: "Draft a reply", memory: coalDoc, expect: { action: "draft", skipTools: true } },
  { id: 21, group: "microsoft", prompt: "Search SharePoint for Coal Search", expect: { action: "knowledge" } },
  { id: 22, group: "microsoft", prompt: "Find files about Arnold Crescent", expect: { action: "knowledge" } },
  { id: 23, group: "microsoft", prompt: "What does our policy say about quoting?", expect: { action: "guidance" } },
  { id: 24, group: "xero", prompt: "What were sales this month?", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_sales_summary" } },
  { id: 25, group: "xero", prompt: "What about last month?", connectors: ["conn_xero"], memory: { lastDateRange: { label: "this_month" } }, expect: { action: "xero" } },
  { id: 26, group: "xero", prompt: "Who owes us money?", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_list_overdue_invoices" } },
  { id: 27, group: "xero", prompt: "Show overdue invoices", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 28, group: "xero", prompt: "Find invoice INV-1001", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_get_invoice" } },
  { id: 29, group: "operations", prompt: "What jobs are due today?", expect: { action: "knowledge" } },
  { id: 30, group: "operations", prompt: "Which engineers are busy?", expect: { action: "knowledge" } },
  { id: 31, group: "operations", prompt: "Find operational guidance for boilers", expect: { action: "guidance" } },
  { id: 32, group: "quoting", prompt: "Help me price this boiler job", expect: { action: "price" } },
  { id: 33, group: "quoting", prompt: "Find historical pricing", expect: { action: "price" } },
  { id: 34, group: "quoting", prompt: "Draft a quote summary", memory: coalDoc, expect: { action: "draft" } },
  { id: 35, group: "drafting", prompt: "Write a customer reply", memory: coalDoc, expect: { action: "draft" } },
  { id: 36, group: "drafting", prompt: "Turn this into a method statement", memory: coalDoc, expect: { action: "draft" } },
  { id: 37, group: "drafting", prompt: "Rewrite this professionally", memory: coalDoc, expect: { action: "draft" } },
  { id: 38, group: "ambiguity", prompt: "Find the invoice", expect: { action: "clarify", skipTools: true } },
  { id: 39, group: "ambiguity", prompt: "Show me that document", expect: { action: "clarify", skipTools: true } },
  { id: 40, group: "ambiguity", prompt: "Which one was first?", expect: { action: "clarify", skipTools: true } },
  { id: 41, group: "permissions", prompt: "Show me the other company's Xero invoices", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 42, group: "permissions", prompt: "Access tenant_other sales", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 43, group: "errors", prompt: "Search BigChange jobs due today", expect: { action: "knowledge" } },
  { id: 44, group: "errors", prompt: "Find asdfqwer zxcv", expect: { action: "knowledge" } },
  { id: 45, group: "errors", prompt: "Find a document that does not exist xyz", expect: { action: "knowledge" } },
  { id: 46, group: "actions", prompt: "Send that invoice", expect: { action: "write_blocked", noWrite: true } },
  { id: 47, group: "actions", prompt: "Create a quote", expect: { action: "write_blocked", noWrite: true } },
  { id: 48, group: "actions", prompt: "Approve that action", expect: { action: "write_blocked", noWrite: true } },
  { id: 49, group: "context", prompt: "Compare this month with last month", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 50, group: "context", prompt: "Now summarise the difference", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 51, group: "conversation", prompt: "Can you help me?", expect: { action: "capabilities", skipTools: true } },
  { id: 52, group: "document", prompt: "find coal search", expect: { action: "knowledge" } },
];

export function evaluateWhatsAppUatCase(testCase: WhatsAppUatCase): {
  id: number;
  pass: boolean;
  plan: WhatsAppPlan;
  failures: string[];
} {
  const plan = planWhatsAppTurn({
    text: testCase.prompt,
    memory: testCase.memory ?? emptyEntityMemory(),
    connectors: testCase.connectors ?? ["conn_microsoft_365", "conn_xero"],
  });
  const failures: string[] = [];
  if (testCase.expect.action && plan.action !== testCase.expect.action) {
    failures.push(`action ${plan.action} != ${testCase.expect.action}`);
  }
  if (testCase.expect.skipTools != null && plan.skipTools !== testCase.expect.skipTools) {
    failures.push(`skipTools ${plan.skipTools} != ${testCase.expect.skipTools}`);
  }
  if (testCase.expect.tool && plan.tool !== testCase.expect.tool) {
    failures.push(`tool ${plan.tool} != ${testCase.expect.tool}`);
  }
  if (testCase.expect.noWrite && plan.action !== "write_blocked") {
    failures.push("write was not blocked");
  }
  return { id: testCase.id, pass: failures.length === 0, plan, failures };
}

export function evaluateWhatsAppUatSuite(): {
  total: number;
  passed: number;
  failed: Array<{ id: number; prompt: string; failures: string[] }>;
} {
  const results = WHATSAPP_BRAIN_UAT_CASES.map((testCase) => ({
    testCase,
    result: evaluateWhatsAppUatCase(testCase),
  }));
  return {
    total: results.length,
    passed: results.filter((row) => row.result.pass).length,
    failed: results
      .filter((row) => !row.result.pass)
      .map((row) => ({ id: row.testCase.id, prompt: row.testCase.prompt, failures: row.result.failures })),
  };
}

export function assertNoRawDump(reply: string): boolean {
  return !looksLikeRawToolDump(reply);
}
