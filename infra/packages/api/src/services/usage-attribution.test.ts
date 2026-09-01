import { describe, expect, it } from "vitest";
import {
  accumulateBreakdown,
  connectorFamilyFromAction,
  normalizeSourceClient,
} from "./usage-attribution";

describe("shared usage attribution", () => {
  it("normalises AI channels without inventing identity", () => {
    expect(normalizeSourceClient("chatgpt-mcp")).toBe("chatgpt");
    expect(normalizeSourceClient("Claude")).toBe("claude");
    expect(normalizeSourceClient(null, "portal")).toBe("portal");
    expect(normalizeSourceClient("portal_chat")).toBe("portal_chat");
  });

  it("maps tools onto connector families", () => {
    expect(connectorFamilyFromAction("xero.invoices.read", "search_xero_invoices")).toBe("xero");
    expect(connectorFamilyFromAction("outlook.search", "outlook_search_mailbox")).toBe("microsoft");
    expect(connectorFamilyFromAction("knowledge.search", "search_company_knowledge")).toBe(
      "knowledge",
    );
  });

  it("attributes denied requests as non-billable", () => {
    const map = new Map();
    accumulateBreakdown(map, "user_william", "william@elvexpropertyservices.com", {
      success: false,
      denied: true,
      billable: false,
      chargeCents: 0,
    });
    expect(map.get("user_william")?.denied).toBe(1);
    expect(map.get("user_william")?.billable).toBe(0);
    expect(map.get("user_william")?.nonBillable).toBe(1);
  });
});
