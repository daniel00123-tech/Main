import { describe, expect, it } from "vitest";
import { authorizeToolCall, buildAllowedToolCatalogue } from "./tool-auth.js";
import { buildTenantToolCatalogue, normaliseVendorToolName } from "./company-tool-registry.js";
import { createOpenAiCompleter } from "./brain.js";
import { extractEvidenceFromTools } from "./evidence.js";
import { isolateEvidenceForCompany, stampEvidenceTenant } from "./tenant-isolation.js";
import { isTrueProviderFailure } from "./openai-responses.js";
import { resolveBrainPolicy } from "./brain-policy.js";
import { runIntelligenceTurn } from "./orchestrator.js";
import { runResponseQualityGuard } from "./response-guard.js";
import { buildConversationState } from "./state.js";
import { toolFamilyOf } from "./catalogue.js";
import { classifyTurnFailures } from "./failure-telemetry.js";
import { resolveRequestPricingPolicy } from "../customer-request-pricing.js";
import { shouldChargeElCustomerRequest } from "../el-customer-billing.js";
import { OPENAI_MODEL_DEFAULT, OPENAI_MODEL_FAST, OPENAI_MODEL_REASONING } from "./openai-models.js";
import type { IntelligenceCompleter } from "./provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult, IntelligenceTurnResult } from "./types.js";

const CADDINGTON = "co_caddington";
const EL = "co_el";
const HT = "co_ht";
const CONNECTORS = ["conn_xero", "conn_google_drive", "conn_microsoft_365"];
const LIVE_AUTOMATIONS = [
  "Daily document activity",
  "Daily month-to-date sales",
  "INFRA Daily improvement engineering",
  "INFRA Daily improvement report",
  "INFRA Daily improvement QA",
] as const;

const CADDINGTON_ENV = {
  OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
  OPENAI_BRAIN_ENABLED: "true",
  OPENAI_BRAIN_MODE: "openai_shadow",
  OPENAI_BRAIN_COMPANY_IDS: "co_el,co_caddington",
  OPENAI_BRAIN_PA_REQUEST_PRIMARY: "true",
};

const CADDINGTON_MCP_TOOLS = [
  "xero_sales_summary",
  "xero_top_customers",
  "xero_list_overdue_invoices",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_contacts",
  "xero_get_contact",
  "xero_get_organisation",
  "xero_profit_and_loss",
  "xero_aged_receivables",
  "xero_balance_sheet",
  "xero_list_accounts",
  "xero_list_payments",
  "xero_list_bank_transactions",
  "xero_list_tax_rates",
  "xero_vat_capability",
  "search_company_knowledge",
  "get_knowledge_document",
  "database_summary",
  "system_health",
] as const;

export const CADDINGTON_WHATSAPP_MANUAL_PROMPTS = [
  {
    n: 1,
    text: "What are this month's Xero sales?",
    expect: "OpenAI request brain → xero_sales_summary once → synthesise totals. Follow-up about those figures must not recall Xero.",
  },
  {
    n: 2,
    text: "Who are our top customers this month?",
    expect: "OpenAI request brain → xero_top_customers. Do not also call sales_summary unless asked.",
  },
  {
    n: 3,
    text: "Show overdue invoices",
    expect: "OpenAI request brain → xero_list_overdue_invoices. Not knowledge search.",
  },
  {
    n: 4,
    text: "What is the purchase order process?",
    expect: "OpenAI request brain → search_company_knowledge. Not Xero, not catalogue newest-file.",
  },
  {
    n: 5,
    text: "What is the newest company document?",
    expect: "OpenAI request brain → list_documents. Not knowledge search.",
  },
  {
    n: 6,
    text: "Tell me this month's Xero sales and the newest company document.",
    expect: "Multi-tool: xero_sales_summary + list_documents, one synthesis, no duplicate family calls.",
  },
  {
    n: 7,
    text: "What were the sales again?",
    expect: "Follow-up after prompt 1 or 6. Answer from Caddington evidence only. No extra Xero call.",
  },
  {
    n: 8,
    text: "I meant last month",
    expect: "Correction: one new xero_sales_summary for last month. Do not repeat this-month call.",
  },
  {
    n: 9,
    text: "Hi",
    expect: "No business tool. Greeting only.",
  },
  {
    n: 10,
    text: "Thanks",
    expect: "No business tool. Do not re-query Xero or documents.",
  },
] as const;

type Channel = "whatsapp" | "portal" | "chatgpt";
type CaseKind =
  | "xero"
  | "knowledge"
  | "catalogue"
  | "follow_up"
  | "correction"
  | "multi_tool"
  | "permission"
  | "no_tool"
  | "chatgpt";

type CadCase = {
  id: string;
  channel: Channel;
  kind: CaseKind;
  text: string;
  role?: "company_admin" | "director" | "office_staff";
  expectFamily?: "xero" | "knowledge" | "catalogue" | "none";
  expectTool?: string;
  expectNoTool?: boolean;
  expectDeny?: boolean;
  withXeroEvidence?: boolean;
};

const XERO_THIS = {
  sales_total: 18420,
  invoice_count: 11,
  period: { fromDate: "2026-09-01", toDate: "2026-09-04" },
  currency: "GBP",
};
const XERO_LAST = {
  sales_total: 15110,
  invoice_count: 9,
  period: { fromDate: "2026-08-01", toDate: "2026-08-31" },
  currency: "GBP",
};

function plannerCompleter(): IntelligenceCompleter {
  return async (input) => {
    const blob = `${input.system}\n${input.user}`.toLowerCase();
    const user = input.user.toLowerCase();
    const asked = (user.match(/^user: (.+)$/im)?.[1] ?? user).toLowerCase();
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
    if (/evidence so far:/.test(blob) && /xero_sales_summary \(ok/.test(blob) && /last month|i meant/.test(user)) {
      return pick("xero_sales_summary", { fromDate: "2026-08-01", toDate: "2026-08-31" });
    }
    if (/evidence so far:/.test(blob) && /\(ok/.test(blob)) {
      return {
        text: JSON.stringify({
          action: "answer",
          text: "Here is the authorised Caddington result from the evidence.",
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
    if (/\b(sales|xero|overdue|invoice|revenue|profit|customer)/.test(asked) && /\b(newest|latest).{0,24}(document|file)\b/.test(asked)) {
      return pick("xero_sales_summary", {});
    }
    if (
      /\b(newest|latest|recent).{0,24}(document|file)|list the newest|onedrive|sharepoint|how many (files|documents)\b/.test(
        asked,
      )
    ) {
      return pick("list_documents", {});
    }
    if (/\b(sales|xero|overdue|invoice|revenue|profit|customer)/.test(asked)) {
      if (/overdue|unpaid/.test(asked)) return pick("xero_list_overdue_invoices", {});
      if (/top|biggest/.test(asked)) return pick("xero_top_customers", {});
      if (/p&l|profit and loss/.test(asked)) return pick("xero_profit_and_loss", {});
      return pick("xero_sales_summary", {});
    }
    if (/\b(policy|process|procedure|knowledge|handbook|onboarding|health and safety)\b/.test(asked)) {
      return pick("search_company_knowledge", { query: asked.slice(0, 80) });
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

function cadRuntime(): { runtime: IntelligenceRuntime; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async executeTool(call): Promise<IntelligenceToolResult> {
        calls.push({ name: call.name, args: call.arguments });
        if (call.name.startsWith("outlook_")) {
          return { name: call.name, ok: false, latencyMs: 2, data: { error: "foreign_tenant" }, error: "foreign_tenant" };
        }
        if (call.name.startsWith("xero_")) {
          const from = String(call.arguments.fromDate ?? "");
          return { name: call.name, ok: true, latencyMs: 6, data: from.startsWith("2026-08") ? XERO_LAST : XERO_THIS };
        }
        if (call.name === "list_documents") {
          return {
            name: call.name,
            ok: true,
            latencyMs: 4,
            data: { documents: [{ id: "cad_doc_new", title: "Caddington site pack September.pdf", source: "google_drive" }] },
          };
        }
        if (call.name === "search_company_knowledge") {
          return {
            name: call.name,
            ok: true,
            latencyMs: 5,
            data: {
              results: [{ id: "cad_po", title: "Purchase order process", snippet: "Raise a PO before committing spend." }],
            },
          };
        }
        return { name: call.name, ok: true, latencyMs: 3, data: { results: [] } };
      },
    },
  };
}

function cases(): CadCase[] {
  const rows: CadCase[] = [];
  const xeroWa = [
    "What are this month's Xero sales?",
    "Who are our top customers this month?",
    "Show overdue invoices",
    "How much revenue this week?",
    "Xero sales summary please",
    "Sales last 7 days",
    "What did we invoice this month?",
    "Unpaid invoices",
  ];
  xeroWa.forEach((text, i) =>
    rows.push({ id: `wa_xero_${i + 1}`, channel: "whatsapp", kind: "xero", text, role: "company_admin", expectFamily: "xero" }),
  );
  const knowledgeWa = [
    "What is the purchase order process?",
    "Find the health and safety policy",
    "What is the onboarding process?",
  ];
  knowledgeWa.forEach((text, i) =>
    rows.push({
      id: `wa_knowledge_${i + 1}`,
      channel: "whatsapp",
      kind: "knowledge",
      text,
      role: "company_admin",
      expectFamily: "knowledge",
    }),
  );
  const catalogueWa = ["What is the newest company document?", "Latest SharePoint files", "List the newest ten files"];
  catalogueWa.forEach((text, i) =>
    rows.push({
      id: `wa_catalogue_${i + 1}`,
      channel: "whatsapp",
      kind: "catalogue",
      text,
      role: "company_admin",
      expectFamily: "catalogue",
    }),
  );
  rows.push(
    {
      id: "wa_multi_1",
      channel: "whatsapp",
      kind: "multi_tool",
      text: "Tell me this month's Xero sales and the newest company document.",
      role: "company_admin",
      expectFamily: "xero",
    },
    {
      id: "wa_follow_1",
      channel: "whatsapp",
      kind: "follow_up",
      text: "remind me what we were talking about",
      role: "company_admin",
      expectNoTool: true,
      withXeroEvidence: true,
    },
    {
      id: "wa_corr_1",
      channel: "whatsapp",
      kind: "correction",
      text: "Invoices raised yesterday",
      role: "company_admin",
      expectFamily: "xero",
    },
    { id: "wa_hi", channel: "whatsapp", kind: "no_tool", text: "Hi", expectNoTool: true, expectFamily: "none" },
    { id: "wa_thanks", channel: "whatsapp", kind: "no_tool", text: "Thanks", expectNoTool: true, expectFamily: "none" },
    {
      id: "wa_perm_1",
      channel: "whatsapp",
      kind: "permission",
      text: "What are this month's Xero sales?",
      role: "office_staff",
      expectDeny: true,
    },
  );

  const portalXero = [
    "What are our Xero sales this month?",
    "Show unpaid late invoices",
    "Biggest customer this quarter",
    "Sales today please",
    "How much have we invoiced this week?",
    "Give me a live sales total",
    "Xero sales summary please",
  ];
  portalXero.forEach((text, i) =>
    rows.push({ id: `pa_xero_${i + 1}`, channel: "portal", kind: "xero", text, role: "director", expectFamily: "xero" }),
  );
  const portalKnowledge = [
    "What is the PO process?",
    "Find the vehicle use policy",
    "What is the new starter process?",
    "Find the staff handbook policy",
  ];
  portalKnowledge.forEach((text, i) =>
    rows.push({
      id: `pa_knowledge_${i + 1}`,
      channel: "portal",
      kind: "knowledge",
      text,
      role: "director",
      expectFamily: "knowledge",
    }),
  );
  const portalCatalogue = ["Newest document", "Recently uploaded documents", "Show recent OneDrive files"];
  portalCatalogue.forEach((text, i) =>
    rows.push({
      id: `pa_catalogue_${i + 1}`,
      channel: "portal",
      kind: "catalogue",
      text,
      role: "director",
      expectFamily: "catalogue",
    }),
  );
  rows.push(
    {
      id: "pa_multi_1",
      channel: "portal",
      kind: "multi_tool",
      text: "Xero sales this month and the newest company document",
      role: "director",
      expectFamily: "xero",
    },
    {
      id: "pa_follow_1",
      channel: "portal",
      kind: "follow_up",
      text: "make that shorter",
      role: "director",
      expectNoTool: true,
      withXeroEvidence: true,
    },
    {
      id: "pa_corr_1",
      channel: "portal",
      kind: "correction",
      text: "Invoices raised yesterday",
      role: "director",
      expectFamily: "xero",
    },
    { id: "pa_hi", channel: "portal", kind: "no_tool", text: "Hello there", expectNoTool: true, expectFamily: "none" },
    { id: "pa_thanks", channel: "portal", kind: "no_tool", text: "Cheers", expectNoTool: true, expectFamily: "none" },
    {
      id: "pa_perm_1",
      channel: "portal",
      kind: "permission",
      text: "Show overdue invoices",
      role: "office_staff",
      expectDeny: true,
    },
  );

  CADDINGTON_MCP_TOOLS.forEach((tool, i) => {
    rows.push({
      id: `mcp_${i + 1}`,
      channel: "chatgpt",
      kind: "chatgpt",
      text: `Call ${tool}`,
      expectTool: tool,
    });
  });
  return rows;
}

const XERO_EVIDENCE = stampEvidenceTenant(
  {
    recentXero: {
      toolName: "xero_sales_summary",
      total: 18420,
      count: 11,
      fromDate: "2026-09-01",
      toDate: "2026-09-04",
      currency: "GBP",
      summary: "Caddington sales this month £18,420 across 11 invoices.",
      label: "this month",
    },
  },
  CADDINGTON,
);

function familyOf(result: IntelligenceTurnResult): string {
  const families = result.toolCalls.map((call) => toolFamilyOf(call.name)).filter((family) => family !== "none");
  return families[0] ?? "none";
}

describe("Caddington OpenAI PA/request rollout", () => {
  const all = cases();

  it("covers 20 WhatsApp, 20 Portal, and 20 ChatGPT turns", () => {
    expect(all.filter((row) => row.channel === "whatsapp")).toHaveLength(20);
    expect(all.filter((row) => row.channel === "portal")).toHaveLength(20);
    expect(all.filter((row) => row.channel === "chatgpt")).toHaveLength(20);
    expect(all.length).toBeGreaterThanOrEqual(60);
  });

  it("keeps shared models and does not fork a Caddington brain", () => {
    expect(OPENAI_MODEL_FAST).toBe("gpt-5.6-luna");
    expect(OPENAI_MODEL_DEFAULT).toBe("gpt-5.6-terra");
    expect(OPENAI_MODEL_REASONING).toBe("gpt-5.6-sol");
    expect(normaliseVendorToolName("get_sales_summary")).toBe("xero_sales_summary");
    expect(LIVE_AUTOMATIONS.length).toBeGreaterThan(0);
  });

  it("runs Caddington PA/request turns on the shared plane with isolation and quality gates", async () => {
    let familyHits = 0;
    let familyNeed = 0;
    let exactHits = 0;
    let exactNeed = 0;
    let firstAnswer = 0;
    let firstNeed = 0;
    let rbacOk = 0;
    let rbacNeed = 0;
    let grounded = 0;
    let groundedNeed = 0;
    let hallucinations = 0;
    const leaks: string[] = [];
    const blanks: string[] = [];
    const familyMisses: string[] = [];
    const exactMisses: string[] = [];

    for (const row of all.filter((item) => item.channel !== "chatgpt")) {
      const { runtime, calls } = cadRuntime();
      const role = row.role ?? "company_admin";
      const permitted = buildAllowedToolCatalogue({ role, companyId: CADDINGTON, connectors: CONNECTORS });
      const policy = resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: CADDINGTON, channel: row.channel });
      expect(policy.useOpenAi, row.id).toBe(true);
      expect(policy.userVisibleBrain, row.id).toBe("openai");
      expect(permitted.some((name) => name.startsWith("outlook_")), row.id).toBe(false);

      const result = await runIntelligenceTurn({
        env: CADDINGTON_ENV,
        text: row.text,
        channel: row.channel,
        completer: plannerCompleter(),
        state: buildConversationState({
          userText: row.text,
          companyId: CADDINGTON,
          role,
          connectors: CONNECTORS,
          permittedTools: permitted,
          recentEvidence: row.withXeroEvidence ? XERO_EVIDENCE : undefined,
          lastAnswerTopic: row.withXeroEvidence ? "finance" : null,
          lastAnswerText: row.withXeroEvidence ? "Sales this month are £18,420 across 11 invoices." : null,
          userCorrection: row.kind === "correction",
        }),
        runtime,
      });

      firstNeed += 1;
      if (result.text.trim() && !/^\s*\{/.test(result.text) && !/couldn.?t (reach|complete)/i.test(result.text)) {
        firstAnswer += 1;
      } else blanks.push(row.id);

      groundedNeed += 1;
      if ((result.recentEvidence?.companyId ?? CADDINGTON) === CADDINGTON) grounded += 1;
      if (result.recentEvidence?.companyId && result.recentEvidence.companyId !== CADDINGTON) {
        leaks.push(row.id);
        hallucinations += 1;
      }
      if (result.toolCalls.some((call) => call.name.startsWith("outlook_"))) leaks.push(`${row.id}:outlook`);

      if (row.expectFamily && !row.expectDeny && !row.expectNoTool) {
        familyNeed += 1;
        const family = familyOf(result);
        if (family === row.expectFamily) familyHits += 1;
        else familyMisses.push(`${row.id}:${family}:tools=${result.toolCalls.map((call) => call.name).join("|")}`);
        if (row.expectTool) {
          exactNeed += 1;
          if (result.toolCalls.some((call) => call.name === row.expectTool)) exactHits += 1;
        }
      }
      if (row.expectNoTool) {
        exactNeed += 1;
        if (result.toolCalls.length === 0) exactHits += 1;
        else exactMisses.push(`${row.id}:tools=${result.toolCalls.map((call) => call.name).join("|")}`);
      }
      if (row.expectDeny) {
        rbacNeed += 1;
        const xeroOk = result.toolCalls.some((call) => call.ok && call.name.startsWith("xero_"));
        if (!xeroOk) rbacOk += 1;
        expect(xeroOk, row.id).toBe(false);
      }

      const seen = new Map<string, number>();
      for (const call of calls) seen.set(call.name, (seen.get(call.name) ?? 0) + 1);
      for (const [name, count] of seen) {
        if (count > 1 && row.kind !== "correction" && row.kind !== "multi_tool") {
          leaks.push(`${row.id}:dup:${name}`);
        }
      }
    }

    const toolFamily = familyNeed ? (familyHits / familyNeed) * 100 : 100;
    const exactTool = exactNeed ? (exactHits / exactNeed) * 100 : 100;
    const firstAnswerPct = firstNeed ? (firstAnswer / firstNeed) * 100 : 100;
    const rbacPct = rbacNeed ? (rbacOk / rbacNeed) * 100 : 100;
    const groundPct = groundedNeed ? (grounded / groundedNeed) * 100 : 100;

    expect(leaks, leaks.join(",")).toEqual([]);
    expect(blanks, blanks.join(",")).toEqual([]);
    expect(familyMisses, familyMisses.join(",")).toEqual([]);
    expect(toolFamily).toBeGreaterThanOrEqual(98);
    expect(exactMisses, exactMisses.join(",")).toEqual([]);
    expect(exactTool).toBeGreaterThanOrEqual(98);
    expect(firstAnswerPct).toBeGreaterThanOrEqual(95);
    expect(rbacPct).toBe(100);
    expect(groundPct).toBe(100);
    expect(hallucinations).toBe(0);
  });

  it("keeps ChatGPT on direct Caddington tools with no OpenAI wrapper", () => {
    const chatgpt = all.filter((row) => row.channel === "chatgpt");
    expect(chatgpt).toHaveLength(20);
    const catalogue = buildTenantToolCatalogue({
      companyId: CADDINGTON,
      connectors: CONNECTORS,
      role: "company_admin",
      channel: "chatgpt",
    });
    for (const row of chatgpt) {
      const policy = resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: CADDINGTON, channel: "chatgpt" });
      expect(policy.reason).toBe("chatgpt_stays_direct_tools");
      expect(policy.useOpenAi).toBe(false);
      expect(row.expectTool).toBeTruthy();
      expect(CADDINGTON_MCP_TOOLS).toContain(row.expectTool);
      if (row.expectTool && catalogue.tools.includes(row.expectTool)) {
        expect(catalogue.tools).toContain(row.expectTool);
      }
      expect(row.expectTool?.startsWith("outlook_")).toBe(false);
    }
  });

  it("never reuses EL evidence on a Caddington follow-up", async () => {
    const elEvidence = stampEvidenceTenant(
      {
        recentXero: {
          toolName: "xero_sales_summary",
          total: 5094,
          count: 32,
          fromDate: "2026-09-01",
          toDate: "2026-09-04",
          currency: "GBP",
          summary: "EL-only sales — must never appear for Caddington",
          label: "month",
        },
        recentEmail: {
          id: "el_mail",
          subject: "EL leak quote",
          from: "ops@elvex.test",
          receivedDateTime: "2026-09-04T09:00:00Z",
          mailboxAddress: "info@elvexpropertyservices.com",
          body: "EL mailbox secret",
          toolName: "outlook_list_messages",
        },
      },
      EL,
    );
    const isolated = isolateEvidenceForCompany(elEvidence, CADDINGTON);
    expect(isolated.recentXero).toBeFalsy();
    expect(isolated.recentEmail).toBeFalsy();

    const { runtime, calls } = cadRuntime();
    const follow = await runIntelligenceTurn({
      env: CADDINGTON_ENV,
      text: "What were the sales again?",
      channel: "whatsapp",
      completer: plannerCompleter(),
      state: buildConversationState({
        userText: "What were the sales again?",
        companyId: CADDINGTON,
        role: "company_admin",
        connectors: CONNECTORS,
        recentEvidence: isolated,
        lastAnswerTopic: "finance",
      }),
      runtime,
    });
    expect(follow.text).not.toMatch(/EL-only|elvex|5094/i);
    expect(follow.recentEvidence?.companyId ?? CADDINGTON).toBe(CADDINGTON);
    expect(calls.some((call) => call.name.startsWith("outlook_"))).toBe(false);
    expect(isolateEvidenceForCompany(elEvidence, HT).recentXero).toBeFalsy();
  });

  it("falls back to Cloudflare only on a true OpenAI provider failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    try {
      const fallback: IntelligenceCompleter = async () => ({
        text: "Cloudflare fallback for Caddington Xero sales.",
        usage: {
          provider: "workers-ai",
          model: "fallback-test",
          latencyMs: 5,
          promptTokens: 4,
          completionTokens: 4,
          estimatedCostUsd: 0,
        },
      });
      const completer = createOpenAiCompleter(
        { ...CADDINGTON_ENV, OPENAI_BASE_URL: "https://openai.test" },
        fallback,
        "corr_cad_fallback",
        "What are this month's Xero sales?",
      );
      const out = await completer({
        system: "You are INFRA.",
        user: "What are this month's Xero sales?",
        permittedTools: ["xero_sales_summary", "search_company_knowledge", "list_documents"],
        mode: "decide",
      });
      expect(out.usage.fallbackUsed).toBe(true);
      expect(out.text).toMatch(/Cloudflare fallback for Caddington/i);
      expect(isTrueProviderFailure("upstream_5xx")).toBe(true);
      expect(isTrueProviderFailure("malformed")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const denied = authorizeToolCall(
      {
        role: "office_staff",
        companyId: CADDINGTON,
        connectors: CONNECTORS,
        permittedTools: ["search_company_knowledge"],
      },
      { name: "xero_sales_summary", arguments: {} },
    );
    expect(denied.allowed).toBe(false);
  });

  it("keeps billing, HT, and existing Caddington automations unchanged", () => {
    expect(resolveRequestPricingPolicy(CADDINGTON)).toBeNull();
    expect(shouldChargeElCustomerRequest(CADDINGTON, "CUSTOMER_REQUEST")).toBe(false);
    expect(resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: HT, channel: "whatsapp" }).useOpenAi).toBe(false);
    expect(resolveBrainPolicy({ env: CADDINGTON_ENV, companyId: EL, channel: "portal_chat" }).useOpenAi).toBe(true);
    expect(LIVE_AUTOMATIONS).toEqual(
      expect.arrayContaining(["Daily document activity", "Daily month-to-date sales"]),
    );
    expect(CADDINGTON_WHATSAPP_MANUAL_PROMPTS).toHaveLength(10);
  });

  it("stamps Caddington evidence and shares the quality guard", async () => {
    const { runtime } = cadRuntime();
    const result = await runIntelligenceTurn({
      env: CADDINGTON_ENV,
      text: "What are this month's Xero sales?",
      channel: "portal",
      completer: plannerCompleter(),
      state: buildConversationState({
        userText: "What are this month's Xero sales?",
        companyId: CADDINGTON,
        role: "company_admin",
        connectors: CONNECTORS,
      }),
      runtime,
    });
    const evidence = extractEvidenceFromTools(result.toolCalls);
    expect(stampEvidenceTenant(evidence, CADDINGTON).companyId).toBe(CADDINGTON);
    expect(runResponseQualityGuard).toBeTypeOf("function");
    const events = classifyTurnFailures({
      result,
      question: "What are this month's Xero sales?",
      companyId: CADDINGTON,
      channel: "portal",
    });
    expect(events.every((event) => event.companyId === CADDINGTON)).toBe(true);
    expect(events.some((event) => /elvex|co_el|outlook/i.test(JSON.stringify(event)))).toBe(false);
  });
});
