import { describe, expect, it } from "vitest";
import { liveActorToSessionUser, loadLiveCompanyActor } from "./live-identity";

type Row = Record<string, unknown>;

function dbWith(row: Row | null) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as D1Database;
}

describe("live company actor", () => {
  it("denies disabled and unknown users", async () => {
    expect(await loadLiveCompanyActor(dbWith(null), "user_x", "co_el")).toBeNull();
    const disabled = await loadLiveCompanyActor(
      dbWith({
        user_id: "user_william",
        email: "william@elvexpropertyservices.com",
        display_name: "William",
        is_platform_admin: 0,
        user_status: "disabled",
        membership_id: "mem_william",
        company_id: "co_el",
        role: "office_staff",
        membership_status: "active",
        custom_role_id: null,
        team_id: null,
      }),
      "user_william",
      "co_el",
    );
    expect(disabled?.active).toBe(false);
    expect(disabled?.denyReason).toMatch(/disabled/i);
  });

  it("loads current role from INFRA, not from a token", async () => {
    const live = await loadLiveCompanyActor(
      dbWith({
        user_id: "user_william",
        email: "william@elvexpropertyservices.com",
        display_name: "William",
        is_platform_admin: 0,
        user_status: "active",
        membership_id: "mem_william",
        company_id: "co_el",
        role: "finance_team",
        membership_status: "active",
        custom_role_id: null,
        team_id: null,
      }),
      "user_william",
      "co_el",
    );
    expect(live?.active).toBe(true);
    expect(live?.role).toBe("finance_team");
    const session = liveActorToSessionUser(live!);
    expect(session.memberships[0]?.role).toBe("finance_team");
    expect(session.memberships[0]?.membershipId).toBe("mem_william");
  });
});
