import { describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_PRODUCTISATION_PROFILES,
  getProductisationProfile,
} from "./profiles";
import { assessConnectorBlockers, buildCompanyProductisationReport } from "./blockers";
import { buildConnectorWizardState } from "./wizard";
import { resolveMcpAdminAuthHeader } from "../mcp-admin-bridge";
import type { ConnectorInstance, McpEnvironment } from "@infra/shared";

const baseEnv = {
  INFRA_CREDENTIAL_WRAPPING_KEY: "a".repeat(32),
  XERO_CLIENT_ID: "xero-id",
  XERO_CLIENT_SECRET: "xero-secret",
  MICROSOFT_TENANT_ID: "tenant",
  MICROSOFT_CLIENT_ID: "client",
  MICROSOFT_CLIENT_SECRET: "secret",
  CADDINGTON_ADMIN_TOKEN: "admin-token",
} as unknown as import("../env").Env;

function instance(partial: Partial<ConnectorInstance>): ConnectorInstance {
  return {
    id: "ci_test",
    companyId: "co_test",
    connectorDefinitionId: "conn_xero",
    name: "Xero",
    status: "draft",
    config: {},
    syncSettings: { enabled: false, mode: "scheduled", schedule: null },
    dataEnvironmentId: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncMessage: null,
    healthStatus: "unknown",
    healthMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const mcp: McpEnvironment = {
  id: "mcp_test",
  companyId: "co_test",
  name: "Test MCP",
  description: null,
  endpointUrl: "https://example.com/mcp",
  transport: "streamable-http",
  status: "healthy",
  enabled: true,
  isExternal: true,
  dataPlaneId: null,
  mcpVersion: "1.0.0",
  businessMcpCoreVersion: null,
  capabilities: [],
  authSecretRef: "TEST_MCP_AUTH_TOKEN",
  adminSecretRef: null,
  serviceBindingRef: null,
  lastHealthCheckAt: null,
  lastHealthyAt: null,
  healthMessage: null,
  lastSuccessfulRequestAt: null,
  lastError: null,
  lastLatencyMs: null,
  knowledgeDocumentCount: 0,
  capabilityRefreshedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Connector productisation profiles", () => {
  it("defines Xero, Microsoft 365, and Google Drive", () => {
    expect(CONNECTOR_PRODUCTISATION_PROFILES.map((p) => p.slug).sort()).toEqual([
      "google-drive",
      "microsoft-365",
      "xero",
    ]);
  });

  it("marks Google Drive as MCP managed", () => {
    const profile = getProductisationProfile("conn_google_drive");
    expect(profile?.selfServiceLevel).toBe("mcp_managed");
    expect(profile?.managedBy).toBe("company_mcp");
  });
});

describe("Connector blockers", () => {
  it("reports Microsoft onboarding blockers for new tenants", () => {
    const blockers = assessConnectorBlockers({
      env: baseEnv,
      companyId: "co_ht",
      companySlug: "heattech",
      definitionId: "conn_microsoft_365",
      instance: null,
      mcp,
    });
    expect(blockers.some((b) => b.code === "MICROSOFT_MULTITENANT_ENTRA_MANUAL")).toBe(true);
    expect(blockers.some((b) => b.code === "MICROSOFT_NOT_CONNECTED")).toBe(true);
  });

  it("allows Xero when platform secrets configured", () => {
    const blockers = assessConnectorBlockers({
      env: baseEnv,
      companyId: "co_ht",
      companySlug: "heattech",
      definitionId: "conn_xero",
      instance: null,
      mcp,
    });
    expect(blockers.filter((b) => b.severity === "blocking")).toHaveLength(0);
  });

  it("blocks Google Drive without MCP", () => {
    const blockers = assessConnectorBlockers({
      env: baseEnv,
      companyId: "co_ht",
      companySlug: "heattech",
      definitionId: "conn_google_drive",
      instance: null,
      mcp: null,
    });
    expect(blockers.some((b) => b.code === "MCP_NOT_PROVISIONED")).toBe(true);
  });
});

describe("Company productisation report", () => {
  it("classifies overall as partial for typical tenant", () => {
    const report = buildCompanyProductisationReport({
      env: baseEnv,
      companyId: "co_ht",
      companySlug: "heattech",
      connectors: [],
      mcp,
    });
    expect(report.overall).toBe("partial");
    expect(report.connectors.find((c) => c.slug === "xero")?.classification).toBe("pass");
    expect(report.connectors.find((c) => c.slug === "microsoft-365")?.classification).toBe("fail");
  });
});

describe("Connector setup wizard", () => {
  it("builds ordered steps for Xero", () => {
    const wizard = buildConnectorWizardState({
      env: baseEnv,
      companyId: "co_ht",
      companySlug: "heattech",
      definitionId: "conn_xero",
      instance: instance({ authStatus: "connected", displayAccountName: "HT Ltd" }),
      mcp,
    });
    expect(wizard?.steps[0]?.id).toBe("prerequisites");
    expect(wizard?.steps.some((s) => s.id === "connect")).toBe(true);
  });
});

describe("MCP admin bridge", () => {
  it("uses admin_secret_ref when configured", () => {
    const header = resolveMcpAdminAuthHeader(baseEnv, {
      ...mcp,
      adminSecretRef: "CADDINGTON_ADMIN_TOKEN",
    });
    expect(header.authorizationHeader).toBe("Bearer admin-token");
  });

  it("falls back to legacy CADDINGTON_ADMIN_TOKEN", () => {
    const header = resolveMcpAdminAuthHeader(baseEnv, mcp);
    expect(header.authorizationHeader).toBe("Bearer admin-token");
    expect(header.source).toBe("CADDINGTON_ADMIN_TOKEN");
  });
});
