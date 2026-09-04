import { familiesOf, toolFamilyOf } from "../catalogue.js";
import { evaluateOpenAiShadow } from "../shadow-eval.js";
import { runIntelligenceTurn } from "../orchestrator.js";
import { buildConversationState } from "../state.js";
import { policyCompleter } from "./harness.js";
import type { IntelligenceEnv, IntelligenceRuntime, IntelligenceToolResult, ShadowEvalRecord } from "../types.js";
import type { IntelligenceToolFamily } from "../types.js";

export type ExactToolFamily = IntelligenceToolFamily | "mixed";

export type ExactToolCase = {
  id: string;
  family: ExactToolFamily;
  text: string;
  required: boolean;
  expectedFamilies: IntelligenceToolFamily[];
  withEmailEvidence?: boolean;
  withXeroEvidence?: boolean;
};

const EMAIL_EVIDENCE = {
  recentEmail: {
    id: "msg_1",
    subject: "Leak detection quote",
    from: "ops@example.com",
    receivedDateTime: "2026-09-04T09:00:00Z",
    mailboxAddress: "info@example.com",
    body: "Please confirm availability for a leak survey next Tuesday.",
    toolName: "outlook_list_messages",
  },
};

const XERO_EVIDENCE = {
  recentXero: {
    toolName: "xero_sales_summary",
    total: 5094,
    count: 32,
    fromDate: "2026-09-01",
    toDate: "2026-09-04",
    currency: "GBP",
    summary: "Sales this month £5,094 across 32 invoices.",
    label: "this month",
  },
};

export const EXACT_TOOL_CASES: ExactToolCase[] = [
  { id: "outlook_latest_inbox", family: "outlook", text: "What is the latest email in the info inbox?", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_newest_shared", family: "outlook", text: "What is the newest shared mailbox email?", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_last_five", family: "outlook", text: "Show the last 5 emails", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_unread", family: "outlook", text: "Any unread mail in the mailbox?", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_arrived_today", family: "outlook", text: "What arrived today in the inbox?", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_from_person", family: "outlook", text: "Search emails from a named colleague", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_search_po", family: "outlook", text: "Search the inbox for a purchase order", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_containing", family: "outlook", text: "Emails containing a quote", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_topic", family: "outlook", text: "Look in Outlook for a leak", required: true, expectedFamilies: ["outlook"] },
  { id: "outlook_about", family: "outlook", text: "Search emails about a survey", required: true, expectedFamilies: ["outlook"] },

  { id: "xero_sales_month", family: "xero", text: "What are our Xero sales this month?", required: true, expectedFamilies: ["xero"] },
  { id: "xero_revenue_week", family: "xero", text: "How much revenue this week?", required: true, expectedFamilies: ["xero"] },
  { id: "xero_sales_7d", family: "xero", text: "Sales last 7 days", required: true, expectedFamilies: ["xero"] },
  { id: "xero_summary", family: "xero", text: "Xero sales summary please", required: true, expectedFamilies: ["xero"] },
  { id: "xero_overdue", family: "xero", text: "Show overdue invoices", required: true, expectedFamilies: ["xero"] },
  { id: "xero_owes", family: "xero", text: "Who owes us money?", required: true, expectedFamilies: ["xero"] },
  { id: "xero_top", family: "xero", text: "Who are the top customers?", required: true, expectedFamilies: ["xero"] },
  { id: "xero_biggest", family: "xero", text: "Biggest customer this quarter", required: true, expectedFamilies: ["xero"] },
  { id: "xero_pnl", family: "xero", text: "Profit and loss this month", required: true, expectedFamilies: ["xero"] },
  { id: "xero_invoice", family: "xero", text: "Find invoice INV-02268", required: true, expectedFamilies: ["xero"] },

  { id: "knowledge_po", family: "knowledge", text: "What is the PO process?", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_vehicle", family: "knowledge", text: "Find the vehicle policy", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_vans", family: "knowledge", text: "Search company knowledge for vans", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_fuel", family: "knowledge", text: "What does the vehicle policy say about fuel?", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_hs", family: "knowledge", text: "Find a PDF about health and safety", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_onboarding", family: "knowledge", text: "Company knowledge about onboarding", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_leak", family: "knowledge", text: "Search for leak procedure", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_survey", family: "knowledge", text: "Find the site survey", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_other", family: "knowledge", text: "Search other documents", required: true, expectedFamilies: ["knowledge"] },
  { id: "knowledge_profile", family: "knowledge", text: "What is in the staff profile?", required: true, expectedFamilies: ["knowledge"] },

  { id: "catalogue_newest", family: "catalogue", text: "Newest document", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_sharepoint", family: "catalogue", text: "Latest SharePoint files", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_ten", family: "catalogue", text: "List the newest ten files", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_changed", family: "catalogue", text: "Documents changed this week", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_onedrive", family: "catalogue", text: "Show recent OneDrive files", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_uploaded", family: "catalogue", text: "What documents were uploaded recently?", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_count", family: "catalogue", text: "How many files are indexed?", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_connected", family: "catalogue", text: "What systems are connected?", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_sync", family: "catalogue", text: "When did files last sync?", required: true, expectedFamilies: ["catalogue"] },
  { id: "catalogue_caps", family: "catalogue", text: "What can you do?", required: true, expectedFamilies: ["catalogue"] },

  { id: "mixed_sales_and_inbox", family: "mixed", text: "What are sales this month and what is the newest info email?", required: true, expectedFamilies: ["xero", "outlook"] },
  { id: "mixed_meant_email", family: "mixed", text: "I meant the email", required: true, expectedFamilies: ["outlook"], withEmailEvidence: false },
  { id: "mixed_meant_xero", family: "mixed", text: "No I meant Xero sales", required: true, expectedFamilies: ["xero"] },
  { id: "mixed_wrong_file", family: "mixed", text: "wrong file, find the vehicle policy", required: true, expectedFamilies: ["knowledge"] },
  { id: "mixed_now_overdue", family: "mixed", text: "and now overdue invoices", required: true, expectedFamilies: ["xero"] },
  { id: "mixed_meant_inbox", family: "mixed", text: "I meant the info inbox", required: true, expectedFamilies: ["outlook"] },
  { id: "mixed_shorter", family: "mixed", text: "make that shorter", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "mixed_professional", family: "mixed", text: "Give a professional reply", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "mixed_explain", family: "mixed", text: "Explain that simply", required: false, expectedFamilies: [], withXeroEvidence: true },
  { id: "mixed_arithmetic", family: "mixed", text: "What is 2+2?", required: false, expectedFamilies: [] },
];

export function exactToolCases(): ExactToolCase[] {
  return EXACT_TOOL_CASES;
}

function benchRuntime(): IntelligenceRuntime {
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      if (call.name.startsWith("outlook_")) {
        return {
          name: call.name,
          ok: true,
          latencyMs: 4,
          data: {
            mailboxAddress: "info@example.com",
            messages: [{ id: "msg_1", subject: "Leak detection quote", from: "ops@example.com", receivedDateTime: "2026-09-04T09:00:00Z" }],
          },
        };
      }
      if (call.name.startsWith("xero_")) {
        return { name: call.name, ok: true, latencyMs: 4, data: { sales_total: 5094, invoice_count: 32 } };
      }
      if (call.name === "list_documents" || call.name.startsWith("get_")) {
        return { name: call.name, ok: true, latencyMs: 3, data: { totalIndexed: 12, connected: ["Xero", "Email"] } };
      }
      return { name: call.name, ok: true, latencyMs: 3, data: { results: [{ id: "doc_1", title: "Vehicle use policy" }] } };
    },
  };
}

export type ExactToolRow = {
  id: string;
  family: ExactToolFamily;
  required: boolean;
  expectedFamilies: IntelligenceToolFamily[];
  actualFamilies: IntelligenceToolFamily[];
  tools: string[];
  requiredOk: boolean;
  familyOk: boolean;
  inboxNoTool: boolean;
  xeroNoTool: boolean;
  knowledgeToXero: boolean;
  emailToXero: boolean;
  shadow?: ShadowEvalRecord;
};

export function scoreExactToolRow(input: {
  testCase: ExactToolCase;
  tools: string[];
}): ExactToolRow {
  const actualFamilies = familiesOf(input.tools);
  const requiredOk = input.testCase.required ? input.tools.length > 0 : input.tools.length === 0;
  const familyOk =
    input.testCase.expectedFamilies.length === 0
      ? actualFamilies.length === 0
      : input.testCase.expectedFamilies.every((family) => actualFamilies.includes(family));
  return {
    id: input.testCase.id,
    family: input.testCase.family,
    required: input.testCase.required,
    expectedFamilies: input.testCase.expectedFamilies,
    actualFamilies,
    tools: input.tools,
    requiredOk,
    familyOk,
    inboxNoTool: input.testCase.family === "outlook" && input.testCase.required && input.tools.length === 0,
    xeroNoTool: input.testCase.family === "xero" && input.testCase.required && input.tools.length === 0,
    knowledgeToXero: input.testCase.family === "knowledge" && actualFamilies.includes("xero"),
    emailToXero: input.testCase.family === "outlook" && actualFamilies.includes("xero"),
  };
}

export function summariseExactToolRows(rows: ExactToolRow[]): {
  cases: number;
  familyAgreement: number;
  requiredAgreement: number;
  overall: number;
  inboxNoTool: number;
  xeroNoTool: number;
  knowledgeToXero: number;
  emailToXero: number;
  byFamily: Record<string, number>;
} {
  const n = rows.length || 1;
  const familyHits = rows.filter((row) => row.familyOk).length;
  const requiredHits = rows.filter((row) => row.requiredOk).length;
  const byFamily: Record<string, number> = {};
  for (const family of ["outlook", "xero", "knowledge", "catalogue", "mixed"]) {
    const slice = rows.filter((row) => row.family === family);
    byFamily[family] = slice.length ? Math.round((slice.filter((row) => row.familyOk && row.requiredOk).length / slice.length) * 1000) / 10 : 0;
  }
  return {
    cases: rows.length,
    familyAgreement: Math.round((familyHits / n) * 1000) / 10,
    requiredAgreement: Math.round((requiredHits / n) * 1000) / 10,
    overall: Math.round(((familyHits + requiredHits) / (2 * n)) * 1000) / 10,
    inboxNoTool: rows.filter((row) => row.inboxNoTool).length,
    xeroNoTool: rows.filter((row) => row.xeroNoTool).length,
    knowledgeToXero: rows.filter((row) => row.knowledgeToXero).length,
    emailToXero: rows.filter((row) => row.emailToXero).length,
    byFamily,
  };
}

export async function scoreExactToolChoiceLocal(): Promise<{
  source: "MOCK";
  scorecard: ReturnType<typeof summariseExactToolRows>;
  rows: ExactToolRow[];
}> {
  const runtime = benchRuntime();
  const completer = policyCompleter();
  const rows: ExactToolRow[] = [];
  for (const testCase of EXACT_TOOL_CASES) {
    const state = stateFor(testCase);
    const result = await runIntelligenceTurn({ text: testCase.text, state, runtime, completer });
    rows.push(scoreExactToolRow({ testCase, tools: result.toolCalls.map((call) => call.name) }));
  }
  return { source: "MOCK", scorecard: summariseExactToolRows(rows), rows };
}

export async function scoreExactToolChoiceShadow(
  env: IntelligenceEnv,
): Promise<{
  source: "LIVE_API";
  userVisible: "cloudflare";
  scorecard: ReturnType<typeof summariseExactToolRows>;
  rows: ExactToolRow[];
}> {
  const runtime = benchRuntime();
  const completer = policyCompleter();
  const rows: ExactToolRow[] = [];
  for (const testCase of EXACT_TOOL_CASES) {
    const state = stateFor(testCase);
    const live = await runIntelligenceTurn({ text: testCase.text, state, runtime, completer });
    const shadow = await evaluateOpenAiShadow({ env, text: testCase.text, state, live });
    rows.push({ ...scoreExactToolRow({ testCase, tools: shadow.toolProposal }), shadow });
  }
  return { source: "LIVE_API", userVisible: "cloudflare", scorecard: summariseExactToolRows(rows), rows };
}

function stateFor(testCase: ExactToolCase) {
  return buildConversationState({
    userText: testCase.text,
    companyId: "co_el",
    connectors: ["conn_xero", "conn_outlook_shared"],
    lastAnswerTopic: testCase.withEmailEvidence ? "email" : testCase.withXeroEvidence ? "finance" : null,
    lastAnswerText: testCase.withEmailEvidence
      ? "Suggested reply:\nHi Ops,\nThanks for your email about leak detection.\nKind regards"
      : testCase.withXeroEvidence
        ? "Sales this month are £5,094 across 32 invoices."
        : null,
    recentEvidence: {
      ...(testCase.withEmailEvidence ? EMAIL_EVIDENCE : {}),
      ...(testCase.withXeroEvidence ? XERO_EVIDENCE : {}),
    },
  });
}

export function unusedFamily(name: string): IntelligenceToolFamily {
  return toolFamilyOf(name);
}
