import { describe, expect, it } from "vitest";
import {
  denyKnowledgeQueryIfProtected,
  evaluateKnowledgeBusinessSystemPreflight,
  isCapabilityConnected,
  xeroResultLooksEmpty,
} from "./capability-access";
import type { SessionUser } from "../auth/session";

const william: SessionUser = {
  userId: "user_william",
  email: "william@elvexpropertyservices.com",
  displayName: "William",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_el", role: "office_staff" }],
};

const financeUser: SessionUser = {
  userId: "user_finance",
  email: "finance@elvexpropertyservices.com",
  displayName: "Finance",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_el", role: "finance_team" }],
};

function mockDb(
  connectedDefs: string[] = ["conn_xero", "conn_outlook_shared"],
  role: "office_staff" | "finance_team" = "office_staff",
) {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM companies")) {
                return { name: "EL Business", trading_name: "EL Business" };
              }
              return {
                user_id: role === "finance_team" ? financeUser.userId : william.userId,
                email: role === "finance_team" ? financeUser.email : william.email,
                display_name: role === "finance_team" ? financeUser.displayName : william.displayName,
                is_platform_admin: 0,
                user_status: "active",
                membership_id: "membership_test",
                company_id: "co_el",
                role,
                membership_status: "active",
                custom_role_id: null,
                team_id: null,
              };
            },
            async all() {
              if (sql.includes("FROM connector_instances")) {
                return {
                  results: connectedDefs.map((id) => ({
                    connector_definition_id: id,
                    name: id.replace(/^conn_/, ""),
                    status: "healthy",
                    auth_status: "connected",
                  })),
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("capability access runtime", () => {
  it("treats Elvex Xero as connected", async () => {
    expect(await isCapabilityConnected(mockDb(), "co_el", "xero")).toBe(true);
    expect(await isCapabilityConnected(mockDb([]), "co_el", "xero")).toBe(false);
  });

  it("A: connected + allowed reroutes to the Xero tool instead of knowledge", async () => {
    const result = await evaluateKnowledgeBusinessSystemPreflight(
      mockDb(["conn_xero"], "finance_team"),
      financeUser,
      "co_el",
      "search",
      { query: "tell me on xero what our sales are" },
    );
    expect(result.kind).toBe("reroute");
    if (result.kind === "reroute") {
      expect(result.capability).toBe("xero");
      expect(result.toolName).toBe("xero_sales_summary");
    }
  });

  it("B: connected + denied returns permission_denied and does not reroute", async () => {
    const result = await evaluateKnowledgeBusinessSystemPreflight(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "tell me on xero what our sales are" },
    );
    expect(result.kind).toBe("permission_denied");
    if (result.kind === "permission_denied") {
      expect(result.denial.error).toBe("permission_denied");
      expect(result.denial.capability).toBe("xero");
      expect(result.denial.connected).toBe(true);
      expect(result.denial.message).toContain("Xero is connected");
      expect(result.denial.message).toContain("Office Staff");
      expect(result.denial.message).toContain("don’t allow access to Xero financial data");
    }
  });

  it("C: disconnected returns a not-connected message, not a knowledge search", async () => {
    const result = await evaluateKnowledgeBusinessSystemPreflight(
      mockDb([]),
      william,
      "co_el",
      "search",
      { query: "tell me on xero what our sales are" },
    );
    expect(result.kind).toBe("not_connected");
    if (result.kind === "not_connected") {
      expect(result.message).toContain("Xero isn’t connected");
      expect(result.message).not.toMatch(/permissions don’t allow/i);
    }
  });

  it("does not deny ordinary knowledge search", async () => {
    const denial = await denyKnowledgeQueryIfProtected(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "vehicle mileage policy" },
    );
    expect(denial).toBeNull();
    const preflight = await evaluateKnowledgeBusinessSystemPreflight(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "vehicle mileage policy" },
    );
    expect(preflight.kind).toBe("knowledge");
  });

  it("denies finance mailbox intent and payments intent", async () => {
    const finance = await denyKnowledgeQueryIfProtected(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "Show finance emails" },
    );
    expect(finance?.capability).toBe("finance_mailbox");
    const payments = await denyKnowledgeQueryIfProtected(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "Make a payment" },
    );
    expect(payments?.capability).toBe("payments");
  });

  it("classifies database_summary via _meta when arguments.query is empty", async () => {
    const result = await evaluateKnowledgeBusinessSystemPreflight(
      mockDb(),
      william,
      "co_el",
      "database_summary",
      { __meta: { userQuery: "tell me on xero what our sales are" } },
    );
    expect(result.kind).toBe("permission_denied");
  });

  it("E: recognises a genuine empty Xero sales payload", () => {
    expect(
      xeroResultLooksEmpty({
        summary: { transactionCount: 0, totalSales: 0 },
        transactions: [],
      }),
    ).toBe(true);
    expect(
      xeroResultLooksEmpty({
        summary: { transactionCount: 2, totalSales: 100 },
        transactions: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(false);
  });
});
