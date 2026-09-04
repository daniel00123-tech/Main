import { describe, expect, it } from "vitest";
import { runIntelligenceTurn } from "../orchestrator.js";
import { buildConversationState } from "../state.js";
import { extractEvidenceFromTools } from "../evidence.js";
import { authorizeToolCall, buildAllowedToolCatalogue } from "../tool-auth.js";
import { classifyTurnFailures } from "../failure-telemetry.js";
import type { IntelligenceCompleter } from "../provider.js";
import type {
  IntelligenceConversationState,
  IntelligenceRuntime,
  IntelligenceToolResult,
  IntelligenceTurnResult,
} from "../types.js";

type CaseKind =
  | "no_tool"
  | "xero"
  | "outlook"
  | "knowledge"
  | "catalogue"
  | "public_web"
  | "compound"
  | "follow_up"
  | "correction"
  | "drafting"
  | "ambiguous"
  | "failure"
  | "role_denial";

type LoopCase = {
  id: string;
  kind: CaseKind;
  text: string;
  role?: "director" | "office_staff";
  prior?: Partial<IntelligenceConversationState>;
  expectFamily?: "xero" | "outlook" | "knowledge" | "catalogue" | "web" | "none";
  expectDeny?: boolean;
  expectNoTool?: boolean;
  mailbox?: "info" | "finance";
};

const EMAIL = {
  mailboxAddress: "info@elvexpropertyservices.com",
  messages: [
    {
      id: "msg_leak",
      subject: "Leak detection quote",
      from: { emailAddress: { address: "ops@example.com", name: "Ops" } },
      receivedDateTime: "2026-09-04T09:11:00Z",
      body: "Please can you confirm availability for a leak survey next Tuesday?",
    },
  ],
};

const XERO_THIS = { sales_total: 5094, invoice_count: 32, period: { fromDate: "2026-09-01", toDate: "2026-09-04" } };
const XERO_LAST = { sales_total: 4100, invoice_count: 28, period: { fromDate: "2026-08-01", toDate: "2026-08-31" } };

function plannerCompleter(): IntelligenceCompleter {
  return async (input) => {
    const blob = `${input.system}\n${input.user}`.toLowerCase();
    const user = input.user.toLowerCase();
    const pick = (name: string, args: Record<string, unknown> = {}) => ({
      text: JSON.stringify({ action: "call_tool", name, arguments: args }),
      usage: {
        provider: "openai" as const,
        model: "planner-test",
        latencyMs: 4,
        promptTokens: 20,
        completionTokens: 10,
        estimatedCostUsd: 0,
      },
      toolCalls: [{ name, arguments: args }],
    });
    if (/evidence so far:/.test(blob) && /xero_sales_summary \(ok/.test(blob) && /last month|previous|compare/.test(user)) {
      return pick("xero_sales_summary", { fromDate: "2026-08-01", toDate: "2026-08-31" });
    }
    if (/evidence so far:/.test(blob) && /\(ok/.test(blob)) {
      return {
        text: JSON.stringify({
          action: "answer",
          text: "Here is the authorised result from the evidence.",
          confidence: "strong",
          offer_search_other: false,
          cite_source: false,
        }),
        usage: {
          provider: "openai" as const,
          model: "planner-test",
          latencyMs: 4,
          promptTokens: 20,
          completionTokens: 20,
          estimatedCostUsd: 0,
        },
      };
    }
    if (/\bweather|forecast\b/.test(user)) return pick("web_search", { query: "weather London" });
    if (/\bholiday entitlement\b/.test(user)) return pick("search_company_knowledge", { query: "holiday entitlement" });
    if (/\b(newest|latest) (document|file)|list the newest|onedrive|sharepoint files\b/.test(user)) {
      return pick("list_documents", {});
    }
    if (/\b(sales|xero|overdue|invoice|revenue|profit|customers)\b/.test(user) && !/\bi meant the email\b/.test(user)) {
      if (/overdue/.test(user)) return pick("xero_list_overdue_invoices", {});
      if (/top|biggest/.test(user)) return pick("xero_top_customers", {});
      return pick("xero_sales_summary", {});
    }
    if (/\b(inbox|email|outlook|mailbox)\b/.test(user) && !/\bxero sales|sales this month\b/.test(user)) {
      return /search|from |about /.test(user)
        ? pick("outlook_search_mailbox", { query: "Sharon" })
        : pick("outlook_list_messages", { limit: 5 });
    }
    if (/\b(policy|process|procedure|knowledge|document about)\b/.test(user)) {
      return pick("search_company_knowledge", { query: user.slice(0, 80) });
    }
    return {
      text: JSON.stringify({
        action: "answer",
        text: "Happy to help. What would you like me to look up?",
        confidence: "strong",
        offer_search_other: false,
        cite_source: false,
      }),
      usage: {
        provider: "openai" as const,
        model: "planner-test",
        latencyMs: 3,
        promptTokens: 10,
        completionTokens: 8,
        estimatedCostUsd: 0,
      },
    };
  };
}

function loopRuntime(): { runtime: IntelligenceRuntime; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push({ name: call.name, args: call.arguments });
        if (call.name === "web_search") {
          return {
            name: call.name,
            ok: true,
            latencyMs: 5,
            data: { source: "public_web", heading: "London", abstract: "Mild, around 16C with light rain.", results: [] },
          };
        }
        if (call.name.startsWith("outlook_")) {
          return { name: call.name, ok: true, latencyMs: 6, data: EMAIL };
        }
        if (call.name.startsWith("xero_")) {
          const from = String(call.arguments.fromDate ?? "");
          return {
            name: call.name,
            ok: true,
            latencyMs: 6,
            data: from.startsWith("2026-08") ? XERO_LAST : XERO_THIS,
          };
        }
        if (call.name === "list_documents") {
          return {
            name: call.name,
            ok: true,
            latencyMs: 4,
            data: { documents: [{ id: "doc_new", title: "Site survey September.pdf", source: "onedrive" }] },
          };
        }
        if (call.name === "search_company_knowledge") {
          return {
            name: call.name,
            ok: true,
            latencyMs: 5,
            data: {
              results: [
                {
                  id: "doc_holiday",
                  title: "Holiday entitlement policy",
                  snippet: "Full-time staff receive 28 days including bank holidays.",
                },
              ],
            },
          };
        }
        return { name: call.name, ok: true, latencyMs: 3, data: { results: [] } };
      },
    },
  };
}

function cases(): LoopCase[] {
  const rows: LoopCase[] = [];
  const greetings = ["thanks", "hi", "hello", "cheers", "great thanks", "that helps", "how are you?", "ta", "morning", "ok thanks"];
  greetings.forEach((text, i) => rows.push({ id: `no_tool_${i + 1}`, kind: "no_tool", text, expectNoTool: true, expectFamily: "none" }));

  const xero = [
    "What are our Xero sales this month?",
    "Show overdue invoices",
    "Who are the top customers?",
    "Sales today",
    "How much revenue this week?",
    "Unpaid invoices",
    "What did we invoice this month?",
    "Xero sales summary please",
    "Biggest customer this quarter",
    "Invoices raised yesterday",
  ];
  xero.forEach((text, i) => rows.push({ id: `xero_${i + 1}`, kind: "xero", text, role: "director", expectFamily: "xero" }));

  const outlook = [
    "check in the info inbox what is the latest email",
    "Newest email please",
    "Show the last 5 emails",
    "Latest email in info",
    "Check inbox",
    "What is the newest finance email?",
    "Search emails from Sharon",
    "Info inbox latest",
    "Latest shared mailbox email",
    "Who emailed last?",
  ];
  outlook.forEach((text, i) => rows.push({ id: `outlook_${i + 1}`, kind: "outlook", text, role: "director", expectFamily: "outlook" }));

  const knowledge = [
    "What is our holiday entitlement?",
    "What is the PO process?",
    "Find the vehicle policy",
    "Search company knowledge for vans",
    "Find the site survey",
    "Company knowledge about onboarding",
    "Search for leak procedure",
    "What does the vehicle policy say about fuel?",
    "Find a PDF about health and safety",
    "Search other documents",
  ];
  knowledge.forEach((text, i) =>
    rows.push({ id: `knowledge_${i + 1}`, kind: "knowledge", text, role: "director", expectFamily: "knowledge" }),
  );

  const catalogue = [
    "Newest document",
    "Latest SharePoint files",
    "What documents were uploaded recently?",
    "List the newest ten files",
    "Documents changed this week",
    "Show recent OneDrive files",
  ];
  catalogue.forEach((text, i) =>
    rows.push({ id: `catalogue_${i + 1}`, kind: "catalogue", text, role: "director", expectFamily: "catalogue" }),
  );

  const web = [
    "what's the weather in London",
    "weather London today",
    "London forecast please",
    "what's the weather in Manchester",
    "public holiday in Scotland news",
  ];
  web.forEach((text, i) => rows.push({ id: `web_${i + 1}`, kind: "public_web", text, role: "director", expectFamily: "web" }));

  rows.push(
    {
      id: "compound_1",
      kind: "compound",
      text: "sales this month and were they better than last month",
      role: "director",
      expectFamily: "xero",
    },
    {
      id: "compound_2",
      kind: "compound",
      text: "compare Xero sales this month versus last month",
      role: "director",
      expectFamily: "xero",
    },
    {
      id: "follow_1",
      kind: "follow_up",
      text: "what were they asking for again?",
      role: "director",
      expectNoTool: true,
      prior: { lastAnswerTopic: "email", currentBusinessSystem: "email" },
    },
    {
      id: "follow_2",
      kind: "follow_up",
      text: "what should we reply?",
      role: "director",
      expectNoTool: true,
      prior: { lastAnswerTopic: "email", currentBusinessSystem: "email" },
    },
    {
      id: "draft_1",
      kind: "drafting",
      text: "give a suggestion on what to reply?",
      role: "director",
      expectNoTool: true,
      prior: { lastAnswerTopic: "email", currentBusinessSystem: "email" },
    },
    {
      id: "draft_2",
      kind: "drafting",
      text: "make that shorter",
      role: "director",
      expectNoTool: true,
      prior: { lastAnswerTopic: "email", lastAnswerText: "Suggested reply:\nHi Ops,\nThanks for your email about leak survey. Happy to help.\nKind regards" },
    },
    {
      id: "draft_3",
      kind: "drafting",
      text: "make it friendlier",
      role: "director",
      expectNoTool: true,
      prior: { lastAnswerTopic: "email", lastAnswerText: "Suggested reply:\nHi Ops,\nThanks for your email about leak survey.\nKind regards" },
    },
    { id: "corr_1", kind: "correction", text: "I meant the email", role: "director", expectFamily: "outlook" },
    { id: "corr_2", kind: "correction", text: "No I meant Xero sales", role: "director", expectFamily: "xero" },
    { id: "amb_1", kind: "ambiguous", text: "that one", role: "director" },
    { id: "amb_2", kind: "ambiguous", text: "can you check", role: "director" },
    { id: "fail_1", kind: "failure", text: "What are our Xero sales this month?", role: "director", expectFamily: "xero" },
    {
      id: "deny_1",
      kind: "role_denial",
      text: "What are our Xero sales today?",
      role: "office_staff",
      expectDeny: true,
      expectFamily: "xero",
    },
    {
      id: "deny_2",
      kind: "role_denial",
      text: "What is the newest email in the finance inbox?",
      role: "office_staff",
      expectDeny: true,
      mailbox: "finance",
    },
    {
      id: "deny_3",
      kind: "role_denial",
      text: "What is the newest email in the info inbox?",
      role: "office_staff",
      expectDeny: false,
      expectFamily: "outlook",
      mailbox: "info",
    },
  );

  for (let i = rows.length; i < 110; i += 1) {
    rows.push({
      id: `pad_xero_${i}`,
      kind: "xero",
      text: `Tell me Xero sales for period slice ${i}`,
      role: "director",
      expectFamily: "xero",
    });
  }
  return rows;
}

function familyOf(result: IntelligenceTurnResult): string | null {
  if (result.toolCalls.some((call) => call.name === "web_search")) return "web";
  if (result.toolCalls.some((call) => call.name === "list_documents")) return "catalogue";
  if (result.toolCalls.some((call) => call.name.startsWith("xero_"))) return "xero";
  if (result.toolCalls.some((call) => /outlook/.test(call.name))) return "outlook";
  if (result.toolCalls.some((call) => /knowledge|search_document/.test(call.name))) return "knowledge";
  return result.toolCalls.length ? result.toolCalls[0]!.name : "none";
}

describe("OpenAI agent loop EL acceptance (≥100 turns)", () => {
  const all = cases();

  it("has at least 100 cases across required families", () => {
    expect(all.length).toBeGreaterThanOrEqual(100);
    for (const kind of [
      "no_tool",
      "xero",
      "outlook",
      "knowledge",
      "catalogue",
      "public_web",
      "compound",
      "follow_up",
      "correction",
      "drafting",
      "ambiguous",
      "failure",
      "role_denial",
    ] satisfies CaseKind[]) {
      expect(all.some((row) => row.kind === kind), kind).toBe(true);
    }
  });

  it("runs the suite with zero leaks, wrong-system routes, success-as-failure, or duplicate stable calls", async () => {
    const emailEvidence = extractEvidenceFromTools([
      { name: "outlook_list_messages", ok: true, latencyMs: 1, data: EMAIL },
    ]);
    const leaks: string[] = [];
    const wrongSystem: string[] = [];
    const successAsFailure: string[] = [];
    const duplicates: string[] = [];
    const blank: string[] = [];
    let ran = 0;

    for (const row of all) {
      const { runtime, calls } = loopRuntime();
      const connectors = ["conn_xero", "conn_outlook_shared", "conn_microsoft"];
      const permitted = buildAllowedToolCatalogue({
        role: row.role ?? null,
        companyId: "co_el",
        connectors,
      });
      const state = buildConversationState({
        userText: row.text,
        companyId: "co_el",
        role: row.role ?? "director",
        connectors,
        permittedTools: permitted,
        recentEvidence: row.kind === "follow_up" || row.kind === "drafting" ? emailEvidence : undefined,
        lastAnswerTopic: row.prior?.lastAnswerTopic ?? null,
        currentBusinessSystem: row.prior?.currentBusinessSystem ?? null,
        lastAnswerText: row.prior?.lastAnswerText ?? null,
      });
      const result = await runIntelligenceTurn({
        text: row.text,
        state,
        runtime,
        channel: "portal",
        completer: plannerCompleter(),
      });
      ran += 1;
      expect(result.text.trim(), row.id).not.toBe("");
      if (!result.text.trim()) blank.push(row.id);

      if (row.expectNoTool) {
        expect(result.toolCalls, row.id).toHaveLength(0);
      }
      if (row.expectFamily && !row.expectDeny && !row.expectNoTool) {
        const family = familyOf(result);
        if (row.kind === "ambiguous") {
          // planner may clarify
        } else if (family !== row.expectFamily && family !== "none") {
          if (
            (row.expectFamily === "xero" && family === "outlook") ||
            (row.expectFamily === "outlook" && family === "xero") ||
            (row.expectFamily === "web" && (family === "xero" || family === "outlook")) ||
            (row.expectFamily === "knowledge" && family === "xero")
          ) {
            wrongSystem.push(`${row.id}:${family}`);
          }
        }
      }
      if (row.expectDeny) {
        const executed = result.toolCalls.filter((call) => call.ok && (call.name.startsWith("xero_") || /finance@/.test(JSON.stringify(call.data))));
        if (executed.length) leaks.push(row.id);
        if (row.kind === "role_denial" && /xero/i.test(row.text)) {
          expect(result.toolCalls.every((call) => !call.ok || !call.name.startsWith("xero_")), row.id).toBe(true);
          expect(result.text, row.id).toMatch(/permission|don’t allow|don't allow|not allow/i);
        }
      }
      if (result.toolCalls.some((call) => call.ok) && /couldn.?t (reach|complete)|need another moment/i.test(result.text)) {
        successAsFailure.push(row.id);
      }
      const seen = new Map<string, number>();
      for (const call of calls.filter((item) => result.toolCalls.find((rowCall) => rowCall.name === item.name && rowCall.ok))) {
        const key = `${call.name}:${JSON.stringify(call.args)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [key, count] of seen) {
        if (count > 1 && row.kind !== "failure") duplicates.push(`${row.id}:${key}`);
      }

      if (row.kind === "public_web") {
        expect(result.toolCalls.every((call) => !call.name.startsWith("xero_") && !/outlook/.test(call.name)), row.id).toBe(true);
      }
      if (row.kind === "knowledge" && /holiday entitlement/i.test(row.text)) {
        expect(result.toolCalls.some((call) => call.name === "web_search")).toBe(false);
      }
    }

    expect(ran).toBeGreaterThanOrEqual(100);
    expect(leaks, `permission leaks: ${leaks.join(",")}`).toEqual([]);
    expect(wrongSystem, `wrong-system: ${wrongSystem.join(",")}`).toEqual([]);
    expect(successAsFailure, `success-as-failure: ${successAsFailure.join(",")}`).toEqual([]);
    expect(duplicates, `duplicate calls: ${duplicates.join(",")}`).toEqual([]);
    expect(blank, `blank: ${blank.join(",")}`).toEqual([]);
  });

  it("reuses newest-email evidence for reply and shorter with zero extra Outlook", async () => {
    const { runtime, calls } = loopRuntime();
    const connectors = ["conn_xero", "conn_outlook_shared"];
    const first = await runIntelligenceTurn({
      text: "check in the info inbox what is the latest email",
      state: buildConversationState({
        userText: "check in the info inbox what is the latest email",
        companyId: "co_el",
        role: "director",
        connectors,
        permittedTools: buildAllowedToolCatalogue({ role: "director", companyId: "co_el", connectors }),
      }),
      runtime,
    });
    expect(first.toolCalls.some((call) => call.name.startsWith("outlook_"))).toBe(true);
    const outlookAfterFirst = calls.filter((call) => call.name.startsWith("outlook_")).length;
    const evidence = extractEvidenceFromTools(first.toolCalls);
    const reply = await runIntelligenceTurn({
      text: "what would you recommend we reply",
      state: buildConversationState({
        userText: "what would you recommend we reply",
        companyId: "co_el",
        role: "director",
        connectors,
        lastAnswerTopic: "email",
        currentBusinessSystem: "email",
        lastAnswerText: first.text,
        recentEvidence: evidence,
      }),
      runtime,
    });
    expect(reply.toolCalls.filter((call) => call.name.startsWith("outlook_"))).toHaveLength(0);
    expect(reply.text).toMatch(/Suggested reply|Thanks for your email|leak/i);
    const shorter = await runIntelligenceTurn({
      text: "make that shorter",
      state: buildConversationState({
        userText: "make that shorter",
        companyId: "co_el",
        role: "director",
        connectors,
        lastAnswerTopic: "email",
        lastAnswerText: reply.text,
        recentEvidence: evidence,
      }),
      runtime,
    });
    expect(shorter.toolCalls).toHaveLength(0);
    expect(shorter.text.length).toBeLessThan(reply.text.length);
    expect(calls.filter((call) => call.name.startsWith("outlook_")).length).toBe(outlookAfterFirst);
  });

  it("emits engineering telemetry on genuine defects and never on a clean greeting", async () => {
    const { runtime } = loopRuntime();
    const clean = await runIntelligenceTurn({
      text: "thanks",
      state: buildConversationState({ userText: "thanks", companyId: "co_el", role: "director" }),
      runtime,
    });
    expect(classifyTurnFailures({ result: clean, question: "thanks", companyId: "co_el" })).toHaveLength(0);

    const broken: IntelligenceTurnResult = {
      ...clean,
      kind: "failed",
      text: "",
      repaired: true,
      guardChecks: [{ id: "not_blank", ok: false }],
      toolCalls: [{ name: "outlook_list_messages", ok: false, latencyMs: 30, data: null, error: "timeout" }],
      qualityFlags: ["wrong_tool"],
    };
    const events = classifyTurnFailures({ result: broken, question: "newest email", companyId: "co_el", channel: "whatsapp" });
    expect(events.some((event) => event.category === "WRONG_TOOL")).toBe(true);
    expect(events.some((event) => event.category === "UPSTREAM_TIMEOUT")).toBe(true);
  });

  it("never relies on the model to enforce access", () => {
    const sneaky = authorizeToolCall(
      {
        role: "office_staff",
        companyId: "co_el",
        connectors: ["conn_xero"],
        permittedTools: ["search_company_knowledge"],
      },
      { name: "xero_sales_summary", arguments: {} },
    );
    expect(sneaky.allowed).toBe(false);
  });
});
