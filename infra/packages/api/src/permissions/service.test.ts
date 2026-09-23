import { describe, expect, it } from "vitest";
import {
  evaluateActionPermission,
  getUserCompanyRole,
  isRolePermissionEditable,
  userHasCompanyAccess,
} from "../permissions/service";
import type { SessionUser } from "../auth/session";

const engineerUser: SessionUser = {
  userId: "user_engineer",
  email: "engineer@example.com",
  displayName: "Engineer",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_el", role: "engineer" }],
};

const adminUser: SessionUser = {
  userId: "user_admin",
  email: "admin@example.com",
  displayName: "Admin",
  isPlatformAdmin: true,
  memberships: [],
};

const mockDb = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
    }),
  }),
} as unknown as D1Database;

const william: SessionUser = {
  userId: "user_william",
  email: "william@elvexpropertyservices.com",
  displayName: "William",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_el", role: "office_staff" }],
};

describe("permission service", () => {
  it("denies cross-company access", () => {
    expect(userHasCompanyAccess(engineerUser, "co_ht")).toBe(false);
    expect(userHasCompanyAccess(engineerUser, "co_el")).toBe(true);
  });

  it("allows platform admin across companies", () => {
    expect(userHasCompanyAccess(adminUser, "co_ht")).toBe(true);
    expect(getUserCompanyRole(adminUser, "co_ht")).toBe("company_admin");
  });

  it("allows engineer read actions", async () => {
    const decision = await evaluateActionPermission(
      mockDb,
      engineerUser,
      "co_el",
      "bigchange.jobs.read_assigned",
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies engineer financial writes", async () => {
    const decision = await evaluateActionPermission(
      mockDb,
      engineerUser,
      "co_el",
      "bigchange.invoices.create",
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies actions for other companies", async () => {
    const decision = await evaluateActionPermission(
      mockDb,
      engineerUser,
      "co_ht",
      "knowledge.search",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not a member");
  });

  it("protects company_admin role from override editing", () => {
    expect(isRolePermissionEditable("company_admin")).toBe(false);
    expect(isRolePermissionEditable("engineer")).toBe(true);
  });

  it("enforces Elvex office_staff matrix from live INFRA role", async () => {
    expect((await evaluateActionPermission(mockDb, william, "co_el", "knowledge.search")).allowed).toBe(true);
    expect((await evaluateActionPermission(mockDb, william, "co_el", "knowledge.read")).allowed).toBe(true);
    expect((await evaluateActionPermission(mockDb, william, "co_el", "xero.invoices.read")).allowed).toBe(false);
    expect((await evaluateActionPermission(mockDb, william, "co_el", "xero.reports.profit_and_loss")).allowed).toBe(false);
    expect(
      (
        await evaluateActionPermission(mockDb, william, "co_el", "knowledge.search", {
          mailboxAddress: "info@elvexpropertyservices.com",
        })
      ).allowed,
    ).toBe(true);
  });

  it("allows finance_team Xero sales summary and top customers", async () => {
    const finance: SessionUser = {
      ...william,
      memberships: [{ companyId: "co_el", role: "finance_team" }],
    };
    expect((await evaluateActionPermission(mockDb, finance, "co_el", "xero.sales.summary" as never)).allowed).toBe(true);
    expect((await evaluateActionPermission(mockDb, finance, "co_el", "xero.top_customers" as never)).allowed).toBe(true);
    expect((await evaluateActionPermission(mockDb, finance, "co_el", "xero.invoices.search")).allowed).toBe(true);
    expect((await evaluateActionPermission(mockDb, william, "co_el", "xero.sales.summary" as never)).allowed).toBe(false);
  });

  it("denies finance mailbox for office_staff", async () => {
    const decision = await evaluateActionPermission(
      mockDb,
      william,
      "co_el",
      "outlook.search" as never,
      { mailboxAddress: "finance@elvexpropertyservices.com" },
    );
    expect(decision.allowed).toBe(false);
  });

  it("keeps office_staff info mailbox allowed and admin/payments denied", async () => {
    expect(
      (
        await evaluateActionPermission(mockDb, william, "co_el", "outlook.search" as never, {
          mailboxAddress: "info@elvexpropertyservices.com",
        })
      ).allowed,
    ).toBe(true);
    expect((await evaluateActionPermission(mockDb, william, "co_el", "admin.users.manage" as never)).allowed).toBe(
      false,
    );
    expect(
      (await evaluateActionPermission(mockDb, william, "co_el", "xero.payments.allocate")).allowed,
    ).toBe(false);
  });
});
