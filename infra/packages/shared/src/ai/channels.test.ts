import { describe, expect, it } from "vitest";
import {
  canConnectApprovedUserChannel,
  canManageCompanyAiPolicy,
  employeeMustNotSeeSharedToken,
} from "./channels";

describe("company AI policy vs user connection", () => {
  it("lets Company Admin approve a channel and Office Staff connect after approval", () => {
    expect(canManageCompanyAiPolicy("company_admin")).toBe(true);
    expect(canManageCompanyAiPolicy("office_staff")).toBe(false);
    expect(canManageCompanyAiPolicy("office_staff", true)).toBe(true);

    expect(
      canConnectApprovedUserChannel({
        role: "office_staff",
        companyApproved: true,
        membershipStatus: "active",
        userStatus: "active",
      }).allowed,
    ).toBe(true);
  });

  it("blocks Office Staff from approving and blocks connect before approval", () => {
    expect(canManageCompanyAiPolicy("office_staff")).toBe(false);
    expect(
      canConnectApprovedUserChannel({
        role: "office_staff",
        companyApproved: false,
        membershipStatus: "active",
        userStatus: "active",
      }),
    ).toEqual({ allowed: false, reason: "Channel is not approved by your company" });
  });

  it("denies disabled and unknown users", () => {
    expect(
      canConnectApprovedUserChannel({
        role: "office_staff",
        companyApproved: true,
        userStatus: "disabled",
        membershipStatus: "active",
      }).allowed,
    ).toBe(false);
    expect(
      canConnectApprovedUserChannel({
        role: null,
        companyApproved: true,
        membershipStatus: "active",
        userStatus: "active",
      }).allowed,
    ).toBe(false);
  });

  it("never exposes a shared token to ordinary employees", () => {
    expect(employeeMustNotSeeSharedToken({ role: "office_staff" })).toBe(true);
    expect(employeeMustNotSeeSharedToken({ role: "company_admin" })).toBe(false);
  });
});
