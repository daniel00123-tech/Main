import { describe, expect, it } from "vitest";
import { SecretTenantMismatchError } from "./secrets/provider";
import { MemorySecretProvider } from "./secrets/memory";
import { userHasCompanyAccess } from "../permissions/service";
import type { SessionUser } from "../auth/session";
import { evaluateApprovalRequirement } from "./approvals";

const companyA: SessionUser = {
  userId: "user_a",
  email: "a@example.com",
  displayName: "Admin A",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_a", role: "company_admin" }],
};

const companyB: SessionUser = {
  userId: "user_b",
  email: "b@example.com",
  displayName: "Admin B",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_b", role: "company_admin" }],
};

describe("connector tenant isolation", () => {
  it("denies Company A access to Company B", () => {
    expect(userHasCompanyAccess(companyA, "co_b")).toBe(false);
    expect(userHasCompanyAccess(companyB, "co_a")).toBe(false);
    expect(userHasCompanyAccess(companyA, "co_a")).toBe(true);
  });

  it("rejects a guessed credential reference from another tenant", async () => {
    const provider = new MemorySecretProvider();
    const stored = await provider.store({
      companyId: "co_b",
      purpose: "connector",
      value: "b-secret",
    });
    await expect(
      provider.resolve(stored.reference, {
        companyId: "co_a",
        actor: "a@example.com",
        reason: "mcp_resolve",
      }),
    ).rejects.toBeInstanceOf(SecretTenantMismatchError);
    await expect(
      provider.rotate(stored.reference, "stolen", {
        companyId: "co_a",
        actor: "a@example.com",
        reason: "rotation",
      }),
    ).rejects.toBeInstanceOf(SecretTenantMismatchError);
  });

  it("does not treat a guessed company_id as authorisation", () => {
    expect(userHasCompanyAccess(companyA, "co_caddington")).toBe(false);
    expect(
      evaluateApprovalRequirement({
        riskClass: "write",
        action: "connector.execute",
        companyStatus: "suspended",
      }).allowed,
    ).toBe(false);
  });
});
