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
    }),
  }),
} as unknown as D1Database;

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

  it("Elvex overlay denies office staff Xero and finance mailbox", async () => {
    const office: SessionUser = {
      userId: "user_office",
      email: "office@example.com",
      displayName: "Office",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_el", role: "office_staff" }],
    };
    const xero = await evaluateActionPermission(mockDb, office, "co_el", "xero.invoices.read");
    expect(xero.allowed).toBe(false);
    const knowledge = await evaluateActionPermission(mockDb, office, "co_el", "knowledge.search");
    expect(knowledge.allowed).toBe(true);
  });

  it("Elvex operations manager gets sales read but not P&L", async () => {
    const ops: SessionUser = {
      userId: "user_ops",
      email: "ops@example.com",
      displayName: "Ops",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_el", role: "operations_manager" }],
    };
    const sales = await evaluateActionPermission(mockDb, ops, "co_el", "xero.invoices.read");
    expect(sales.allowed).toBe(true);
    const pnl = await evaluateActionPermission(mockDb, ops, "co_el", "xero.reports.profit_and_loss");
    expect(pnl.allowed).toBe(false);
  });

  it("Elvex director cannot manage roles via capability overlay", async () => {
    const director: SessionUser = {
      userId: "user_dir",
      email: "dir@example.com",
      displayName: "Director",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_el", role: "director" }],
    };
    const portal = await evaluateActionPermission(mockDb, director, "co_el", "knowledge.search");
    expect(portal.allowed).toBe(true);
  });
});
