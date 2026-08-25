import { describe, expect, it } from "vitest";
import { buildCompanyOnboarding, deriveConnectorLifecycle } from "./onboarding";
import { deriveMcpOnboardingStatus, discoverMcpCapabilities } from "./mcp-capabilities";
import { classifyLedgerCredit } from "./wallet-credits";
import type { Company, ConnectorInstance, McpEnvironment } from "@infra/shared";

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "co_alpha",
    slug: "company-a",
    name: "Company A",
    status: "onboarding",
    primaryDomain: null,
    notes: null,
    tradingName: "Company A",
    companyNumber: null,
    country: "GB",
    timezone: "Europe/London",
    primaryContactName: null,
    primaryEmail: null,
    billingEmail: null,
    telephone: null,
    logoUrl: null,
    portalSubdomain: "company-a",
    portalHostname: "company-a.infra-web.pages.dev",
    provisionedAt: "2026-01-01T00:00:00.000Z",
    suspendedAt: null,
    closedAt: null,
    archivedAt: null,
    currency: "GBP",
    billingMode: "test",
    mcpOnboardingStatus: "not_provisioned",
    primaryAdminUserId: null,
    branding: {},
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("onboarding honesty", () => {
  it("does not treat a missing MCP as connected", () => {
    const result = buildCompanyOnboarding({
      company: company(),
      mcp: null,
      connectors: [],
      wallet: { balanceCents: 1000, lowBalance: false },
      ledger: [],
      adminCount: 0,
      activeTokenCount: 0,
      usageCount: 0,
    });
    expect(result.items.find((i) => i.id === "business_mcp")?.status).toBe("not_provisioned");
    expect(result.items.find((i) => i.id === "knowledge")?.status).toBe("not_configured");
    expect(result.items.find((i) => i.id === "ready")?.status).toBe("no");
    expect(result.readyForUse).toBe(false);
  });

  it("does not infer knowledge from MCP health", () => {
    const mcp = {
      id: "mcp_1",
      companyId: "co_alpha",
      name: "Company A MCP",
      description: null,
      endpointUrl: "https://example.workers.dev/mcp",
      transport: "streamable-http",
      status: "healthy",
      enabled: true,
      isExternal: true,
      dataPlaneId: null,
      mcpVersion: "1.0.0",
      businessMcpCoreVersion: "1.0.0",
      capabilities: ["system_health"],
      authSecretRef: "COMPANY_A_MCP_AUTH_TOKEN",
      serviceBindingRef: null,
      lastHealthCheckAt: "2026-01-01T00:00:00.000Z",
      lastHealthyAt: "2026-01-01T00:00:00.000Z",
      healthMessage: "ok",
      lastSuccessfulRequestAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      lastLatencyMs: 12,
      knowledgeDocumentCount: 0,
      knowledgeChunkCount: 0,
      lastSyncAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as McpEnvironment;
    const result = buildCompanyOnboarding({
      company: company({ status: "active" }),
      mcp,
      connectors: [],
      wallet: { balanceCents: 1000, lowBalance: false },
      ledger: [],
      adminCount: 1,
      activeTokenCount: 1,
      usageCount: 0,
    });
    expect(result.items.find((i) => i.id === "knowledge")?.status).toBe("not_configured");
    expect(deriveMcpOnboardingStatus(mcp)).toBe("healthy");
    expect(discoverMcpCapabilities(mcp).knowledge).toBe("not_configured");
  });

  it("maps draft connectors to not configured", () => {
    const instance = {
      id: "ci_1",
      companyId: "co_alpha",
      connectorDefinitionId: "conn_xero",
      name: "Xero",
      status: "draft",
      config: {},
      syncSettings: { enabled: false, mode: "manual", schedule: null },
      dataEnvironmentId: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: null,
      healthStatus: "unknown",
      healthMessage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ConnectorInstance;
    expect(deriveConnectorLifecycle(instance)).toBe("not_configured");
  });
});

describe("wallet credit classes", () => {
  it("separates TEST promotional credit from paid top-ups", () => {
    const result = classifyLedgerCredit([
      {
        id: "l1",
        companyId: "co_alpha",
        entryType: "promotional_credit",
        amountCents: 1000,
        currency: "GBP",
        balanceAfterCents: 1000,
        referenceType: "provisioning",
        referenceId: "opening",
        description: "Opening TEST credit",
        metadata: { creditClass: "test" },
        createdBy: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "l2",
        companyId: "co_alpha",
        entryType: "top_up",
        amountCents: 2500,
        currency: "GBP",
        balanceAfterCents: 3500,
        referenceType: "stripe",
        referenceId: "cs_1",
        description: "Stripe top-up",
        metadata: { creditClass: "paid" },
        createdBy: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(result.testCents).toBe(1000);
    expect(result.paidCents).toBe(2500);
  });
});
