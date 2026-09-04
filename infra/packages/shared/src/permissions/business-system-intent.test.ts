import { describe, expect, it } from "vitest";
import {
  businessToolForIntent,
  extractIntentText,
  resolveBusinessSystemIntent,
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

  it("selects a Xero read tool, not a knowledge tool", () => {
    const intent = resolveBusinessSystemIntent("tell me on xero what our sales are")!;
    const tool = businessToolForIntent(intent, "tell me on xero what our sales are");
    expect(tool?.toolName).toBe("xero_sales_summary");
    expect(tool?.arguments).not.toHaveProperty("fromDate");
  });

  it("keeps WhatsApp email and PO-process prompts off Xero", () => {
    expect(resolveBusinessSystemIntent("Search emails", { connectors: EL_CONNECTORS })?.capability).toBe(
      "info_mailbox",
    );
    expect(
      resolveBusinessSystemIntent("How many emails has Sharon sent today?", { connectors: EL_CONNECTORS })
        ?.capability,
    ).toBe("info_mailbox");
    expect(resolveBusinessSystemIntent("What is the PO process?", { connectors: EL_CONNECTORS })).toBeNull();
    expect(resolveBusinessSystemIntent("Tell me Xero sales this month.", { connectors: EL_CONNECTORS })?.capability).toBe(
      "xero",
    );
    expect(resolveBusinessSystemIntent("Find the newest OneDrive document.", { connectors: EL_CONNECTORS })).toBeNull();
    expect(resolveBusinessSystemIntent("Search info for INV-02268.", { connectors: EL_CONNECTORS })?.capability).toBe(
      "info_mailbox",
    );
    expect(
      resolveBusinessSystemIntent("What invoices are overdue and then show me the newest info email?", {
        connectors: EL_CONNECTORS,
      })?.capability,
    ).toBe("xero");
    expect(
      resolveBusinessSystemIntent("Sorry — I meant emails, not Xero.", { connectors: EL_CONNECTORS })?.capability,
    ).toBe("info_mailbox");
    expect(
      resolveBusinessSystemIntent("Search company files for the last email subject.", { connectors: EL_CONNECTORS }),
    ).toBeNull();
    expect(resolveBusinessSystemIntent("No, I meant email.", { connectors: EL_CONNECTORS })?.capability).toBe(
      "info_mailbox",
    );
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
