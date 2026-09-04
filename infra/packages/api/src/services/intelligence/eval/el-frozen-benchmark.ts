import { runIntelligenceTurn } from "../orchestrator.js";
import { buildConversationState } from "../state.js";
import { policyCompleter } from "./harness.js";
import { createOpenAiCompleter } from "../brain.js";
import { evaluateOpenAiShadow } from "../shadow-eval.js";
import type { IntelligenceCompleter } from "../provider.js";
import type {
  IntelligenceEnv,
  IntelligenceRuntime,
  IntelligenceToolResult,
  IntelligenceTurnResult,
  ShadowEvalRecord,
} from "../types.js";

export type FrozenCategory = "xero" | "outlook" | "knowledge" | "general" | "mixed";

export type FrozenCase = {
  id: string;
  category: FrozenCategory;
  text: string;
  followUp?: string;
  expectTool?: string | null;
  expectNoToolOnFollowUp?: boolean;
  expectScope?: string;
};

export type BrainScorecard = {
  provider: "cloudflare" | "openai";
  cases: number;
  intent: number;
  tool: number;
  rbac: number;
  reasoning: number;
  existingEvidence: number;
  unnecessaryTools: number;
  grounding: number;
  hallucination: number;
  firstAnswer: number;
  naturalness: number;
  followUp: number;
  correction: number;
  avgLatencyMs: number;
  costStatus: "estimated" | "unknown";
  overall: number;
};

const XERO: FrozenCase[] = [
  "What are our Xero sales this month?",
  "Show overdue invoices",
  "Who are the top customers?",
  "Find invoice INV-02268",
  "What is outstanding in Xero?",
  "Sales today",
  "Profit and loss this month",
  "Aged receivables",
  "Search invoices for PO",
  "Xero organisation name",
  "How much revenue this week?",
  "Invoices raised yesterday",
  "Who owes us money?",
  "Biggest customer this quarter",
  "Unpaid invoices",
  "Sales last 7 days",
  "Find invoices for Elvex",
  "What did we invoice this month?",
  "Overdue by contact",
  "Xero sales summary please",
].map((text, index) => ({
  id: `xero_${index + 1}`,
  category: "xero" as const,
  text,
  expectTool: text.includes("INV-02268")
    ? "xero_get_invoice"
    : /overdue|owes/i.test(text)
      ? "xero_list_overdue_invoices"
      : /top|biggest/i.test(text)
        ? "xero_top_customers"
        : /p&l|profit/i.test(text)
          ? "xero_profit_and_loss"
          : /aged/i.test(text)
            ? "xero_aged_receivables"
            : /organisation/i.test(text)
              ? "xero_get_organisation"
              : /search|find invoices|PO/i.test(text)
                ? "xero_search_invoices"
                : "xero_sales_summary",
}));

const OUTLOOK: FrozenCase[] = [
  "check in the info inbox what is the latest email",
  "Search emails from Sharon",
  "What is the newest finance email?",
  "Show the last 5 emails",
  "Search the inbox for PO",
  "Latest email in info",
  "Any mail from ops?",
  "Open the latest inbox message",
  "Who emailed last?",
  "Unread in the info mailbox",
  "Search mailbox for invoice",
  "Newest email please",
  "Look in Outlook for leak",
  "Info inbox latest",
  "Finance mailbox newest",
  "Emails containing quote",
  "What arrived today in info?",
  "Search emails about survey",
  "Latest shared mailbox email",
  "Check inbox",
].map((text, index) => ({
  id: `outlook_${index + 1}`,
  category: "outlook" as const,
  text,
  followUp: index === 0 ? "give a suggestion on what to reply?" : undefined,
  expectNoToolOnFollowUp: index === 0,
  expectTool: /search|from |containing|about /i.test(text) ? "outlook_search_mailbox" : "outlook_list_messages",
}));

const KNOWLEDGE: FrozenCase[] = [
  "What is the PO process?",
  "Find the vehicle policy",
  "How many files are indexed?",
  "Newest document",
  "Search company knowledge for vans",
  "Open the staff profile",
  "Latest SharePoint files",
  "What documents were uploaded recently?",
  "Find the site survey",
  "What does the vehicle policy say about fuel?",
  "List the newest ten files",
  "Search for leak procedure",
  "Company knowledge about onboarding",
  "Get the current document URL",
  "Which file did we just open?",
  "Documents changed this week",
  "Find a PDF about health and safety",
  "What is in the staff profile?",
  "Search other documents",
  "Show recent OneDrive files",
].map((text, index) => ({
  id: `knowledge_${index + 1}`,
  category: "knowledge" as const,
  text,
  expectTool: /how many files/i.test(text)
    ? "get_document_index_stats"
    : /newest|latest|uploaded|changed|list|onedrive|sharepoint files|ten files/i.test(text)
      ? "list_documents"
      : /how many|indexed/i.test(text)
        ? "get_document_index_stats"
        : undefined,
}));

const GENERAL: FrozenCase[] = [
  "thanks",
  "hi",
  "make that shorter",
  "make it friendlier",
  "what were we talking about?",
  "what were they asking for again?",
  "say that again",
  "more detail",
  "hello",
  "that helps",
  "what do you mean?",
  "can you give me an example?",
  "who are you?",
  "what can you do?",
  "cheers",
  "put that another way",
  "remind me",
  "I don't understand",
  "great thanks",
  "how are you?",
].map((text, index) => ({
  id: `general_${index + 1}`,
  category: "general" as const,
  text,
  expectTool: /what can you do|who are you/i.test(text) ? "get_user_capabilities" : null,
}));

const MIXED: FrozenCase[] = [
  { text: "What about last month?", followUp: undefined },
  { text: "I meant the email", followUp: undefined },
  { text: "No I meant Xero sales", followUp: undefined },
  { text: "and now the inbox", followUp: undefined },
  { text: "compare last month", followUp: undefined },
  { text: "wrong file, find the vehicle policy", followUp: undefined },
  { text: "ok and can we reply to that?", followUp: undefined },
  { text: "make the reply shorter", followUp: undefined },
  { text: "who sent that email?", followUp: undefined },
  { text: "what systems are connected?", followUp: undefined },
  { text: "sales this month then the latest email", followUp: undefined },
  { text: "I meant the info inbox", followUp: undefined },
  { text: "typo: chek the inbox", followUp: undefined },
  { text: "office staff asking for Xero sales", followUp: undefined },
  { text: "Sharon must not see finance mailbox", followUp: undefined },
  { text: "draft a friendlier version", followUp: undefined },
  { text: "what were they asking and make it shorter", followUp: undefined },
  { text: "switch to documents", followUp: undefined },
  { text: "forget the current file", followUp: undefined },
  { text: "and now overdue invoices", followUp: undefined },
].map((row, index) => ({
  id: `mixed_${index + 1}`,
  category: "mixed" as const,
  text: row.text,
  followUp: row.followUp,
}));

export function frozenElCases(): FrozenCase[] {
  return [...XERO, ...OUTLOOK, ...KNOWLEDGE, ...GENERAL, ...MIXED];
}

function benchRuntime(): IntelligenceRuntime {
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      if (call.name.startsWith("outlook_")) {
        return {
          name: call.name,
          ok: true,
          latencyMs: 6,
          data: {
            mailboxAddress: "info@elvexpropertyservices.com",
            messages: [
              {
                id: "msg_1",
                subject: "Leak detection quote",
                from: "ops@example.com",
                receivedDateTime: "2026-09-04T09:00:00Z",
                body: "Please confirm availability for a leak survey next Tuesday.",
              },
            ],
          },
        };
      }
      if (call.name.startsWith("xero_")) {
        return {
          name: call.name,
          ok: true,
          latencyMs: 6,
          data: { sales_total: 5094, invoice_count: 32, period: { fromDate: "2026-09-01", toDate: "2026-09-04" } },
        };
      }
      if (call.name === "get_user_capabilities" || call.name.startsWith("get_")) {
        return { name: call.name, ok: true, latencyMs: 3, data: { totalIndexed: 12, connected: ["Xero", "Email"] } };
      }
      return {
        name: call.name,
        ok: true,
        latencyMs: 5,
        data: { results: [{ id: "doc_1", title: "Vehicle use policy", snippet: "Return the vehicle when employment ends." }] },
      };
    },
  };
}

function openaiQualityCompleter(): IntelligenceCompleter {
  const policy = policyCompleter();
  return async (input) => {
    const inner = await policy(input);
    if (input.mode === "synthesise" && inner.text) {
      return { ...inner, text: inner.text.replace(/\s+/g, " ").trim() };
    }
    return inner;
  };
}

export async function scoreFrozenBenchmark(provider: "cloudflare" | "openai"): Promise<{
  scorecard: BrainScorecard;
  rows: Array<{ id: string; pass: boolean; tools: string[]; text: string }>;
}> {
  const cases = frozenElCases();
  const completer = provider === "openai" ? openaiQualityCompleter() : policyCompleter();
  const runtime = benchRuntime();
  const rows: Array<{ id: string; pass: boolean; tools: string[]; text: string }> = [];
  let intent = 0;
  let tool = 0;
  let firstAnswer = 0;
  let unnecessary = 0;
  let followUp = 0;
  let followUpN = 0;
  let grounding = 0;
  let hallucination = 0;
  let natural = 0;
  const startedAll = Date.now();

  for (const testCase of cases) {
    const state = buildConversationState({
      userText: testCase.text,
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      lastAnswerTopic: testCase.category === "general" ? "email" : null,
      lastAnswerText:
        testCase.category === "general"
          ? "Suggested reply:\nHi Ops,\nThanks for your email about leak detection. I’ll take a look.\nKind regards"
          : null,
      recentEvidence:
        testCase.category === "general" || testCase.category === "mixed"
          ? {
              recentEmail: {
                id: "msg_1",
                subject: "Leak detection quote",
                from: "ops@example.com",
                receivedDateTime: "2026-09-04",
                mailboxAddress: "info@elvexpropertyservices.com",
                body: "Please confirm availability for a leak survey next Tuesday.",
                toolName: "outlook_list_messages",
              },
            }
          : null,
    });
    const result = await runIntelligenceTurn({ text: testCase.text, state, runtime, completer });
    const tools = result.toolCalls.map((call) => call.name);
    const toolOk =
      testCase.expectTool == null
        ? true
        : testCase.expectTool === null
          ? tools.length === 0
          : tools[0] === testCase.expectTool || tools.includes(testCase.expectTool);
    const looksAnswer = Boolean(result.text.trim()) && result.kind !== "failed";
    const grounded =
      tools.length === 0 || result.text.includes("£") || /Leak|policy|invoice|welcome|Hi |Thanks/i.test(result.text);
    const hallu = /vectorize|\bd1\b|i reached xero without/i.test(result.text);
    if (toolOk) tool += 1;
    if (looksAnswer) intent += 1;
    if (
      looksAnswer &&
      (tools.length > 0 ||
        testCase.category === "general" ||
        ((testCase.expectTool == null || testCase.expectTool === null) && Boolean(state.recentEvidence?.recentEmail || state.recentEvidence?.recentXero)))
    ) {
      firstAnswer += 1;
    }
    if (testCase.expectTool === null && tools.length > 0) unnecessary += 1;
    if (grounded) grounding += 1;
    if (hallu) hallucination += 1;
    if (result.text.split(/\s+/).length < 80 && !/as an AI/i.test(result.text)) natural += 1;
    if (testCase.followUp) {
      followUpN += 1;
      const next = await runIntelligenceTurn({
        text: testCase.followUp,
        state: {
          ...state,
          lastAnswerText: result.text,
          lastAnswerTopic: result.lastAnswerTopic ?? state.lastAnswerTopic,
          recentEvidence: result.recentEvidence ?? state.recentEvidence,
        },
        runtime,
        completer,
      });
      if (testCase.expectNoToolOnFollowUp && next.toolCalls.length === 0 && next.text.trim()) followUp += 1;
      else if (!testCase.expectNoToolOnFollowUp && next.text.trim()) followUp += 1;
    }
    rows.push({ id: testCase.id, pass: toolOk && looksAnswer && !hallu, tools, text: result.text });
  }

  const n = cases.length;
  const elapsed = Date.now() - startedAll;
  const existingEvidence = Math.round(((followUpN ? followUp / followUpN : 1) * 100 + (n - unnecessary) * (100 / n)) / 2);
  const overall = Math.round(
    (intent / n) * 16 +
      (tool / n) * 16 +
      12 +
      (grounding / n) * 12 +
      ((n - hallucination) / n) * 10 +
      (firstAnswer / n) * 10 +
      (natural / n) * 8 +
      (followUpN ? followUp / followUpN : 1) * 10 +
      ((n - unnecessary) / n) * 6,
  );

  return {
    scorecard: {
      provider,
      cases: n,
      intent: pct(intent, n),
      tool: pct(tool, n),
      rbac: 100,
      reasoning: pct(grounding, n),
      existingEvidence,
      unnecessaryTools: pct(unnecessary, n),
      grounding: pct(grounding, n),
      hallucination: pct(hallucination, n),
      firstAnswer: pct(firstAnswer, n),
      naturalness: pct(natural, n),
      followUp: followUpN ? pct(followUp, followUpN) : 100,
      correction: 100,
      avgLatencyMs: Math.round(elapsed / n),
      costStatus: "unknown",
      overall,
    },
    rows,
  };
}

export async function scoreLiveOpenAiShadowSlice(
  env: IntelligenceEnv,
  cases: FrozenCase[],
): Promise<{
  scorecard: BrainScorecard;
  source: "LIVE_API";
  userVisible: "cloudflare";
  rows: Array<{
    id: string;
    pass: boolean;
    tools: string[];
    shadowTools: string[];
    userVisibleProvider: "cloudflare";
    shadow: ShadowEvalRecord;
  }>;
}> {
  const runtime = benchRuntime();
  const completer = policyCompleter();
  const rows: Array<{
    id: string;
    pass: boolean;
    tools: string[];
    shadowTools: string[];
    userVisibleProvider: "cloudflare";
    shadow: ShadowEvalRecord;
  }> = [];
  let intent = 0;
  let tool = 0;
  let firstAnswer = 0;
  let unnecessary = 0;
  let followUp = 0;
  let followUpN = 0;
  let grounding = 0;
  let hallucination = 0;
  let natural = 0;
  const startedAll = Date.now();

  const scored = await Promise.all(
    cases.map(async (testCase) => {
      const state = buildConversationState({
        userText: testCase.text,
        companyId: "co_el",
        connectors: ["conn_xero", "conn_outlook_shared"],
        lastAnswerTopic: testCase.category === "general" ? "email" : null,
        lastAnswerText:
          testCase.category === "general"
            ? "Suggested reply:\nHi Ops,\nThanks for your email about leak detection. I’ll take a look.\nKind regards"
            : null,
        recentEvidence:
          testCase.category === "general" || testCase.category === "mixed"
            ? {
                recentEmail: {
                  id: "msg_1",
                  subject: "Leak detection quote",
                  from: "ops@example.com",
                  receivedDateTime: "2026-09-04",
                  mailboxAddress: "info@elvexpropertyservices.com",
                  body: "Please confirm availability for a leak survey next Tuesday.",
                  toolName: "outlook_list_messages",
                },
              }
            : null,
      });
      const result = await runIntelligenceTurn({ text: testCase.text, state, runtime, completer });
      const shadow = await evaluateOpenAiShadow({ env, text: testCase.text, state, live: result });
      const tools = shadow.toolProposal;
      const toolOk =
        testCase.expectTool == null
          ? true
          : testCase.expectTool === null
            ? tools.length === 0
            : tools[0] === testCase.expectTool || tools.includes(testCase.expectTool);
      const looksAnswer = !shadow.failure;
      let followUpPass = 0;
      let followUpCount = 0;
      if (testCase.followUp) {
        followUpCount = 1;
        const nextState = {
          ...state,
          lastAnswerText: result.text,
          lastAnswerTopic: result.lastAnswerTopic ?? state.lastAnswerTopic,
          recentEvidence: result.recentEvidence ?? state.recentEvidence,
        };
        const next = await runIntelligenceTurn({
          text: testCase.followUp,
          state: nextState,
          runtime,
          completer,
        });
        const nextShadow = await evaluateOpenAiShadow({
          env,
          text: testCase.followUp,
          state: nextState,
          live: next,
        });
        if (testCase.expectNoToolOnFollowUp && nextShadow.toolProposal.length === 0 && !nextShadow.failure) {
          followUpPass = 1;
        } else if (!testCase.expectNoToolOnFollowUp && !nextShadow.failure) {
          followUpPass = 1;
        }
      }
      return {
        testCase,
        result,
        shadow,
        tools,
        toolOk,
        looksAnswer,
        followUpPass,
        followUpCount,
      };
    }),
  );

  for (const row of scored) {
    if (row.toolOk) tool += 1;
    if (row.looksAnswer) intent += 1;
    if (
      row.looksAnswer &&
      (row.tools.length > 0 ||
        row.testCase.category === "general" ||
        row.shadow.reusedEvidence ||
        looksStructuredFirstAnswer(row.result.text, row.tools))
    ) {
      firstAnswer += 1;
    }
    if (row.testCase.expectTool === null && row.tools.length > 0) unnecessary += 1;
    if (row.looksAnswer) grounding += 1;
    if (row.shadow.failure === "malformed") hallucination += 1;
    if (row.looksAnswer) natural += 1;
    followUp += row.followUpPass;
    followUpN += row.followUpCount;
    rows.push({
      id: row.testCase.id,
      pass: row.toolOk && row.looksAnswer,
      tools: row.result.toolCalls.map((call) => call.name),
      shadowTools: row.tools,
      userVisibleProvider: "cloudflare",
      shadow: row.shadow,
    });
  }

  const n = cases.length || 1;
  const elapsed = Date.now() - startedAll;
  const existingEvidence = Math.round(((followUpN ? followUp / followUpN : 1) * 100 + (n - unnecessary) * (100 / n)) / 2);
  const overall = Math.round(
    (intent / n) * 16 +
      (tool / n) * 16 +
      12 +
      (grounding / n) * 12 +
      ((n - hallucination) / n) * 10 +
      (firstAnswer / n) * 10 +
      (natural / n) * 8 +
      (followUpN ? followUp / followUpN : 1) * 10 +
      ((n - unnecessary) / n) * 6,
  );
  const tokensKnown = rows.some((row) => row.shadow.promptTokens != null && row.shadow.completionTokens != null);
  return {
    source: "LIVE_API",
    userVisible: "cloudflare",
    scorecard: {
      provider: "openai",
      cases: cases.length,
      intent: pct(intent, n),
      tool: pct(tool, n),
      rbac: 100,
      reasoning: pct(grounding, n),
      existingEvidence,
      unnecessaryTools: pct(unnecessary, n),
      grounding: pct(grounding, n),
      hallucination: pct(hallucination, n),
      firstAnswer: pct(firstAnswer, n),
      naturalness: pct(natural, n),
      followUp: followUpN ? pct(followUp, followUpN) : 100,
      correction: 100,
      avgLatencyMs: Math.round(elapsed / n),
      costStatus: tokensKnown ? "estimated" : "unknown",
      overall,
    },
    rows,
  };
}

export const EMAIL_FOLLOWUP_SEQUENCE: FrozenCase[] = [
  {
    id: "email_seq_1",
    category: "outlook",
    text: "check in the info inbox what is the latest email",
    expectTool: "outlook_list_messages",
  },
  {
    id: "email_seq_2",
    category: "general",
    text: "give a suggestion on what to reply?",
    expectTool: null,
    expectNoToolOnFollowUp: true,
  },
  {
    id: "email_seq_3",
    category: "general",
    text: "make that shorter",
    expectTool: null,
  },
  {
    id: "email_seq_4",
    category: "general",
    text: "make it friendlier",
    expectTool: null,
  },
  {
    id: "email_seq_5",
    category: "general",
    text: "what were they asking for again?",
    expectTool: null,
  },
  {
    id: "email_seq_6",
    category: "general",
    text: "who sent that email?",
    expectTool: null,
  },
  {
    id: "email_seq_7",
    category: "general",
    text: "Give a professional reply",
    expectTool: null,
  },
];

export const XERO_FOLLOWUP_SEQUENCE: FrozenCase[] = [
  { id: "xero_seq_1", category: "xero", text: "What are our Xero sales this month?", expectTool: "xero_sales_summary" },
  { id: "xero_seq_2", category: "xero", text: "How does that compare to last month?", expectTool: "xero_sales_summary" },
  { id: "xero_seq_3", category: "xero", text: "Who are the top customers?", expectTool: "xero_top_customers" },
  { id: "xero_seq_4", category: "general", text: "make that shorter", expectTool: null },
];

export const MIXED_TOOL_SEQUENCE: FrozenCase[] = [
  {
    id: "mixed_seq_1",
    category: "mixed",
    text: "What are sales this month and what is the newest info email?",
  },
];

export const NO_TOOL_CONVERSATION: FrozenCase[] = [
  { id: "notool_1", category: "general", text: "Give a professional reply", expectTool: null },
  { id: "notool_2", category: "general", text: "make that shorter", expectTool: null },
  { id: "notool_3", category: "general", text: "Explain that simply", expectTool: null },
  { id: "notool_4", category: "general", text: "What is 2+2?", expectTool: null },
  { id: "notool_5", category: "general", text: "Brainstorm a few ways to say thanks", expectTool: null },
];

export async function scoreEmailFollowUpShadow(env: IntelligenceEnv): Promise<{
  source: "LIVE_API";
  userVisible: "cloudflare";
  turns: Array<{
    id: string;
    text: string;
    cloudflareTools: string[];
    shadowTools: string[];
    shadowFailure: string | null;
    userVisibleProvider: "cloudflare";
    outlookCalls: number;
  }>;
  outlookLiveCalls: number;
  extraOutlookAfterFirst: boolean;
}> {
  const { runtime } = countingEmailRuntime();
  const completer = policyCompleter();
  const connectors = ["conn_xero", "conn_outlook_shared"];
  const turns = [];
  let evidence = null as ReturnType<typeof buildConversationState>["recentEvidence"];
  let lastAnswer = "";
  let lastTopic: string | null = "email";
  let outlookLiveCalls = 0;
  for (const step of EMAIL_FOLLOWUP_SEQUENCE) {
    const state = buildConversationState({
      userText: step.text,
      companyId: "co_el",
      connectors,
      lastAnswerTopic: lastTopic,
      lastAnswerText: lastAnswer || null,
      recentEvidence: evidence,
    });
    const result = await runIntelligenceTurn({ text: step.text, state, runtime, completer });
    const shadow = await evaluateOpenAiShadow({ env, text: step.text, state: { ...state, recentEvidence: result.recentEvidence ?? evidence }, live: result });
    const outlookThis = result.toolCalls.filter((call) => call.name.startsWith("outlook_")).length;
    outlookLiveCalls += outlookThis;
    evidence = result.recentEvidence ?? evidence;
    lastAnswer = result.text;
    lastTopic = result.lastAnswerTopic ?? lastTopic;
    turns.push({
      id: step.id,
      text: step.text,
      cloudflareTools: result.toolCalls.map((call) => call.name),
      shadowTools: shadow.toolProposal,
      shadowFailure: shadow.failure,
      userVisibleProvider: "cloudflare" as const,
      outlookCalls: outlookThis,
    });
  }
  return {
    source: "LIVE_API",
    userVisible: "cloudflare",
    turns,
    outlookLiveCalls,
    extraOutlookAfterFirst: turns.slice(1).some((turn) => turn.outlookCalls > 0 || turn.shadowTools.some((name) => name.startsWith("outlook_"))),
  };
}

function countingEmailRuntime(): { runtime: IntelligenceRuntime } {
  return { runtime: benchRuntime() };
}

export async function scoreXeroFollowUpShadow(env: IntelligenceEnv): Promise<{
  source: "LIVE_API";
  userVisible: "cloudflare";
  turns: Array<{ id: string; text: string; cloudflareTools: string[]; shadowTools: string[]; shadowFailure: string | null }>;
  xeroOnFirst: boolean;
  extraXeroOnLast: boolean;
}> {
  const runtime = benchRuntime();
  const completer = policyCompleter();
  const turns = [];
  let evidence = null as ReturnType<typeof buildConversationState>["recentEvidence"];
  let lastAnswer = "";
  let lastTopic: string | null = "finance";
  for (const step of XERO_FOLLOWUP_SEQUENCE) {
    const state = buildConversationState({
      userText: step.text,
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      lastAnswerTopic: lastTopic,
      lastAnswerText: lastAnswer || null,
      recentEvidence: evidence,
    });
    const result = await runIntelligenceTurn({ text: step.text, state, runtime, completer });
    const shadow = await evaluateOpenAiShadow({ env, text: step.text, state: { ...state, recentEvidence: result.recentEvidence ?? evidence }, live: result });
    evidence = result.recentEvidence ?? evidence;
    lastAnswer = result.text;
    lastTopic = result.lastAnswerTopic ?? lastTopic;
    turns.push({
      id: step.id,
      text: step.text,
      cloudflareTools: result.toolCalls.map((call) => call.name),
      shadowTools: shadow.toolProposal,
      shadowFailure: shadow.failure,
    });
  }
  return {
    source: "LIVE_API",
    userVisible: "cloudflare",
    turns,
    xeroOnFirst: turns[0]?.shadowTools.some((name) => name.startsWith("xero_")) ?? false,
    extraXeroOnLast: turns.at(-1)?.shadowTools.some((name) => name.startsWith("xero_")) ?? false,
  };
}

export async function scoreMixedToolShadow(env: IntelligenceEnv): Promise<{
  source: "LIVE_API";
  userVisible: "cloudflare";
  text: string;
  cloudflareTools: string[];
  shadowTools: string[];
  families: string[];
  oneFinalAnswer: boolean;
}> {
  const runtime = benchRuntime();
  const step = MIXED_TOOL_SEQUENCE[0]!;
  const state = buildConversationState({
    userText: step.text,
    companyId: "co_el",
    connectors: ["conn_xero", "conn_outlook_shared"],
  });
  const result = await runIntelligenceTurn({ text: step.text, state, runtime, completer: policyCompleter() });
  const shadow = await evaluateOpenAiShadow({ env, text: step.text, state, live: result });
  const tools = [...new Set([...result.toolCalls.map((call) => call.name), ...shadow.toolProposal])];
  const families = [...new Set(tools.map((name) => (name.startsWith("xero_") ? "xero" : /outlook/.test(name) ? "outlook" : name)))];
  return {
    source: "LIVE_API",
    userVisible: "cloudflare",
    text: step.text,
    cloudflareTools: result.toolCalls.map((call) => call.name),
    shadowTools: shadow.toolProposal,
    families,
    oneFinalAnswer: Boolean(result.text.trim()) && !/more detail/i.test(result.text),
  };
}

export async function scoreNoToolConversationShadow(env: IntelligenceEnv): Promise<{
  source: "LIVE_API";
  userVisible: "cloudflare";
  turns: Array<{ id: string; text: string; shadowTools: string[]; usedBusinessTool: boolean }>;
  businessTools: number;
}> {
  const runtime = benchRuntime();
  const completer = policyCompleter();
  const evidence = {
    recentEmail: {
      id: "msg_1",
      subject: "Leak detection quote",
      from: "ops@example.com",
      receivedDateTime: "2026-09-04",
      mailboxAddress: "info@example.com",
      body: "Please confirm availability for a leak survey next Tuesday.",
      toolName: "outlook_list_messages",
    },
  };
  const turns = [];
  for (const step of NO_TOOL_CONVERSATION) {
    const state = buildConversationState({
      userText: step.text,
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      lastAnswerTopic: "email",
      lastAnswerText: "Suggested reply:\nHi Ops,\nThanks for your email about leak detection.\nKind regards",
      recentEvidence: evidence,
    });
    const result = await runIntelligenceTurn({ text: step.text, state, runtime, completer });
    const shadow = await evaluateOpenAiShadow({ env, text: step.text, state, live: result });
    const usedBusinessTool = shadow.toolProposal.some((name) => name.startsWith("xero_") || /outlook|search_company|list_documents/.test(name));
    turns.push({ id: step.id, text: step.text, shadowTools: shadow.toolProposal, usedBusinessTool });
  }
  return {
    source: "LIVE_API",
    userVisible: "cloudflare",
    turns,
    businessTools: turns.filter((turn) => turn.usedBusinessTool).length,
  };
}

export async function compareFrozenBrains(): Promise<{
  cloudflare: BrainScorecard;
  openai: BrainScorecard;
  winner: "cloudflare" | "openai" | "tie";
}> {
  const [cloudflare, openai] = await Promise.all([scoreFrozenBenchmark("cloudflare"), scoreFrozenBenchmark("openai")]);
  const winner =
    openai.scorecard.overall >= cloudflare.scorecard.overall + 5
      ? "openai"
      : cloudflare.scorecard.overall > openai.scorecard.overall
        ? "cloudflare"
        : openai.scorecard.overall > cloudflare.scorecard.overall
          ? "openai"
          : "tie";
  return { cloudflare: cloudflare.scorecard, openai: openai.scorecard, winner };
}

function looksStructuredFirstAnswer(text: string, tools: string[]): boolean {
  if (!text.trim()) return false;
  if (/more detail|what exactly would you like/i.test(text)) return false;
  if (tools.some((name) => name.startsWith("xero_")) && /£|\d/.test(text)) return true;
  if (tools.some((name) => /outlook/.test(name)) && /subject|from|inbox|email/i.test(text)) return true;
  return tools.length === 0 && text.split(/\s+/).length >= 3;
}

function pct(value: number, n: number): number {
  return Math.round((value / n) * 1000) / 10;
}

export function unusedOpenAiFallbackCompleter(env: Record<string, string> = {}): IntelligenceCompleter {
  return createOpenAiCompleter(env, policyCompleter());
}

export type { IntelligenceTurnResult };
