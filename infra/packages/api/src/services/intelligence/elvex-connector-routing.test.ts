import { describe, expect, it } from "vitest";
import { resolveBusinessSystemIntent, xeroAllowedForQuery } from "@infra/shared";
import { classifyScope } from "./scope.js";
import { honourScopedToolCall, shouldRecoverAsEmail, shouldRecoverAsFinance } from "./capability-guard.js";
import { extractSenderHint, pickOutlookReadTool, prepareOutlookSearchArguments, resolveCompanyPerson } from "./outlook-args.js";
import { runIntelligenceTurn } from "./orchestrator.js";
import { buildConversationState } from "./state.js";
import { connectorFamilyFromAction } from "../usage-attribution.js";
import { elvexAllowsAction } from "@infra/shared";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult } from "./types.js";

const EL = [
  { definitionId: "conn_xero", name: "Xero", connected: true },
  { definitionId: "conn_outlook_shared", name: "Outlook", connected: true },
  { definitionId: "conn_onedrive", name: "OneDrive", connected: true },
  { definitionId: "conn_sharepoint", name: "SharePoint", connected: true },
];

const SHARON = [{ displayName: "Sharon", email: "sharon@elvexpropertyservices.com" }];

function xeroHungryCompleter(): IntelligenceCompleter {
  return async ({ user }) => {
    const userLine = user.match(/User: (.*)$/m)?.[1] ?? user;
    return {
      text: JSON.stringify({ action: "call_tool", name: "xero_sales_summary", arguments: { query: userLine } }),
      usage: {
        provider: "workers-ai",
        model: "@cf/meta/llama-3.1-8b-instruct",
        latencyMs: 8,
        promptTokens: 40,
        completionTokens: 12,
        estimatedCostUsd: 0.0001,
      },
    };
  };
}

function recordingRuntime(): {
  runtime: IntelligenceRuntime;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push({ name: call.name, arguments: call.arguments });
        if (call.name.startsWith("outlook_")) {
          return {
            name: call.name,
            ok: true,
            latencyMs: 3,
            data: { count: 0, mailboxAddress: "info@elvexpropertyservices.com", messages: [] },
          };
        }
        if (call.name.startsWith("xero_")) {
          return { name: call.name, ok: true, latencyMs: 3, data: { summary: { totalSales: 12 } } };
        }
        return { name: call.name, ok: true, latencyMs: 3, data: { results: [] } };
      },
    },
  };
}

const CASES: Array<{
  id: string;
  group: "email" | "documents" | "xero" | "permissions" | "corrections";
  text: string;
  scope: string;
  toolFamily: "outlook" | "knowledge" | "xero" | "deny" | "clarify";
}> = [
  { id: "e1", group: "email", text: "Search emails", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e2", group: "email", text: "find the latest email about it", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e3", group: "email", text: "How many emails has Sharon sent today?", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e4", group: "email", text: "How many emails has Sharon sent today", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e5", group: "email", text: "Show the newest emails", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e6", group: "email", text: "Search the mailbox for survey", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e7", group: "email", text: "Any mail from the office today?", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e8", group: "email", text: "Open the latest Outlook message", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e9", group: "email", text: "Count emails about invoices", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "d1", group: "documents", text: "What is the PO process", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "d2", group: "documents", text: "What is the po process", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "d3", group: "documents", text: "Po process", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "d4", group: "documents", text: "Purchase order process", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "d5", group: "documents", text: "Show me the newest OneDrive files", scope: "SYSTEM_META", toolFamily: "knowledge" },
  { id: "d6", group: "documents", text: "what are the latest changed SharePoint documents", scope: "SYSTEM_META", toolFamily: "knowledge" },
  { id: "d7", group: "documents", text: "Find the staff handbook", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "d8", group: "documents", text: "Search documents for the mileage policy", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "x1", group: "xero", text: "Tell me Xero sales this month", scope: "BUSINESS_SYSTEM", toolFamily: "xero" },
  { id: "x2", group: "xero", text: "what are our Xero sales this month?", scope: "BUSINESS_SYSTEM", toolFamily: "xero" },
  { id: "x3", group: "xero", text: "Show overdue invoices", scope: "BUSINESS_SYSTEM", toolFamily: "xero" },
  { id: "x4", group: "xero", text: "What is outstanding in Xero?", scope: "BUSINESS_SYSTEM", toolFamily: "xero" },
  { id: "p1", group: "permissions", text: "Search emails in info@", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "p2", group: "permissions", text: "Show finance emails", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "p3", group: "permissions", text: "Tell me Xero sales this month", scope: "BUSINESS_SYSTEM", toolFamily: "xero" },
  { id: "c1", group: "corrections", text: "No, I meant email", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "c2", group: "corrections", text: "Search documents instead", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "c3", group: "corrections", text: "That's not what I asked", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
  { id: "c4", group: "corrections", text: "Look in emails instead", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "e10", group: "email", text: "emails from Sharon today", scope: "BUSINESS_SYSTEM", toolFamily: "outlook" },
  { id: "d9", group: "documents", text: "Where is the purchase order process written down?", scope: "COMPANY_KNOWLEDGE", toolFamily: "knowledge" },
];

describe("EL WhatsApp shared connector routing", () => {
  it("covers at least 30 capability cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("classifies each case onto the intended capability family", () => {
    const misses: string[] = [];
    for (const testCase of CASES) {
      const state = buildConversationState({
        userText: testCase.text,
        connectors: EL.map((row) => row.definitionId),
        userCorrection: testCase.group === "corrections" && /not what I asked|meant|instead/i.test(testCase.text),
      });
      const decision = classifyScope(testCase.text, state);
      const family =
        decision.tool?.startsWith("outlook_") || decision.lastUserIntent === "email"
          ? "outlook"
          : decision.tool?.startsWith("xero_")
            ? "xero"
            : decision.clarify
              ? "clarify"
              : "knowledge";
      const ok = decision.scope === testCase.scope && family === testCase.toolFamily;
      if (!ok) {
        misses.push(
          `${testCase.id} "${testCase.text}" intended=${testCase.scope}/${testCase.toolFamily} got=${decision.scope}/${family}/${decision.tool}`,
        );
      }
    }
    if (misses.length) throw new Error(misses.join("\n"));
  });

  it("never lets a Xero-hungry model execute Xero on email or process asks", async () => {
    for (const text of [
      "Search emails",
      "How many emails has Sharon sent today?",
      "What is the PO process",
      "Purchase order process",
    ]) {
      const { runtime, calls } = recordingRuntime();
      const result = await runIntelligenceTurn({
        text,
        state: buildConversationState({
          userText: text,
          connectors: EL.map((row) => row.definitionId),
          permittedTools: [
            "outlook_search_mailbox",
            "outlook_list_messages",
            "xero_sales_summary",
            "search_company_knowledge",
          ],
        }),
        runtime,
        completer: xeroHungryCompleter(),
      });
      expect(calls.some((call) => call.name.startsWith("xero_")), text).toBe(false);
      expect(result.toolCalls.some((call) => call.name.startsWith("xero_")), text).toBe(false);
    }
  });

  it("still executes Xero for an authorised live sales question", async () => {
    const { runtime, calls } = recordingRuntime();
    await runIntelligenceTurn({
      text: "Tell me Xero sales this month",
      state: buildConversationState({
        userText: "Tell me Xero sales this month",
        connectors: EL.map((row) => row.definitionId),
        permittedTools: ["xero_sales_summary", "outlook_search_mailbox"],
      }),
      runtime,
      completer: xeroHungryCompleter(),
    });
    expect(calls.some((call) => call.name.startsWith("xero_"))).toBe(true);
  });

  it("honours scoped Outlook over a Xero tool request", () => {
    const scoped = classifyScope(
      "How many emails has Sharon sent today?",
      buildConversationState({ userText: "How many emails has Sharon sent today?" }),
    );
    const honoured = honourScopedToolCall(scoped, "xero_sales_summary");
    expect(honoured.overridden).toBe(true);
    expect(honoured.name.startsWith("outlook_")).toBe(true);
  });

  it("does not recover email or process failures as Xero", () => {
    expect(shouldRecoverAsFinance("How many emails has Sharon sent today?", { scope: "BUSINESS_SYSTEM", lastAnswerTopic: "email", lastUserIntent: "email" })).toBe(false);
    expect(shouldRecoverAsEmail("How many emails has Sharon sent today?", { scope: "BUSINESS_SYSTEM", lastAnswerTopic: "email", lastUserIntent: "email" })).toBe(true);
    expect(shouldRecoverAsFinance("What is the PO process", { scope: "COMPANY_KNOWLEDGE", lastAnswerTopic: "company_knowledge", lastUserIntent: "company_knowledge" })).toBe(false);
    expect(shouldRecoverAsFinance("Tell me Xero sales this month", { scope: "BUSINESS_SYSTEM", lastAnswerTopic: "finance", lastUserIntent: "finance" })).toBe(true);
  });

  it("resolves a unique Sharon from the company directory and does not invent an address", () => {
    expect(extractSenderHint("How many emails has Sharon sent today?")).toBe("Sharon");
    const resolved = resolveCompanyPerson(SHARON, "Sharon");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.person.email).toBe("sharon@elvexpropertyservices.com");
    }
    expect(resolveCompanyPerson([], "Sharon").status).toBe("none");
    expect(resolveCompanyPerson(
      [
        { displayName: "Sharon Smith", email: "sharon.smith@example.com" },
        { displayName: "Sharon Jones", email: "sharon.jones@example.com" },
      ],
      "Sharon",
    ).status).toBe("ambiguous");
    const prepared = prepareOutlookSearchArguments("How many emails has Sharon sent today?", SHARON);
    expect(prepared.fromEmail).toBe("sharon@elvexpropertyservices.com");
    expect(prepared.fromDate).toBeTruthy();
    expect(prepared.toDate).toBe(prepared.fromDate);
  });

  it("picks list vs search from capability, not a hardcoded prompt list", () => {
    expect(pickOutlookReadTool("Show the newest emails")).toBe("outlook_list_messages");
    expect(pickOutlookReadTool("How many emails has Sharon sent today?")).toBe("outlook_search_mailbox");
  });

  it("attributes Outlook usage to microsoft and Xero usage to xero", () => {
    expect(connectorFamilyFromAction("outlook.mail.search", "outlook_search_mailbox")).toBe("microsoft");
    expect(connectorFamilyFromAction("outlook.mail.read", "outlook_list_messages")).toBe("microsoft");
    expect(connectorFamilyFromAction("xero.sales.summary", "xero_sales_summary")).toBe("xero");
    expect(connectorFamilyFromAction("knowledge.search", "search_company_knowledge")).toBe("knowledge");
  });

  it("keeps Elvex RBAC: office staff may read info mail, not finance mail or Xero", () => {
    expect(
      elvexAllowsAction("office_staff", "outlook.search", { mailboxAddress: "info@elvexpropertyservices.com" }).allowed,
    ).toBe(true);
    expect(
      elvexAllowsAction("office_staff", "outlook.search", { mailboxAddress: "finance@elvexpropertyservices.com" }).allowed,
    ).toBe(false);
    expect(elvexAllowsAction("office_staff", "xero.sales.read").allowed).toBe(false);
    expect(elvexAllowsAction("director", "xero.sales.read").allowed).toBe(true);
  });

  it("agrees ChatGPT / Portal / WhatsApp intent on the same EL prompts", () => {
    for (const text of [
      "Search emails",
      "How many emails has Sharon sent today?",
      "What is the PO process",
      "Tell me Xero sales this month",
    ]) {
      const intent = resolveBusinessSystemIntent(text, { connectors: EL });
      const scoped = classifyScope(text, buildConversationState({ userText: text, connectors: EL.map((row) => row.definitionId) }));
      if (/email/i.test(text)) {
        expect(intent?.connectorDefinitionId).toBe("conn_outlook_shared");
        expect(scoped.lastUserIntent).toBe("email");
        expect(xeroAllowedForQuery(text)).toBe(false);
      } else if (/PO process/i.test(text)) {
        expect(intent).toBeNull();
        expect(scoped.scope).toBe("COMPANY_KNOWLEDGE");
        expect(xeroAllowedForQuery(text)).toBe(false);
      } else {
        expect(intent?.capability).toBe("xero");
        expect(scoped.tool?.startsWith("xero_")).toBe(true);
        expect(xeroAllowedForQuery(text)).toBe(true);
      }
    }
  });
});
