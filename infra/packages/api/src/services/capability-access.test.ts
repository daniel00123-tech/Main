import { describe, expect, it } from "vitest";
import { denyKnowledgeQueryIfProtected, isCapabilityConnected, xeroResultLooksEmpty } from "./capability-access";
import type { SessionUser } from "../auth/session";

const william: SessionUser = {
  userId: "user_william",
  email: "william@elvexpropertyservices.com",
  displayName: "William",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_el", role: "office_staff" }],
};

function mockDb(connectedDefs: string[] = ["conn_xero", "conn_outlook_shared"]) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM companies")) {
                return { name: "EL Business", trading_name: "EL Business" };
              }
              return {
                user_id: "user_william",
                email: william.email,
                display_name: "William",
                is_platform_admin: 0,
                user_status: "active",
                membership_id: "membership_william",
                company_id: "co_el",
                role: "office_staff",
                membership_status: "active",
                custom_role_id: null,
                team_id: null,
              };
            },
            async all() {
              if (sql.includes("FROM connector_instances")) {
                return {
                  results: connectedDefs.map((id) => ({ connector_definition_id: id })),
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

  it("denies a Xero sales knowledge query for office_staff without calling Xero", async () => {
    const denial = await denyKnowledgeQueryIfProtected(
      mockDb(),
      william,
      "co_el",
      "search",
      { query: "tell me on xero what our sales are" },
    );
    expect(denial?.error).toBe("permission_denied");
    expect(denial?.capability).toBe("xero");
    expect(denial?.connected).toBe(true);
    expect(denial?.message).toContain("Xero is connected");
    expect(denial?.message).toContain("don’t allow");
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

  it("recognises a genuine empty Xero sales payload", () => {
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
