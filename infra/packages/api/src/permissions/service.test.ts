import { describe, expect, it } from "vitest";
import {
  evaluateActionPermission,
  getUserCompanyRole,
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
});
