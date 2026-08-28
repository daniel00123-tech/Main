import { describe, expect, it } from "vitest";
import {
  buildCustomerAttention,
  deriveGettingStartedItems,
} from "./dashboard";
import type { CompanyOverview } from "../types";

function overview(partial: Partial<CompanyOverview>): CompanyOverview {
  return {
    company: {
      id: "co_1",
      slug: "caddington",
      name: "Caddington Holdings",
      status: "active",
      primaryDomain: null,
      notes: null,
      tradingName: null,
      companyNumber: null,
      country: null,
      timezone: null,
      primaryContactName: null,
      primaryEmail: null,
      billingEmail: null,
      telephone: null,
      logoUrl: null,
      portalSubdomain: null,
      portalHostname: null,
      provisionedAt: null,
      suspendedAt: null,
      closedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    connectorInstances: [],
    mcpEnvironments: [],
    wallet: null,
    walletCredits: { testCents: 0, paidCents: 0 },
    usageSummary: { requestsThisMonth: 0, successfulThisMonth: 0 },
    teamCount: 1,
    activeAiIdentityCount: 0,
    spendThisMonthCents: 0,
    recentAuditEvents: [],
    mcpOnboardingStatus: "healthy",
    ...partial,
  } as CompanyOverview;
}

describe("buildCustomerAttention", () => {
  it("excludes operator-only onboarding problems", () => {
    const items = buildCustomerAttention({
      companyStatus: "active",
      basePath: "/portal/caddington",
      pendingActions: 0,
      walletHealth: "healthy",
      lowBalance: false,
      onboardingProblems: [
        { id: "mcp_unhealthy", title: "AI unhealthy", detail: "Internal", href: null },
        { id: "billing_email", title: "Add billing email", detail: "Required", href: "/billing" },
      ],
    });
    expect(items.some((item) => item.id === "mcp_unhealthy")).toBe(false);
    expect(items.some((item) => item.id === "billing_email")).toBe(true);
  });

  it("prioritises pending actions as the lead item", () => {
    const items = buildCustomerAttention({
      companyStatus: "active",
      basePath: "/portal/caddington",
      pendingActions: 7,
      walletHealth: "healthy",
      lowBalance: false,
    });
    expect(items[0]?.id).toBe("pending-actions");
    expect(items[0]?.title).toBe("7 actions need attention");
  });
});

describe("deriveGettingStartedItems", () => {
  it("hides completed onboarding tasks for established companies", () => {
    const items = deriveGettingStartedItems({
      overview: overview({
        connectorInstances: [
          {
            id: "ci_1",
            companyId: "co_1",
            connectorDefinitionId: "conn_xero",
            name: "Xero",
            status: "active",
            healthStatus: "healthy",
            displayAccountName: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
        wallet: { stripeCustomerId: "cus_123" } as CompanyOverview["wallet"],
        walletCredits: { testCents: 0, paidCents: 2500 },
        activeAiIdentityCount: 2,
        teamCount: 4,
        usageSummary: { requestsThisMonth: 12, successfulThisMonth: 11 },
      }),
    });
    expect(items).toHaveLength(0);
  });
});
