import { describe, expect, it } from "vitest";
import { businessToolForIntent, resolveBusinessSystemIntent } from "../permissions/business-system-intent";
import {
  classifyUsageOutcome,
  summarizeUsageOutcomes,
  type UsageOutcomeInput,
} from "./outcome";

const EL = { connectors: [{ definitionId: "conn_xero" }, { definitionId: "conn_outlook_shared" }] };

function denied(partial: Partial<UsageOutcomeInput>): UsageOutcomeInput {
  return {
    success: false,
    settlementStatus: "denied",
    recordedAt: "2026-09-01T21:00:00.000Z",
    actorEmail: "william@elvexpropertyservices.com",
    metadata: { denied: true, result: "permission_denied", reason: "Office Staff permissions don’t allow access" },
    ...partial,
  };
}

function fail(partial: Partial<UsageOutcomeInput>): UsageOutcomeInput {
  return {
    success: false,
    settlementStatus: "zero_charge",
    recordedAt: "2026-09-01T18:00:00.000Z",
    actorEmail: "william@elvexpropertyservices.com",
    metadata: {},
    ...partial,
  };
}

const EL_FAILURE_FIXTURES: Array<{ id: string; row: UsageOutcomeInput; kind: string; denial?: boolean }> = [
  ...Array.from({ length: 18 }, (_, i) => ({
    id: `denied-xero-sales-${i}`,
    row: denied({ toolName: "xero_sales_summary", action: "xero.sales.summary" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 13 }, (_, i) => ({
    id: `denied-finance-mailbox-${i}`,
    row: denied({
      toolName: "outlook_list_messages",
      action: "outlook.mail.read",
      metadata: { denied: true, reason: "Finance email is connected, but your current permissions don’t allow access" },
    }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `denied-search-files-${i}`,
    row: denied({ toolName: "search_elvex_files", action: "mcp.search_elvex_files" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `denied-database-summary-${i}`,
    row: denied({ toolName: "database_summary", action: "xero.sales.read" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `denied-list-docs-${i}`,
    row: denied({ toolName: "list_documents", action: "mcp.list_documents" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `denied-search-as-xero-${i}`,
    row: denied({ toolName: "search", action: "xero.sales.read" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `denied-list-company-docs-${i}`,
    row: denied({ toolName: "list_company_documents", action: "mcp.list_company_documents" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `denied-outlook-search-${i}`,
    row: denied({ toolName: "outlook_search_mailbox", action: "outlook.mail.search" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `denied-top-customers-${i}`,
    row: denied({ toolName: "xero_top_customers", action: "xero.top_customers" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  })),
  {
    id: "denied-get-invoice",
    row: denied({ toolName: "xero_get_invoice", action: "xero.invoices.get" }),
    kind: "PERMISSION_DENIED",
    denial: true,
  },
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `hist-xero-sales-${i}`,
    row: fail({ toolName: "xero_sales_summary", action: "xero.sales.summary", durationMs: i < 4 ? 12_500 : 1_900 }),
    kind: "UPSTREAM_FAILURE",
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `hist-xero-search-${i}`,
    row: fail({ toolName: "xero_search_invoices", action: "xero.invoices.search", durationMs: 1_900 }),
    kind: "UPSTREAM_FAILURE",
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `hist-xero-get-${i}`,
    row: fail({ toolName: "xero_get_invoice", action: "xero.invoices.get", durationMs: 1_900 }),
    kind: "UPSTREAM_FAILURE",
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `hist-xero-top-${i}`,
    row: fail({ toolName: "xero_top_customers", action: "xero.top_customers", durationMs: 1_900 }),
    kind: "UPSTREAM_FAILURE",
  })),
  {
    id: "hist-xero-overdue",
    row: fail({ toolName: "xero_list_overdue_invoices", action: "xero.invoices.read", durationMs: 11_900 }),
    kind: "UPSTREAM_FAILURE",
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `hist-knowledge-timeout-${i}`,
    row: fail({ toolName: "search", action: "knowledge.search", durationMs: 32_000 }),
    kind: "TIMEOUT",
  })),
  {
    id: "hist-whatsapp-knowledge",
    row: fail({
      toolName: "search_company_knowledge",
      action: "knowledge.search",
      durationMs: 2_086,
      recordedAt: "2026-08-30T13:44:09.947Z",
    } as UsageOutcomeInput),
    kind: "UNKNOWN_FAILURE",
  },
  {
    id: "probe-routing",
    row: fail({
      toolName: "system_health",
      action: "system.health",
      actorEmail: "INFRA EL routing probe",
      durationMs: 360,
      recordedAt: "2026-08-25T08:16:00.024Z",
    }),
    kind: "APPLICATION_ERROR",
  },
  {
    id: "probe-isolation",
    row: fail({
      toolName: "system_health",
      action: "system.health",
      actorEmail: "EL isolation probe",
      durationMs: 382,
      recordedAt: "2026-08-24T21:38:15.273Z",
    }),
    kind: "APPLICATION_ERROR",
  },
];

describe("EL usage outcome classification (91 production failures)", () => {
  it("classifies every production EL failure fixture", () => {
    expect(EL_FAILURE_FIXTURES.length).toBe(91);
    for (const fixture of EL_FAILURE_FIXTURES) {
      const outcome = classifyUsageOutcome(fixture.row);
      expect(outcome.kind, fixture.id).toBe(fixture.kind);
      expect(outcome.expectedDenial, fixture.id).toBe(Boolean(fixture.denial));
      if (fixture.denial) expect(outcome.operationalFailure, fixture.id).toBe(false);
    }
  });

  it("does not treat expected denials as operational failures in the EL mix", () => {
    const summary = summarizeUsageOutcomes([
      ...EL_FAILURE_FIXTURES.map((item) => item.row),
      { success: true, toolName: "xero_sales_summary", recordedAt: "2026-09-02T14:29:47.160Z" },
      { success: true, toolName: "outlook_list_messages", recordedAt: "2026-09-02T12:26:57.519Z" },
    ]);
    expect(summary.requests).toBe(93);
    expect(summary.failed).toBe(91);
    expect(summary.denied).toBe(55);
    expect(summary.operationalFailed).toBe(36);
    expect(summary.rawSuccessRate).toBeCloseTo(2 / 93, 5);
    expect(summary.operationalSuccessRate).toBeCloseTo((38 - 36) / 38, 5);
  });

  it("treats empty Xero results as a successful business outcome", () => {
    const outcome = classifyUsageOutcome({
      success: true,
      toolName: "xero_search_invoices",
      metadata: { accessOutcome: "empty_result" },
    });
    expect(outcome.kind).toBe("SUCCESS_NO_RESULTS");
    expect(outcome.noResults).toBe(true);
    expect(outcome.operationalFailure).toBe(false);
  });

  it("does not mark post-fix Xero failures as the old tool-mapping defect", () => {
    const outcome = classifyUsageOutcome({
      success: false,
      settlementStatus: "zero_charge",
      toolName: "xero_sales_summary",
      recordedAt: "2026-09-03T10:00:00.000Z",
      durationMs: 1_200,
      metadata: { error: "I couldn’t reach Xero just now." },
    });
    expect(outcome.kind).toBe("UPSTREAM_FAILURE");
    expect(outcome.historicalHint).toBeNull();
  });
});

describe("EL routing: email must not go to Xero", () => {
  const emailQuestions = [
    "search emails",
    "count emails from sharon today",
    "newest info email",
    "show me the info@ inbox",
    "any emails from suppliers this morning",
    "No, I meant email",
    "I meant the mailbox not Xero",
    "outlook inbox for today",
  ];
  it.each(emailQuestions)("routes %s to Outlook, not Xero", (text) => {
    const intent = resolveBusinessSystemIntent(text, EL);
    expect(intent?.capability === "info_mailbox" || intent?.capability === "finance_mailbox").toBe(true);
    expect(intent?.connectorDefinitionId).toBe("conn_outlook_shared");
    const tool = intent ? businessToolForIntent(intent, text) : null;
    expect(tool?.toolName.startsWith("outlook_")).toBe(true);
  });

  const xeroQuestions = [
    "sales this month",
    "Xero sales today",
    "outstanding invoices",
    "overdue invoices",
    "top 5 customers",
    "what is INV-02245",
  ];
  it.each(xeroQuestions)("routes %s to Xero", (text) => {
    const intent = resolveBusinessSystemIntent(text, EL);
    expect(intent?.capability).toBe("xero");
    const tool = intent ? businessToolForIntent(intent, text) : null;
    expect(tool?.toolName.startsWith("xero_")).toBe(true);
  });

  it("keeps PO / process questions on knowledge, not Xero", () => {
    expect(resolveBusinessSystemIntent("what is the PO process", EL)).toBeNull();
    expect(resolveBusinessSystemIntent("where is the purchase order procedure written down", EL)).toBeNull();
  });
});

const MORE_EL_CASES: Array<{ text: string; system: "outlook" | "xero" | "knowledge" }> = [
  { text: "emails from Sharon today", system: "outlook" },
  { text: "how many emails did we get this morning", system: "outlook" },
  { text: "search the info mailbox", system: "outlook" },
  { text: "open the latest email", system: "outlook" },
  { text: "who emailed info@ yesterday", system: "outlook" },
  { text: "inbox search for invoices from last week", system: "outlook" },
  { text: "No I meant the emails", system: "outlook" },
  { text: "show finance emails", system: "outlook" },
  { text: "finance@ inbox", system: "outlook" },
  { text: "sales last month on Xero", system: "xero" },
  { text: "what did we invoice this week", system: "xero" },
  { text: "who owes us money", system: "xero" },
  { text: "aged receivables", system: "xero" },
  { text: "profit and loss", system: "xero" },
  { text: "invoices raised today", system: "xero" },
  { text: "turnover this month", system: "xero" },
  { text: "how do we raise a PO", system: "knowledge" },
  { text: "purchase order policy", system: "knowledge" },
  { text: "health and safety procedure", system: "knowledge" },
  { text: "where is the onboarding handbook written", system: "knowledge" },
];

describe("EL extra routing cases", () => {
  it.each(MORE_EL_CASES)("$text → $system", ({ text, system }) => {
    const intent = resolveBusinessSystemIntent(text, EL);
    if (system === "knowledge") {
      expect(intent?.capability === "xero" || intent?.capability === "info_mailbox" || intent?.capability === "finance_mailbox").toBeFalsy();
      return;
    }
    if (system === "outlook") {
      expect(intent?.connectorDefinitionId).toBe("conn_outlook_shared");
      return;
    }
    expect(intent?.capability).toBe("xero");
  });
});
