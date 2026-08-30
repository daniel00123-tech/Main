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
    useMemory?: boolean;
    noWrite?: boolean;
    mustRespond?: boolean;
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

const arnold = {
  id: "doc_arnold",
  title: "Arnold Crescent.pdf",
  url: "https://contoso.sharepoint.com/docs/ArnoldCrescent.pdf",
  excerpt: "Rental information for Arnold Crescent",
  amount: null,
  reference: null,
  sourceLabel: "Arnold Crescent.pdf",
};

const twoDocs: WhatsAppEntityMemory = {
  ...coalDoc,
  recentDocuments: [coalDoc.lastDocument, arnold],
};

export const WHATSAPP_BRAIN_UAT_CASES: WhatsAppUatCase[] = [
  { id: 1, group: "conversation", prompt: "Hi", expect: { action: "chat", skipTools: true, mustRespond: true } },
  { id: 2, group: "conversation", prompt: "Hello", expect: { action: "chat", skipTools: true } },
  { id: 3, group: "conversation", prompt: "Morning", expect: { action: "chat", skipTools: true } },
  { id: 4, group: "conversation", prompt: "How are you?", expect: { action: "chat", skipTools: true } },
  { id: 5, group: "conversation", prompt: "Thanks", expect: { action: "chat", skipTools: true } },
  { id: 6, group: "conversation", prompt: "Who are you?", expect: { action: "capabilities", skipTools: true } },
  { id: 7, group: "conversation", prompt: "What can you do?", expect: { action: "capabilities", skipTools: true } },
  { id: 8, group: "conversation", prompt: "Help", expect: { action: "capabilities", skipTools: true } },
  { id: 9, group: "document", prompt: "Find Coal Search", expect: { action: "knowledge", tool: "search_company_knowledge" } },
  { id: 10, group: "document", prompt: "Find cold serch", expect: { action: "knowledge" } },
  { id: 11, group: "document", prompt: "What is Coal Search about?", expect: { action: "knowledge" } },
  { id: 12, group: "follow-up", prompt: "Summarise it", memory: coalDoc, expect: { action: "memory_fact", skipTools: false } },
  { id: 13, group: "follow-up", prompt: "Give me more detail", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 14, group: "follow-up", prompt: "What was the amount?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 15, group: "follow-up", prompt: "What was the reference?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 16, group: "follow-up", prompt: "Who is it from?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 17, group: "follow-up", prompt: "Send me the link", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 18, group: "follow-up", prompt: "Can I download it?", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  {
    id: 19,
    group: "follow-up",
    prompt: "Where did you find that?",
    memory: coalDoc,
    expect: { action: "memory_source", skipTools: true },
  },
  { id: 20, group: "document", prompt: "Find Arnold Crescent", expect: { action: "knowledge" } },
  { id: 21, group: "document", prompt: "Summarise Arnold Crescent", expect: { action: "knowledge" } },
  { id: 22, group: "document", prompt: "Compare those two documents", memory: twoDocs, expect: { action: "knowledge" } },
  { id: 23, group: "document", prompt: "Find another document like it", memory: coalDoc, expect: { action: "knowledge", useMemory: true } },
  { id: 24, group: "source", prompt: "Open the document", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 25, group: "source", prompt: "Give me the URL", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 26, group: "source", prompt: "Where is this stored?", memory: coalDoc, expect: { action: "memory_source", skipTools: true } },
  { id: 27, group: "source", prompt: "Is it in SharePoint?", memory: coalDoc, expect: { action: "memory_source", skipTools: true } },
  { id: 28, group: "email", prompt: "Find the latest email about Coal Search", expect: { action: "knowledge" } },
  { id: 29, group: "email", prompt: "Who sent it?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 30, group: "email", prompt: "What did they ask for?", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 31, group: "email", prompt: "Summarise the email", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 32, group: "email", prompt: "Draft a reply", memory: coalDoc, expect: { action: "draft", skipTools: true } },
  { id: 33, group: "email", prompt: "Make that reply shorter", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 34, group: "email", prompt: "Make it more professional", memory: coalDoc, expect: { action: "draft" } },
  { id: 35, group: "xero", prompt: "What were sales this month?", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_sales_summary" } },
  {
    id: 36,
    group: "xero",
    prompt: "What about last month?",
    connectors: ["conn_xero"],
    memory: { lastDateRange: { label: "this_month" } },
    expect: { action: "xero" },
  },
  {
    id: 37,
    group: "xero",
    prompt: "Compare them",
    connectors: ["conn_xero"],
    memory: { lastDateRange: { label: "this_month" } },
    expect: { action: "xero" },
  },
  { id: 38, group: "xero", prompt: "Who owes us money?", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_list_overdue_invoices" } },
  { id: 39, group: "xero", prompt: "Find overdue invoices", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 40, group: "xero", prompt: "Find invoice INV-003", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_get_invoice" } },
  { id: 41, group: "xero", prompt: "Who is our biggest customer?", connectors: ["conn_xero"], expect: { action: "xero", tool: "xero_search_contacts" } },
  { id: 42, group: "xero", prompt: "What did Elvex spend?", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 43, group: "operations", prompt: "What jobs are due today?", expect: { action: "knowledge" } },
  { id: 44, group: "operations", prompt: "Which engineers are working?", expect: { action: "knowledge" } },
  { id: 45, group: "operations", prompt: "What operational information can you find?", expect: { action: "knowledge" } },
  { id: 46, group: "operations", prompt: "Find instructions for boilers", expect: { action: "guidance" } },
  { id: 47, group: "quoting", prompt: "Help me price a boiler job", expect: { action: "price" } },
  { id: 48, group: "quoting", prompt: "Find pricing information", expect: { action: "price" } },
  { id: 49, group: "quoting", prompt: "Find a similar historic job", expect: { action: "knowledge" } },
  { id: 50, group: "quoting", prompt: "Draft a quote summary", memory: coalDoc, expect: { action: "draft" } },
  { id: 51, group: "quoting", prompt: "What assumptions did you use?", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 52, group: "drafting", prompt: "Write an email from this", memory: coalDoc, expect: { action: "draft" } },
  { id: 53, group: "drafting", prompt: "Draft a customer update", memory: coalDoc, expect: { action: "draft" } },
  { id: 54, group: "drafting", prompt: "Create a method statement draft", memory: coalDoc, expect: { action: "draft" } },
  { id: 55, group: "drafting", prompt: "Rewrite this more professionally", memory: coalDoc, expect: { action: "draft" } },
  { id: 56, group: "ambiguity", prompt: "Summarise that", memory: coalDoc, expect: { action: "memory_fact" } },
  { id: 57, group: "ambiguity", prompt: "What about the other one?", memory: twoDocs, expect: { action: "clarify", skipTools: true } },
  { id: 58, group: "ambiguity", prompt: "Show me the second document", memory: twoDocs, expect: { action: "clarify", skipTools: true } },
  { id: 59, group: "ambiguity", prompt: "Send me that link", memory: coalDoc, expect: { action: "memory_link", skipTools: true } },
  { id: 60, group: "ambiguity", prompt: "What was the figure again?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 61, group: "clarifications", prompt: "Find the invoice", expect: { action: "clarify", skipTools: true } },
  { id: 62, group: "clarifications", prompt: "Find the document", expect: { action: "clarify", skipTools: true } },
  { id: 63, group: "clarifications", prompt: "Show me that one", expect: { action: "clarify", skipTools: true } },
  { id: 64, group: "permissions", prompt: "Show me the other company's Xero invoices", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 65, group: "permissions", prompt: "Access tenant_other sales", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 66, group: "errors", prompt: "Search BigChange jobs due today", expect: { action: "knowledge" } },
  { id: 67, group: "errors", prompt: "Find a document that does not exist xyz", expect: { action: "knowledge" } },
  { id: 68, group: "errors", prompt: "asdfqwer zxcv qwerty", expect: { action: "knowledge" } },
  { id: 69, group: "actions", prompt: "Send that invoice", expect: { action: "write_blocked", noWrite: true } },
  { id: 70, group: "actions", prompt: "Create a quote", expect: { action: "write_blocked", noWrite: true } },
  { id: 71, group: "actions", prompt: "Approve it", expect: { action: "write_blocked", noWrite: true } },
  { id: 72, group: "natural", prompt: "I don’t understand", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 73, group: "natural", prompt: "Explain that simply", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 74, group: "natural", prompt: "Can you make that shorter?", memory: coalDoc, expect: { action: "memory_fact", skipTools: true } },
  { id: 75, group: "natural", prompt: "Tell me more", memory: coalDoc, expect: { action: "memory_fact" } },
  {
    id: 76,
    group: "incident",
    prompt: "what is the url where i can download it from as i need a copy of it?",
    memory: coalDoc,
    expect: { action: "memory_link", skipTools: true, mustRespond: true },
  },
  {
    id: 77,
    group: "incident",
    prompt: "what is the url where i can download it from as i need a copy of it?",
    expect: { action: "clarify", skipTools: true, mustRespond: true },
  },
  { id: 78, group: "conversation", prompt: "Can you help me?", expect: { action: "capabilities", skipTools: true } },
  { id: 79, group: "context", prompt: "Compare this month with last month", connectors: ["conn_xero"], expect: { action: "xero" } },
  { id: 80, group: "microsoft", prompt: "Search SharePoint for Coal Search", expect: { action: "knowledge" } },
];

export function evaluateWhatsAppUatCase(testCase: WhatsAppUatCase): {
  id: number;
  pass: boolean;
  plan: WhatsAppPlan;
  failures: string[];
  scores: {
    responseReceived: boolean;
    acknowledgementWhenNeeded: boolean;
    intentUnderstood: boolean;
    rightTool: boolean;
    contextPreserved: boolean;
    permissionSafe: boolean;
  };
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
  if (testCase.expect.useMemory != null && plan.useMemory !== testCase.expect.useMemory) {
    failures.push(`useMemory ${plan.useMemory} != ${testCase.expect.useMemory}`);
  }
  if (testCase.expect.noWrite && plan.action !== "write_blocked") {
    failures.push("write was not blocked");
  }
  if (testCase.expect.mustRespond && plan.action === "knowledge" && /url|download|copy of it/i.test(testCase.prompt)) {
    failures.push("source-link ask must not fall through to a silent MCP search");
  }
  const silentPath = false;
  return {
    id: testCase.id,
    pass: failures.length === 0 && !silentPath,
    plan,
    failures,
    scores: {
      responseReceived: plan.action !== undefined,
      acknowledgementWhenNeeded: plan.skipTools || plan.action === "knowledge" || plan.action === "xero",
      intentUnderstood: !testCase.expect.action || plan.action === testCase.expect.action,
      rightTool: !testCase.expect.tool || plan.tool === testCase.expect.tool,
      contextPreserved: !testCase.memory || plan.useMemory || plan.action === "clarify" || plan.action === "xero" || plan.action === "write_blocked",
      permissionSafe: plan.action !== "write_blocked" || Boolean(testCase.expect.noWrite),
    },
  };
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
