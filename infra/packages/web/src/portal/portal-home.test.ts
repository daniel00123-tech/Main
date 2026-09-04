import { describe, expect, it } from "vitest";
import {
  companyNavOrder,
  portalChatPath,
  portalCompanyHomePath,
  portalOverviewPath,
  resolvePortalEntryTarget,
} from "./portal-home";

describe("company portal landing", () => {
  it("sends a single-company user to Chat, not Overview", () => {
    expect(
      resolvePortalEntryTarget({
        isPlatformAdmin: false,
        membershipCompanyIds: ["co_el"],
        companies: [{ id: "co_el", slug: "el-business" }],
      }),
    ).toBe("/portal/el-business/chat");
    expect(portalCompanyHomePath("el-business")).toBe("/portal/el-business/chat");
    expect(portalOverviewPath("el-business")).toBe("/portal/el-business/dashboard");
  });

  it("preserves company selection for multi-company users and platform admins", () => {
    expect(
      resolvePortalEntryTarget({
        isPlatformAdmin: false,
        membershipCompanyIds: ["co_el", "co_ht"],
        companies: [
          { id: "co_el", slug: "el-business" },
          { id: "co_ht", slug: "heattech" },
        ],
      }),
    ).toBe("/portal/select");
    expect(
      resolvePortalEntryTarget({
        isPlatformAdmin: true,
        membershipCompanyIds: [],
        companies: [{ id: "co_el", slug: "el-business" }],
      }),
    ).toBe("/portal/select");
  });

  it("keeps Overview as a deep link and Chat first in company nav", () => {
    expect(portalChatPath("acme co", "pchat_1")).toBe("/portal/acme%20co/chat/pchat_1");
    expect(companyNavOrder()[0]).toBe("chat");
    expect(companyNavOrder()).toContain("dashboard");
    expect(companyNavOrder().indexOf("chat")).toBeLessThan(companyNavOrder().indexOf("dashboard"));
  });
});
