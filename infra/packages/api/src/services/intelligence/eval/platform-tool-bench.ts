import { exactToolCases, scoreExactToolChoiceLocal, type ExactToolCase } from "./exact-tool-bench.js";

const EXTRA_OUTLOOK: ExactToolCase[] = [
  "Show newest emails in the shared mailbox",
  "Latest unread messages in the inbox",
  "What is the most recent office mailbox email?",
  "List recent mailbox messages",
  "Any new mail in the info inbox?",
  "Search the mailbox from a supplier",
  "Find emails with the subject quote",
  "Look in the inbox for an invoice PDF",
  "Search Outlook for last Tuesday",
  "Emails about a leak survey",
].map((text, i) => ({
  id: `plat_outlook_${i + 1}`,
  family: "outlook" as const,
  text,
  required: true,
  expectedFamilies: ["outlook" as const],
}));

const EXTRA_XERO: ExactToolCase[] = [
  "Revenue this month in the accounting system",
  "Sales today please",
  "How much have we invoiced this week?",
  "Give me a live sales total",
  "Which invoices are overdue?",
  "Unpaid late invoices",
  "Top customers this month",
  "Highest-value customer this quarter",
  "Profit and loss last month",
  "Open invoice INV-10001",
].map((text, i) => ({
  id: `plat_xero_${i + 1}`,
  family: "xero" as const,
  text,
  required: true,
  expectedFamilies: ["xero" as const],
}));

const EXTRA_KNOWLEDGE: ExactToolCase[] = [
  "What is the purchase order process?",
  "Find the vehicle use policy",
  "Search company knowledge for breakdowns",
  "How do we handle fuel cards?",
  "Find a health and safety PDF",
  "Company knowledge for new starters",
  "Search for the leak procedure",
  "Find the site survey document",
  "Search other company files",
  "What does the staff handbook say?",
].map((text, i) => ({
  id: `plat_knowledge_${i + 1}`,
  family: "knowledge" as const,
  text,
  required: true,
  expectedFamilies: ["knowledge" as const],
}));

const EXTRA_CATALOGUE: ExactToolCase[] = [
  "What is the newest file?",
  "Latest OneDrive documents",
  "Show files changed today",
  "Recently uploaded documents",
  "How many documents are indexed?",
].map((text, i) => ({
  id: `plat_catalogue_${i + 1}`,
  family: "catalogue" as const,
  text,
  required: true,
  expectedFamilies: ["catalogue" as const],
}));

const EVIDENCE: ExactToolCase[] = [
  { id: "plat_ev_1", family: "mixed", text: "who sent it?", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "plat_ev_2", family: "mixed", text: "draft a reply", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "plat_ev_3", family: "mixed", text: "what was the subject?", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "plat_ev_4", family: "mixed", text: "make that friendlier", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "plat_ev_5", family: "mixed", text: "give me a management summary", required: false, expectedFamilies: [], withXeroEvidence: true },
  { id: "plat_ev_6", family: "mixed", text: "explain those figures simply", required: false, expectedFamilies: [], withXeroEvidence: true },
  { id: "plat_ev_7", family: "mixed", text: "what were the sales again?", required: false, expectedFamilies: [], withXeroEvidence: true },
  { id: "plat_ev_8", family: "mixed", text: "remind me what we were talking about", required: false, expectedFamilies: [], withEmailEvidence: true },
  { id: "plat_ev_9", family: "mixed", text: "shorter please", required: false, expectedFamilies: [], withXeroEvidence: true },
  { id: "plat_ev_10", family: "mixed", text: "what should we reply?", required: false, expectedFamilies: [], withEmailEvidence: true },
];

const GENERAL: ExactToolCase[] = [
  { id: "plat_gen_1", family: "mixed", text: "Hi", required: false, expectedFamilies: [] },
  { id: "plat_gen_2", family: "mixed", text: "Thanks", required: false, expectedFamilies: [] },
  { id: "plat_gen_3", family: "mixed", text: "What is 2+2?", required: false, expectedFamilies: [] },
  { id: "plat_gen_4", family: "mixed", text: "Hello there", required: false, expectedFamilies: [] },
  { id: "plat_gen_5", family: "mixed", text: "Cheers", required: false, expectedFamilies: [] },
];

export function platformToolCases(): ExactToolCase[] {
  return [...exactToolCases(), ...EXTRA_OUTLOOK, ...EXTRA_XERO, ...EXTRA_KNOWLEDGE, ...EXTRA_CATALOGUE, ...EVIDENCE, ...GENERAL];
}

export async function scorePlatformToolBenchLocal() {
  const { scoreExactToolChoiceLocal } = await import("./exact-tool-bench.js");
  void scoreExactToolChoiceLocal;
  const { runIntelligenceTurn } = await import("../orchestrator.js");
  const { buildConversationState } = await import("../state.js");
  const { policyCompleter } = await import("./harness.js");
  const { scoreExactToolRow, summariseExactToolRows } = await import("./exact-tool-bench.js");
  const runtime = {
    async executeTool(call: { name: string }) {
      if (call.name.startsWith("outlook_")) {
        return {
          name: call.name,
          ok: true,
          latencyMs: 3,
          data: { mailboxAddress: "info@example.com", messages: [{ subject: "Quote", from: "ops@example.com" }] },
        };
      }
      if (call.name.startsWith("xero_")) {
        return { name: call.name, ok: true, latencyMs: 3, data: { sales_total: 100, invoice_count: 2 } };
      }
      if (call.name === "list_documents" || call.name.startsWith("get_")) {
        return { name: call.name, ok: true, latencyMs: 3, data: { documents: [{ id: "d1", title: "File" }], totalIndexed: 4 } };
      }
      return { name: call.name, ok: true, latencyMs: 3, data: { results: [{ id: "k1", title: "Policy" }] } };
    },
  };
  const completer = policyCompleter();
  const rows = [];
  for (const testCase of platformToolCases()) {
    const state = buildConversationState({
      userText: testCase.text,
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      lastAnswerTopic: testCase.withEmailEvidence ? "email" : testCase.withXeroEvidence ? "finance" : null,
      lastAnswerText: testCase.withEmailEvidence
        ? "Suggested reply about the leak survey."
        : testCase.withXeroEvidence
          ? "Sales this month are £5,094 across 32 invoices."
          : null,
      recentEvidence: {
        companyId: "co_el",
        ...(testCase.withEmailEvidence
          ? {
              recentEmail: {
                id: "msg_1",
                subject: "Leak detection quote",
                from: "ops@example.com",
                receivedDateTime: "2026-09-04T09:00:00Z",
                mailboxAddress: "info@example.com",
                body: "Please confirm availability.",
                toolName: "outlook_list_messages",
              },
            }
          : {}),
        ...(testCase.withXeroEvidence
          ? {
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
            }
          : {}),
      },
    });
    const result = await runIntelligenceTurn({ text: testCase.text, state, runtime, completer });
    rows.push(scoreExactToolRow({ testCase, tools: result.toolCalls.map((call) => call.name) }));
  }
  return { cases: platformToolCases(), scorecard: summariseExactToolRows(rows), rows };
}
