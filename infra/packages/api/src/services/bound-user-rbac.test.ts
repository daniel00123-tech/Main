import { describe, expect, it } from "vitest";
import { elvexCan } from "@infra/shared";
import { resolveBoundUserForCompany, resolveToolCapability } from "./bound-user-rbac";

function mockBoundUserDb(opts: {
  user?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
}) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("FROM users")) return opts.user ?? null;
          if (sql.includes("FROM company_memberships")) return opts.membership ?? null;
          return null;
        },
        async all() {
          if (sql.includes("FROM company_memberships")) {
            return { results: opts.membership ? [opts.membership] : [] };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
}

describe("bound-user tool capability mapping", () => {
  it("allows William office_staff knowledge and info@ mail", () => {
    expect(elvexCan("office_staff", "knowledge.engineer.read")).toBe(true);
    expect(elvexCan("office_staff", "knowledge.company.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.read")).toBe(true);
    expect(elvexCan("office_staff", "mail.info.write")).toBe(true);
    expect(resolveToolCapability("search_company_knowledge")).toBe("engineer_or_company");
    expect(resolveToolCapability("search_elvex_email", { mailbox: "info@elvexpropertyservices.com" })).toBe(
      "mail.info.read",
    );
  });

  it("denies William office_staff Xero, finance@, payments and admin", () => {
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("office_staff", "xero.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "mail.finance.read")).toBe(false);
    expect(elvexCan("office_staff", "payment.info.access")).toBe(false);
    expect(elvexCan("office_staff", "admin.portal.access")).toBe(false);
    expect(elvexCan("office_staff", "admin.roles.manage")).toBe(false);
    expect(resolveToolCapability("search_xero_invoices")).toBe("xero.sales.read");
    expect(resolveToolCapability("search_elvex_email", { mailbox: "finance@elvexpropertyservices.com" })).toBe(
      "mail.finance.read",
    );
    expect(resolveToolCapability("get_xero_financial_summary")).toBe("xero.finance.read");
  });

  it("changes permissions when the role changes", () => {
    expect(elvexCan("office_staff", "xero.sales.read")).toBe(false);
    expect(elvexCan("finance_team", "xero.sales.read")).toBe(true);
    expect(elvexCan("finance_team", "mail.finance.read")).toBe(true);
    expect(elvexCan("company_admin", "admin.roles.manage")).toBe(true);
  });
});

describe("bound identity resolution", () => {
  it("denies an unknown Microsoft identity with no INFRA user", async () => {
    const db = mockBoundUserDb({ user: null });
    const result = await resolveBoundUserForCompany(db, {
      boundUserId: "ms-guest",
      companyId: "co_el",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_identity");
      expect(result.detail).toMatch(/not an INFRA user/i);
    }
  });

  it("denies a disabled INFRA user immediately", async () => {
    const db = mockBoundUserDb({
      user: {
        id: "user_william",
        email: "william@elvexpropertyservices.com",
        display_name: "William",
        password_hash: "x",
        password_salt: "x",
        is_platform_admin: 0,
        status: "disabled",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const result = await resolveBoundUserForCompany(db, {
      boundUserId: "user_william",
      companyId: "co_el",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disabled_user");
  });

  it("denies Microsoft tenant membership without an INFRA company membership", async () => {
    const db = mockBoundUserDb({
      user: {
        id: "user_guest",
        email: "guest@elvexpropertyservices.com",
        display_name: "Guest",
        password_hash: "x",
        password_salt: "x",
        is_platform_admin: 0,
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      membership: null,
    });
    const result = await resolveBoundUserForCompany(db, {
      boundUserId: "user_guest",
      companyId: "co_el",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_membership");
      expect(result.detail).toMatch(/does not grant INFRA access/i);
    }
  });
});
