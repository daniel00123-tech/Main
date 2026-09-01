import { describe, expect, it } from "vitest";
import {
  accumulateBreakdown,
  connectorFamilyFromAction,
  normalizeSourceClient,
  resolveConnectorInstanceId,
} from "./usage-attribution";

describe("shared usage attribution", () => {
  it("normalises AI channels without inventing identity", () => {
    expect(normalizeSourceClient("chatgpt-mcp")).toBe("chatgpt");
    expect(normalizeSourceClient("Claude")).toBe("claude");
    expect(normalizeSourceClient(null, "portal")).toBe("portal");
  });

  it("maps tools onto connector families", () => {
    expect(connectorFamilyFromAction("xero.invoices.read", "search_xero_invoices")).toBe("xero");
    expect(connectorFamilyFromAction("outlook.search", "outlook_search_mailbox")).toBe("microsoft");
    expect(connectorFamilyFromAction("knowledge.search", "search_company_knowledge")).toBe(
      "knowledge",
    );
  });

  it("looks up connector instances with the live D1 column names", async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() {
            return {
              async first() {
                return { id: "ci_el_xero" };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(resolveConnectorInstanceId(db, "co_el", "xero.sales.summary", "xero_sales_summary")).resolves.toBe(
      "ci_el_xero",
    );
    expect(statements[0]).toContain("connector_definition_id");
    expect(statements[0]).toContain("lower(name)");
    expect(statements[0]).not.toMatch(/\bdefinition_id\b/);
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
