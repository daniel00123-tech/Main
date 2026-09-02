import { describe, expect, it } from "vitest";
import {
  resolveBusinessSystemIntent,
  xeroAllowedForQuery,
} from "@infra/shared";
import { classifyScope } from "./scope.js";
import { buildConversationState } from "./state.js";
import { runIntelligenceTurn } from "./orchestrator.js";
import { honourScopedToolCall } from "./capability-guard.js";
import { prepareOutlookSearchArguments, resolveCompanyPerson } from "./outlook-args.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const EL_CONNECTORS = ["conn_xero", "conn_outlook_shared", "conn_onedrive", "conn_sharepoint"];
const EL_PEOPLE = [
  { displayName: "Sharon", email: "sharon@elvexpropertyservices.com" },
  { displayName: "Ella Mae", email: "ella@elvexpropertyservices.com" },
  { displayName: "William", email: "william@elvexpropertyservices.com" },
];

const CHANNELS = ["whatsapp", "portal", "api"] as const;

const FIVE_PROMPTS = [
  { text: "Search emails", family: "outlook" as const, tool: /^outlook_/ },
  { text: "How many emails has Sharon sent today?", family: "outlook" as const, tool: /^outlook_/ },
  { text: "What is the PO process", family: "knowledge" as const, tool: /^search_company_knowledge$/ },
  { text: "Tell me on Xero what our sales are", family: "xero" as const, tool: /^xero_/ },
  { text: "Show me the newest OneDrive files", family: "catalogue" as const, tool: /^list_company_documents$/ },
];

const EL_CASES: Array<{ id: string; text: string; family: "outlook" | "knowledge" | "xero" | "catalogue" | "deny-xero" | "correction" }> = [
  { id: "email.search", text: "Search emails", family: "outlook" },
  { id: "email.button", text: "search the shared mailbox", family: "outlook" },
  { id: "email.sharon", text: "How many emails has Sharon sent today?", family: "outlook" },
  { id: "email.sharon2", text: "How many emails has Sharon sent today", family: "outlook" },
  { id: "email.latest", text: "find the latest email about it", family: "outlook" },
  { id: "email.inbox", text: "Any unread in Outlook?", family: "outlook" },
  { id: "email.info", text: "Show me info@ emails", family: "outlook" },
  { id: "email.subject", text: "Search the mailbox for purchase orders", family: "outlook" },
  { id: "process.po", text: "What is the PO process", family: "knowledge" },
  { id: "process.po2", text: "What is the po process", family: "knowledge" },
  { id: "process.po3", text: "Po process", family: "knowledge" },
  { id: "process.purchase", text: "Purchase order process", family: "knowledge" },
  { id: "process.policy", text: "Where is the invoice approval process written down?", family: "knowledge" },
  { id: "process.handbook", text: "What is our staff handbook process", family: "knowledge" },
  { id: "docs.onedrive", text: "Show me the newest OneDrive files", family: "catalogue" },
  { id: "docs.sharepoint", text: "what are the latest changed SharePoint documents", family: "catalogue" },
  { id: "docs.find", text: "Find the vehicle use policy", family: "knowledge" },
  { id: "xero.sales", text: "What are our sales today?", family: "xero" },
  { id: "xero.named", text: "Tell me on Xero what our sales are", family: "xero" },
  { id: "xero.month", text: "what are our Xero sales this month?", family: "xero" },
  { id: "xero.raised", text: "show me invoices raised today", family: "xero" },
  { id: "xero.overdue", text: "Show overdue invoices", family: "xero" },
  { id: "xero.outstanding", text: "what is outstanding in Xero?", family: "xero" },
  { id: "deny.email-not-xero", text: "How many emails has Sharon sent today?", family: "deny-xero" },
  { id: "deny.search-emails", text: "Search emails", family: "deny-xero" },
  { id: "deny.po", text: "What is the PO process", family: "deny-xero" },
  { id: "deny.purchase", text: "Purchase order process", family: "deny-xero" },
  { id: "correction.email", text: "No, I meant emails from Sharon", family: "outlook" },
  { id: "correction.process", text: "Wrong — I meant the PO process", family: "knowledge" },
  { id: "perm.finance-mailbox", text: "Show finance emails", family: "outlook" },
];

function expectedScope(family: (typeof EL_CASES)[number]["family"]): string | null {
  if (family === "outlook") return "BUSINESS_SYSTEM";
  if (family === "xero") return "BUSINESS_SYSTEM";
  if (family === "catalogue") return "SYSTEM_META";
  if (family === "knowledge") return "COMPANY_KNOWLEDGE";
  return null;
}

function recordingRuntime(preferXero = false): { runtime: IntelligenceRuntime; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push(call.name);
        if (preferXero && call.name.startsWith("xero_")) {
          return { name: call.name, ok: true, latencyMs: 1, data: { summary: { totalSales: 99, transactionCount: 1 } } };
        }
        if (call.name.startsWith("outlook_")) {
          return {
            name: call.name,
            ok: true,
            latencyMs: 1,
            data: { mailboxAddress: "info@elvexpropertyservices.com", count: 2, messages: [] },
          };
        }
        if (call.name.startsWith("xero_")) {
          return { name: call.name, ok: true, latencyMs: 1, data: { summary: { totalSales: 10, transactionCount: 1 } } };
        }
        if (call.name === "list_company_documents") {
          return { name: call.name, ok: true, latencyMs: 1, data: { sort: "newest", documents: [] } };
        }
        return { name: call.name, ok: true, latencyMs: 1, data: { results: [] } };
      },
    },
  };
}

const xeroLovingCompleter = async ({ user }: { user: string }) => {
  const userLine = user.match(/User: (.*)$/m)?.[1] ?? user;
  return {
    text: JSON.stringify({ action: "call_tool", name: "xero_sales_summary", arguments: { query: userLine } }),
    toolCalls: [{ name: "xero_sales_summary", arguments: { query: userLine } }],
    structured: { action: "call_tool", name: "xero_sales_summary", arguments: { query: userLine } },
    usage: {
      provider: "none",
      model: "test",
      latencyMs: 1,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      fallbackUsed: false,
      malformed: false,
    },
  };
};

describe("Elvex connector routing — live failing prompts", () => {
  it("agrees across WhatsApp / Portal / API intelligence for the five prompts", async () => {
    for (const prompt of FIVE_PROMPTS) {
      const scopes = CHANNELS.map((channel) => {
        const decision = classifyScope(
          prompt.text,
          buildConversationState({ userText: prompt.text, connectors: EL_CONNECTORS }),
        );
        return { channel, scope: decision.scope, tool: decision.tool };
      });
      for (const row of scopes) {
        if (prompt.family === "outlook") {
          expect(row.scope).toBe("BUSINESS_SYSTEM");
          expect(row.tool).toMatch(prompt.tool);
        } else if (prompt.family === "xero") {
          expect(row.scope).toBe("BUSINESS_SYSTEM");
          expect(row.tool).toMatch(prompt.tool);
        } else if (prompt.family === "knowledge") {
          expect(row.scope).toBe("COMPANY_KNOWLEDGE");
          expect(row.tool).toMatch(prompt.tool);
        } else {
          expect(row.scope).toBe("SYSTEM_META");
          expect(row.tool).toMatch(prompt.tool);
        }
      }
      expect(new Set(scopes.map((row) => `${row.scope}:${row.tool}`)).size).toBe(1);
    }
  });

  it("never lets a Xero-loving completer bill Xero for email or process asks", async () => {
    for (const text of [
      "How many emails has Sharon sent today?",
      "Search emails",
      "What is the PO process",
      "Purchase order process",
    ]) {
      const { runtime, calls } = recordingRuntime(true);
      const result = await runIntelligenceTurn({
        text,
        state: buildConversationState({ userText: text, connectors: EL_CONNECTORS, permittedTools: [
          "outlook_search_mailbox",
          "outlook_list_messages",
          "search_company_knowledge",
          "xero_sales_summary",
          "list_company_documents",
        ] }),
        runtime,
        completer: xeroLovingCompleter as never,
      });
      expect(calls.some((name) => name.startsWith("xero_"))).toBe(false);
      expect(result.toolCalls.some((call) => call.name.startsWith("xero_"))).toBe(false);
    }
  });
});

describe("Elvex WhatsApp-intelligence cases", () => {
  it("covers at least 30 email, document, Xero, permission, and correction cases", () => {
    expect(EL_CASES.length).toBeGreaterThanOrEqual(30);
    for (const testCase of EL_CASES) {
      if (testCase.family === "deny-xero") {
        expect(xeroAllowedForQuery(testCase.text)).toBe(false);
        continue;
      }
      const decision = classifyScope(
        testCase.text,
        buildConversationState({ userText: testCase.text, connectors: EL_CONNECTORS }),
      );
      const scope = expectedScope(testCase.family);
      if (scope) expect(decision.scope).toBe(scope);
      if (testCase.family === "outlook") expect(decision.tool?.startsWith("outlook_")).toBe(true);
      if (testCase.family === "xero") expect(decision.tool?.startsWith("xero_")).toBe(true);
      if (testCase.family === "knowledge") expect(decision.tool).toBe("search_company_knowledge");
      if (testCase.family === "catalogue") expect(decision.tool).toBe("list_company_documents");
      expect(resolveBusinessSystemIntent(testCase.text, { connectors: EL_CONNECTORS.map((id) => ({ definitionId: id })) })?.capability === "xero").toBe(
        testCase.family === "xero",
      );
    }
  });

  it("honours Outlook when Scout asks for Xero on an email turn", () => {
    const honoured = honourScopedToolCall(
      { scope: "BUSINESS_SYSTEM", tool: "outlook_search_mailbox", lastUserIntent: "email", lastAnswerTopic: "email" },
      "xero_sales_summary",
    );
    expect(honoured.overridden).toBe(true);
    expect(honoured.name).toBe("outlook_search_mailbox");
  });

  it("resolves Sharon from company data and does not invent an address", () => {
    const sharon = resolveCompanyPerson(EL_PEOPLE, "Sharon");
    expect(sharon.status).toBe("resolved");
    if (sharon.status === "resolved") {
      expect(sharon.person.email).toBe("sharon@elvexpropertyservices.com");
    }
    const prepared = prepareOutlookSearchArguments("How many emails has Sharon sent today?", EL_PEOPLE, new Date("2026-09-02T12:00:00Z"));
    expect(prepared.fromEmail).toBe("sharon@elvexpropertyservices.com");
    expect(prepared.query).toContain("sharon@elvexpropertyservices.com");
    expect(prepared.fromDate).toBe("2026-09-02");
    expect(prepared.toDate).toBe("2026-09-02");
    expect(prepareOutlookSearchArguments("How many emails has Pat sent today?", EL_PEOPLE).fromEmail).toBeUndefined();
  });
});
