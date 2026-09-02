import { describe, expect, it } from "vitest";
import {
  businessToolForIntent,
  extractIntentText,
  resolveBusinessSystemIntent,
  xeroAllowedForQuery,
} from "./business-system-intent";

const EL_CONNECTORS = [
  { definitionId: "conn_xero", name: "Xero", connected: true },
  { definitionId: "conn_outlook_shared", name: "Outlook", connected: true },
];

describe("extractIntentText", () => {
  it("collects query fields and _meta user text", () => {
    expect(extractIntentText({ query: "tell me on xero what our sales are" })).toContain("xero");
    expect(
      extractIntentText({
        __meta: { userQuery: "what are our Xero sales this month?" },
      }),
    ).toContain("Xero");
  });
});

describe("resolveBusinessSystemIntent", () => {
  it("classifies William's explicit Xero questions as xero", () => {
    for (const query of [
      "tell me on xero what our sales are",
      "what are our Xero sales this month?",
      "show me invoices raised today",
      "what is outstanding in Xero?",
    ]) {
      const intent = resolveBusinessSystemIntent(query, { connectors: EL_CONNECTORS });
      expect(intent?.capability).toBe("xero");
      expect(intent?.connectorDefinitionId).toBe("conn_xero");
    }
  });

  it("keeps document questions about a system on the knowledge path", () => {
    expect(
      resolveBusinessSystemIntent("Where is the Xero invoice approval process written down?", {
        connectors: EL_CONNECTORS,
      }),
    ).toBeNull();
    expect(resolveBusinessSystemIntent("What is the PO process", { connectors: EL_CONNECTORS })).toBeNull();
    expect(resolveBusinessSystemIntent("Purchase order process", { connectors: EL_CONNECTORS })).toBeNull();
  });

  it("routes explicit email questions to Outlook, never Xero", () => {
    for (const query of [
      "Search emails",
      "How many emails has Sharon sent today?",
      "find the latest email about it",
    ]) {
      const intent = resolveBusinessSystemIntent(query, { connectors: EL_CONNECTORS });
      expect(intent?.connectorDefinitionId).toBe("conn_outlook_shared");
      expect(intent?.capability).not.toBe("xero");
    }
  });

  it("uses domain language only when the company has that connector", () => {
    expect(
      resolveBusinessSystemIntent("show me invoices raised today", {
        connectors: [{ definitionId: "conn_outlook_shared" }],
      }),
    ).toBeNull();
    expect(
      resolveBusinessSystemIntent("tell me on xero what our sales are", {
        connectors: [{ definitionId: "conn_outlook_shared" }],
      })?.capability,
    ).toBe("xero");
  });

  it("ranks named Outlook, BigChange, and Commusoft over knowledge", () => {
    expect(resolveBusinessSystemIntent("show me Outlook emails")?.capability).toBe("info_mailbox");
    expect(resolveBusinessSystemIntent("what jobs are in BigChange today?")?.connectorDefinitionId).toBe(
      "conn_bigchange",
    );
    expect(resolveBusinessSystemIntent("show me Commusoft work orders")?.connectorDefinitionId).toBe(
      "conn_commusoft",
    );
  });

  it("does not treat SharePoint or Drive search as a business system", () => {
    expect(resolveBusinessSystemIntent("search SharePoint for the mileage policy")).toBeNull();
    expect(resolveBusinessSystemIntent("find the handbook in Google Drive")).toBeNull();
  });

  it("maps finance mailbox and payments separately", () => {
    expect(resolveBusinessSystemIntent("Show finance emails")?.capability).toBe("finance_mailbox");
    expect(resolveBusinessSystemIntent("Make a payment")?.capability).toBe("payments");
  });

  it("routes email counts and mailbox search to Outlook, never Xero", () => {
    for (const query of [
      "Search emails",
      "How many emails has Sharon sent today?",
      "How many emails has Sharon sent today",
      "find the latest email about it",
      "search the shared mailbox",
    ]) {
      const intent = resolveBusinessSystemIntent(query, { connectors: EL_CONNECTORS });
      expect(intent?.capability).toBe("info_mailbox");
      expect(intent?.connectorDefinitionId).toBe("conn_outlook_shared");
      expect(businessToolForIntent(intent!, query)?.toolName).toBe("outlook_search_mailbox");
    }
  });

  it("keeps process and purchase-order questions on knowledge, not Xero", () => {
    for (const query of ["What is the PO process", "What is the po process", "Po process", "Purchase order process"]) {
      expect(resolveBusinessSystemIntent(query, { connectors: EL_CONNECTORS })).toBeNull();
    }
  });

  it("selects a Xero read tool, not a knowledge tool", () => {
    const intent = resolveBusinessSystemIntent("tell me on xero what our sales are")!;
    const tool = businessToolForIntent(intent, "tell me on xero what our sales are");
    expect(tool?.toolName).toBe("xero_sales_summary");
    expect(tool?.arguments).not.toHaveProperty("fromDate");
  });

  it("routes invoice-number, outstanding, overdue, and date-list questions", () => {
    const sales = resolveBusinessSystemIntent("What are our sales?", { connectors: EL_CONNECTORS })!;
    expect(businessToolForIntent(sales, "Sales today?")?.toolName).toBe("xero_sales_summary");
    expect(businessToolForIntent(sales, "Show outstanding invoices")?.toolName).toBe("xero_search_invoices");
    expect(businessToolForIntent(sales, "Show overdue invoices")?.toolName).toBe("xero_list_overdue_invoices");
    expect(businessToolForIntent(sales, "What is invoice INV-123?")?.toolName).toBe("xero_get_invoice");
    expect(businessToolForIntent(sales, "List invoices raised today")?.toolName).toBe("xero_search_invoices");
    expect(businessToolForIntent(sales, "Top five customers this month")?.toolName).toBe("xero_top_customers");
  });
});

describe("xeroAllowedForQuery", () => {
  it("allows live financial asks and blocks email and process asks", () => {
    expect(xeroAllowedForQuery("What are our sales today?")).toBe(true);
    expect(xeroAllowedForQuery("tell me on xero what our sales are")).toBe(true);
    expect(xeroAllowedForQuery("How many emails has Sharon sent today?")).toBe(false);
    expect(xeroAllowedForQuery("Search emails")).toBe(false);
    expect(xeroAllowedForQuery("What is the PO process")).toBe(false);
    expect(xeroAllowedForQuery("Purchase order process")).toBe(false);
  });
});
