import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOGUE,
  CONNECTOR_ERROR_CODES,
  CUSTOMER_ERROR_MESSAGES,
  XERO_TOOL_CONTRACTS,
  XERO_WRITE_ACTIVATION,
  mcpHasKnowledgeTools,
  publicConnectorDefinition,
  taxonomyForConnector,
} from "@infra/shared";
import { buildCompanyReadiness } from "./onboarding";
import { discoverMcpCapabilities } from "./mcp-capabilities";
import { buildCapabilitySnapshot, parseCapabilityList } from "./capability-snapshot";
import {
  deriveConnectorPresentation,
} from "./connector-lifecycle";
import { evaluateApprovalRequirement } from "./approvals";
import { buildKnowledgeSources } from "./knowledge-sources";
import { sanitizeConnectorConfig } from "./connector-credentials";
import type { Company, ConnectorInstance, McpEnvironment } from "@infra/shared";

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "co_alpha",
    slug: "abc-plumbing",
    name: "ABC Plumbing Ltd",
    status: "onboarding",
    primaryDomain: null,
    notes: null,
    tradingName: "ABC Plumbing",
    companyNumber: null,
    country: "GB",
    timezone: "Europe/London",
    primaryContactName: null,
    primaryEmail: null,
    billingEmail: null,
    telephone: null,
    logoUrl: null,
    portalSubdomain: "abc-plumbing",
    portalHostname: null,
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

function mcp(overrides: Partial<McpEnvironment> = {}): McpEnvironment {
  return {
    id: "mcp_1",
    companyId: "co_alpha",
    name: "ABC MCP",
    description: null,
    endpointUrl: "https://example.workers.dev/mcp",
    transport: "streamable-http",
    status: "healthy",
    enabled: true,
    isExternal: true,
    dataPlaneId: null,
    mcpVersion: "1.0.0",
    businessMcpCoreVersion: null,
    capabilities: ["system_health", "database_summary"],
    authSecretRef: "ABC_MCP_AUTH_TOKEN",
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
    ...overrides,
  };
}

function instance(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
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
    ...overrides,
  };
}

describe("reference tenant readiness", () => {
  it("does not fail a structured-data company for missing knowledge", () => {
    const result = buildCompanyReadiness({
      company: company({ status: "active" }),
      mcp: mcp(),
      connectors: [],
      wallet: { balanceCents: 1000, lowBalance: false },
      ledger: [],
      adminCount: 1,
      activeTokenCount: 0,
      usageCount: 0,
    });
    expect(result.items.find((i) => i.id === "knowledge")?.applicability).toBe(
      "not_applicable",
    );
    expect(result.items.find((i) => i.id === "ai_connection")?.applicability).toBe(
      "optional",
    );
    expect(result.readyForUse).toBe(true);
  });

  it("does not require Google Drive or ChatGPT by default", () => {
    const result = buildCompanyReadiness({
      company: company({ status: "active", slug: "caddington-holdings", name: "Caddington Holdings" }),
      mcp: mcp({
        capabilities: [
          "system_health",
          "database_summary",
          "search_company_knowledge",
          "get_knowledge_document",
        ],
        knowledgeDocumentCount: 46,
        knowledgeChunkCount: 124,
      }),
      connectors: [
        instance({
          id: "ci_caddington_gdrive",
          connectorDefinitionId: "conn_google_drive",
          name: "Google Drive",
          status: "healthy",
          managedBy: "company_mcp",
          authStatus: "connected",
        }),
      ],
      wallet: { balanceCents: 971, lowBalance: false },
      ledger: [],
      adminCount: 1,
      activeTokenCount: 1,
      usageCount: 16,
    });
    expect(result.items.find((i) => i.id === "business_systems")?.required).toBe(false);
    expect(result.items.find((i) => i.id === "ai_connection")?.required).toBe(false);
    expect(result.readyForUse).toBe(true);
  });

  it("treats a required capability from company config, not from tenant name", () => {
    const result = buildCompanyReadiness({
      company: company({
        status: "active",
        config: { readiness: { requiresAiConnection: true } },
      }),
      mcp: mcp(),
      connectors: [],
      wallet: { balanceCents: 1000, lowBalance: false },
      ledger: [],
      adminCount: 1,
      activeTokenCount: 0,
      usageCount: 0,
    });
    expect(result.items.find((i) => i.id === "ai_connection")?.required).toBe(true);
    expect(result.readyForUse).toBe(false);
  });
});

describe("new company connector state", () => {
  it("starts with no connected instances and Xero requiring setup", () => {
    const xero = CONNECTOR_CATALOGUE.find((c) => c.slug === "xero");
    const drive = CONNECTOR_CATALOGUE.find((c) => c.slug === "google-drive");
    const chatgpt = CONNECTOR_CATALOGUE.find((c) => c.slug === "chatgpt");
    expect(xero?.availabilityLabel).toBe("requires_setup");
    expect(drive?.integrationType).toBe("business_system");
    expect(chatgpt?.integrationType).toBe("ai_channel");
    expect(taxonomyForConnector(chatgpt!)).toBe("ai_connections");
    expect(taxonomyForConnector(drive!)).toBe("knowledge_sources");
  });
});

describe("capability snapshot", () => {
  it("parses both array and object capability payloads", () => {
    expect(parseCapabilityList('["system_health","database_summary"]')).toEqual([
      "system_health",
      "database_summary",
    ]);
    expect(
      parseCapabilityList(
        JSON.stringify({ tools: ["system_health"], search: "ok" }),
      ),
    ).toEqual(["system_health"]);
  });

  it("does not invent knowledge from health alone", () => {
    const discovered = discoverMcpCapabilities(mcp({ capabilities: ["system_health"] }));
    expect(discovered.knowledge).toBe("not_configured");
    expect(mcpHasKnowledgeTools(["system_health"])).toBe(false);
  });

  it("records tool groups without billable search", () => {
    const snapshot = buildCapabilitySnapshot({
      tools: ["system_health", "search_company_knowledge"],
      knowledgeDocumentCount: 46,
    });
    expect(snapshot.groups.knowledge).toBe(true);
    expect(snapshot.knowledgeConfigured).toBe(true);
    expect(snapshot.groups.system).toBe(true);
  });
});

describe("connector health vs sync", () => {
  it("does not call a valid OAuth + failed sync Disconnected", () => {
    const presentation = deriveConnectorPresentation(
      instance({
        status: "healthy",
        authStatus: "connected",
        syncHealth: "failed",
        lastSyncStatus: "failed",
      }),
    );
    expect(presentation.authStatus).toBe("connected");
    expect(presentation.syncHealth).toBe("failed");
    expect(presentation.label).toContain("sync failed");
    expect(presentation.label).not.toBe("Disconnected");
  });
});

describe("approvals and suspension", () => {
  it("allows financial writes when operator gate is enabled and blocks suspended companies", () => {
    expect(
      evaluateApprovalRequirement({
        riskClass: "financial_action",
        action: "xero.invoices.create_draft",
        companyStatus: "active",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateApprovalRequirement({
        riskClass: "write",
        action: "bigchange.jobs.create",
        companyStatus: "suspended",
      }).error?.code,
    ).toBe(CONNECTOR_ERROR_CODES.SUSPENDED);
    expect(
      evaluateApprovalRequirement({
        riskClass: "low_risk",
        action: "knowledge.search",
        companyStatus: "active",
      }).allowed,
    ).toBe(true);
  });
});

describe("knowledge source contract", () => {
  it("shows Drive as MCP-managed and does not invent last sync", () => {
    const sources = buildKnowledgeSources({
      mcp: mcp({
        capabilities: ["search_company_knowledge"],
        knowledgeDocumentCount: 46,
        knowledgeChunkCount: 124,
        lastSyncAt: null,
      }),
      connectors: [
        instance({
          connectorDefinitionId: "conn_google_drive",
          name: "Google Drive",
          status: "healthy",
          healthStatus: "healthy",
          managedBy: "company_mcp",
          lastSyncAt: null,
        }),
      ],
    });
    expect(sources[0]?.documentCount).toBe(46);
    expect(sources[0]?.chunkCount).toBe(124);
    expect(sources[0]?.lastSyncAt).toBeNull();
    expect(sources[0]?.managedBy).toBe("company_mcp");
    expect(sources[0]?.kind).toBe("google_drive");
  });
});

describe("connector definition contract", () => {
  it("exposes public definitions without inventing secrets", () => {
    const xero = publicConnectorDefinition(
      CONNECTOR_CATALOGUE.find((c) => c.slug === "xero")!,
    );
    expect(xero.taxonomyCategory).toBe("accounting_finance");
    expect(xero.oauth?.pkceRequired).toBe(true);
    expect(JSON.stringify(xero)).not.toMatch(/sk_live|refresh_token_value/);
  });

  it("marks read and write Xero tools as contract-ready with production writes gated", () => {
    expect(
      XERO_TOOL_CONTRACTS.filter((tool) => tool.riskClass === "low_risk").every(
        (tool) => tool.implemented,
      ),
    ).toBe(true);
    expect(
      XERO_TOOL_CONTRACTS.filter((tool) => tool.riskClass === "financial_action").every(
        (tool) => tool.implemented === true,
      ),
    ).toBe(true);
    expect(XERO_WRITE_ACTIVATION.writesSupported).toBe(true);
    expect(XERO_WRITE_ACTIVATION.writesEnabled).toBe(false);
  });
});

describe("credential sanitisation", () => {
  it("strips secret fields from connector config", () => {
    expect(
      sanitizeConnectorConfig({
        folderIds: ["a"],
        apiKey: "should-not-persist",
        clientSecret: "nope",
      }),
    ).toEqual({ folderIds: ["a"] });
  });
});

describe("customer errors", () => {
  it("does not leak tokens in customer messages", () => {
    expect(CUSTOMER_ERROR_MESSAGES.CONNECTOR_AUTH_EXPIRED).toBe("Authentication expired");
    expect(JSON.stringify(CUSTOMER_ERROR_MESSAGES)).not.toMatch(/Bearer |sk_|refresh_token/);
  });
});
