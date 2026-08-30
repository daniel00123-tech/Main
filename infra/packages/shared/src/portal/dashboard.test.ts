import { describe, expect, it } from "vitest";
import {
  buildCustomerAttention,
  deriveGettingStartedItems,
  gettingStartedProgress,
  isGettingStartedDismissed,
} from "./dashboard";
import type { CompanyOverview, ConnectorInstance } from "../types";

function overview(partial: Partial<CompanyOverview>): CompanyOverview {
  return {
    company: {
      id: "co_1",
      slug: "acme",
      name: "Acme Ltd",
      status: "active",
      primaryDomain: null,
      notes: null,
      tradingName: null,
      companyNumber: null,
      country: null,
      timezone: "Europe/London",
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
      archivedAt: null,
      currency: "GBP",
      billingMode: "test",
      mcpOnboardingStatus: null,
      primaryAdminUserId: null,
      branding: {},
      config: {},
    },
    connectorInstances: [],
    mcpEnvironments: [],
    wallet: null,
    walletCredits: { testCents: 0, paidCents: 0 },
    usageSummary: {
      requestsToday: 0,
      requestsThisMonth: 0,
      successfulThisMonth: 0,
      failedThisMonth: 0,
    },
    teamCount: 1,
    activeAiIdentityCount: 0,
    spendThisMonthCents: 0,
    recentAuditEvents: [],
    mcpOnboardingStatus: "healthy",
    gettingStartedDismissedAt: null,
    paymentMethodReady: false,
    walletSettingsConfigured: false,
    successfulRequestCount: 0,
    pendingInvitationCount: 0,
    aiClientConfigured: false,
    ...partial,
  } as CompanyOverview;
}

function connector(partial: Partial<ConnectorInstance>): ConnectorInstance {
  return {
    id: "ci_1",
    companyId: "co_1",
    connectorDefinitionId: "conn_xero",
    name: "Xero",
    status: "healthy",
    healthStatus: "healthy",
    displayAccountName: null,
    createdAt: "",
    updatedAt: "",
    ...partial,
  } as ConnectorInstance;
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
  it("starts a new company incomplete except a genuine company name", () => {
    const items = deriveGettingStartedItems({ overview: overview({}) });
    expect(items).toHaveLength(7);
    expect(items.find((item) => item.key === "profile")?.complete).toBe(true);
    expect(items.filter((item) => !item.complete).map((item) => item.key)).toEqual([
      "payment",
      "wallet",
      "connector",
      "ai",
      "team",
      "usage",
    ]);
    expect(gettingStartedProgress(items)).toEqual({
      completedCount: 1,
      totalCount: 7,
      allComplete: false,
    });
  });

  it("treats draft companies as profile-incomplete even when a name exists", () => {
    const items = deriveGettingStartedItems({
      overview: overview({
        company: {
          ...overview({}).company,
          status: "draft",
        },
      }),
    });
    expect(items.find((item) => item.key === "profile")?.complete).toBe(false);
  });

  it("does not treat Stripe customer id or paid cents as a saved payment method", () => {
    const items = deriveGettingStartedItems({
      overview: overview({
        wallet: { stripeCustomerId: "cus_123" } as CompanyOverview["wallet"],
        walletCredits: { testCents: 0, paidCents: 2500 },
        paymentMethodReady: false,
      }),
    });
    expect(items.find((item) => item.key === "payment")?.complete).toBe(false);
  });

  it("completes payment only when a valid saved payment method exists", () => {
    const items = deriveGettingStartedItems({
      overview: overview({ paymentMethodReady: true }),
    });
    expect(items.find((item) => item.key === "payment")?.complete).toBe(true);
  });

  it("completes wallet settings from configured auto-top-up, not a Stripe customer", () => {
    const incomplete = deriveGettingStartedItems({
      overview: overview({
        wallet: { stripeCustomerId: "cus_123" } as CompanyOverview["wallet"],
        walletSettingsConfigured: false,
      }),
    });
    expect(incomplete.find((item) => item.key === "wallet")?.complete).toBe(false);

    const complete = deriveGettingStartedItems({
      overview: overview({ walletSettingsConfigured: true }),
    });
    expect(complete.find((item) => item.key === "wallet")?.complete).toBe(true);
  });

  it("completes first system only for Connected or Needs attention connectors", () => {
    const disconnected = deriveGettingStartedItems({
      overview: overview({
        connectorInstances: [connector({ status: "disabled", healthStatus: "unknown" })],
      }),
    });
    expect(disconnected.find((item) => item.key === "connector")?.complete).toBe(false);

    const draft = deriveGettingStartedItems({
      overview: overview({
        connectorInstances: [connector({ status: "draft", healthStatus: "healthy" })],
      }),
    });
    expect(draft.find((item) => item.key === "connector")?.complete).toBe(false);

    const healthy = deriveGettingStartedItems({
      overview: overview({
        connectorInstances: [connector({ status: "healthy", healthStatus: "healthy" })],
      }),
    });
    expect(healthy.find((item) => item.key === "connector")?.complete).toBe(true);
  });

  it("does not treat unused default AI identities as ChatGPT/Claude connected", () => {
    const items = deriveGettingStartedItems({
      overview: overview({
        activeAiIdentityCount: 5,
        aiClientConfigured: false,
      }),
    });
    expect(items.find((item) => item.key === "ai")?.complete).toBe(false);
  });

  it("completes ChatGPT/Claude from authoritative client configuration", () => {
    const items = deriveGettingStartedItems({
      overview: overview({ aiClientConfigured: true }),
    });
    expect(items.find((item) => item.key === "ai")?.complete).toBe(true);
  });

  it("completes team members from an additional user or invitation", () => {
    expect(
      deriveGettingStartedItems({ overview: overview({ teamCount: 1 }) }).find(
        (item) => item.key === "team",
      )?.complete,
    ).toBe(false);
    expect(
      deriveGettingStartedItems({ overview: overview({ teamCount: 2 }) }).find(
        (item) => item.key === "team",
      )?.complete,
    ).toBe(true);
    expect(
      deriveGettingStartedItems({
        overview: overview({ teamCount: 1, pendingInvitationCount: 1 }),
      }).find((item) => item.key === "team")?.complete,
    ).toBe(true);
  });

  it("completes first request from lifetime successful usage, not this month only", () => {
    const thisMonthOnly = deriveGettingStartedItems({
      overview: overview({
        usageSummary: {
          requestsToday: 0,
          requestsThisMonth: 12,
          successfulThisMonth: 11,
          failedThisMonth: 0,
        },
        successfulRequestCount: 0,
      }),
    });
    expect(thisMonthOnly.find((item) => item.key === "usage")?.complete).toBe(false);

    const lifetime = deriveGettingStartedItems({
      overview: overview({ successfulRequestCount: 3 }),
    });
    expect(lifetime.find((item) => item.key === "usage")?.complete).toBe(true);
  });

  it("marks an established company complete without hardcoding a tenant", () => {
    const items = deriveGettingStartedItems({
      overview: overview({
        paymentMethodReady: true,
        walletSettingsConfigured: true,
        connectorInstances: [connector({})],
        aiClientConfigured: true,
        teamCount: 3,
        successfulRequestCount: 100,
      }),
    });
    expect(gettingStartedProgress(items).allComplete).toBe(true);
    expect(items.every((item) => item.complete)).toBe(true);
  });

  it("reads company-scoped dismissal from overview or config_json", () => {
    expect(isGettingStartedDismissed(overview({}))).toBe(false);
    expect(
      isGettingStartedDismissed(overview({ gettingStartedDismissedAt: "2026-08-28T00:00:00.000Z" })),
    ).toBe(true);
    expect(
      isGettingStartedDismissed(
        overview({
          company: {
            ...overview({}).company,
            id: "co_other",
            config: { gettingStartedDismissedAt: "2026-08-28T00:00:00.000Z" },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isGettingStartedDismissed(
        overview({
          company: {
            ...overview({}).company,
            id: "co_isolated",
            config: {},
          },
        }),
      ),
    ).toBe(false);
  });
});
