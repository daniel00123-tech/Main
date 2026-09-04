import { describe, expect, it } from "vitest";
import {
  advertisedToolsForActor,
  DATABASE_SUMMARY_NOT_XERO_MESSAGE,
  hideDatabaseSummaryForHumanMcp,
} from "./mcp-gateway";
import type { GatewayActor } from "./gateway";

const warehouse = {
  name: "database_summary",
  description: "warehouse",
  inputSchema: { type: "object", properties: {} },
};
const sales = {
  name: "xero_sales_summary",
  description: "sales",
  inputSchema: { type: "object", properties: {} },
};

describe("ChatGPT database_summary guard", () => {
  it("hides the knowledge warehouse tool from human MCP users", () => {
    const user: GatewayActor = {
      type: "user",
      user: {
        userId: "user_ella",
        email: "ella@elvexpropertyservices.com",
        displayName: "Ella",
        isPlatformAdmin: false,
        memberships: [],
      },
      channel: "chatgpt",
    };
    expect(hideDatabaseSummaryForHumanMcp(user)).toBe(true);
    expect(advertisedToolsForActor(user, [warehouse, sales]).map((tool) => tool.name)).toEqual([
      "xero_sales_summary",
    ]);
  });

  it("keeps database_summary for machine service identities", () => {
    const service = {
      type: "service" as const,
      identity: {
        id: "sid",
        companyId: "co_ht",
        identityType: "chatgpt",
        scopes: ["*"],
      },
    } as GatewayActor;
    expect(hideDatabaseSummaryForHumanMcp(service)).toBe(false);
    expect(advertisedToolsForActor(service, [warehouse, sales]).map((tool) => tool.name)).toEqual([
      "database_summary",
      "xero_sales_summary",
    ]);
  });

  it("does not describe the intercept as a missing sales total", () => {
    expect(DATABASE_SUMMARY_NOT_XERO_MESSAGE).toContain("xero_sales_summary");
    expect(DATABASE_SUMMARY_NOT_XERO_MESSAGE.toLowerCase()).not.toContain("no sales");
    expect(DATABASE_SUMMARY_NOT_XERO_MESSAGE.toLowerCase()).not.toContain("i can't get the sales report");
  });
});
