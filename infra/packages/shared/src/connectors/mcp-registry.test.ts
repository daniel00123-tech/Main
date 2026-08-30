import { describe, expect, it } from "vitest";
import {
  catalogueIdForMcpConnectorType,
  customerFacingConnectorInstances,
  decideRegistrySync,
  mapMcpConnectorsToRegistryRecords,
  mcpConnectorLooksConnected,
  registryInstanceId,
} from "./mcp-registry";

describe("MCP → INFRA catalogue mapping", () => {
  it("maps platform connector types without tenant hard-coding", () => {
    expect(catalogueIdForMcpConnectorType("microsoft_365")).toBe("conn_microsoft_365");
    expect(catalogueIdForMcpConnectorType("xero")).toBe("conn_xero");
    expect(catalogueIdForMcpConnectorType("bigchange")).toBe("conn_bigchange");
    expect(catalogueIdForMcpConnectorType("commusoft")).toBe("conn_commusoft");
    expect(catalogueIdForMcpConnectorType("chatgpt")).toBeNull();
  });

  it("rolls Microsoft children up to Microsoft 365", () => {
    const records = mapMcpConnectorsToRegistryRecords({
      source: "el-business-mcp",
      connectors: [
        {
          connectorType: "sharepoint",
          status: "configured",
          health: "healthy",
          authenticationConfigured: true,
          lastVerified: "2026-08-30T10:00:00.000Z",
        },
        {
          connectorType: "xero",
          status: "configured",
          health: "healthy",
          configured: true,
          connected: true,
          lastVerified: "2026-08-30T10:01:00.000Z",
          metadata: { organisationName: "Elvex Property Services Ltd" },
        },
        { connectorType: "bigchange", status: "not_configured" },
      ],
    });
    const microsoft = records.find((item) => item.catalogueId === "conn_microsoft_365");
    const xero = records.find((item) => item.catalogueId === "conn_xero");
    const bigchange = records.find((item) => item.catalogueId === "conn_bigchange");
    expect(microsoft?.connected).toBe(true);
    expect(microsoft?.label).toBe("Microsoft 365");
    expect(xero?.connected).toBe(true);
    expect(xero?.metadata.organisationName).toBe("Elvex Property Services Ltd");
    expect(bigchange?.connected).toBe(false);
  });

  it("strips secret-like metadata keys", () => {
    const [record] = mapMcpConnectorsToRegistryRecords({
      connectors: [
        {
          connectorType: "xero",
          connected: true,
          metadata: { organisationName: "Acme", refreshToken: "secret", clientSecret: "nope" },
        },
      ],
    });
    expect(record?.metadata.refreshToken).toBeUndefined();
    expect(record?.metadata.clientSecret).toBeUndefined();
    expect(record?.metadata.organisationName).toBe("Acme");
  });
});

describe("registry sync decisions", () => {
  it("does not overwrite a live INFRA OAuth connection with MCP not-configured", () => {
    const decision = decideRegistrySync({
      existing: {
        id: "ci_1",
        companyId: "co_caddington",
        connectorDefinitionId: "conn_xero",
        status: "healthy",
        authStatus: "connected",
        managedBy: "infra",
        healthStatus: "healthy",
        providerHealth: "healthy",
      },
      incoming: {
        connectorType: "xero",
        catalogueId: "conn_xero",
        instanceKey: "default",
        configured: false,
        connected: false,
        health: "unknown",
        lastVerified: null,
        label: "Xero",
        category: "finance",
        source: "company_mcp",
        metadata: {},
      },
    });
    expect(decision.action).toBe("skip");
  });

  it("promotes draft company_mcp placeholders when MCP reports connected", () => {
    const decision = decideRegistrySync({
      existing: {
        id: "ci_el_xero",
        companyId: "co_el",
        connectorDefinitionId: "conn_xero",
        status: "draft",
        authStatus: "not_configured",
        managedBy: "company_mcp",
        healthStatus: "unknown",
        providerHealth: "unknown",
      },
      incoming: {
        connectorType: "xero",
        catalogueId: "conn_xero",
        instanceKey: "default",
        configured: true,
        connected: true,
        health: "healthy",
        lastVerified: "2026-08-30T12:00:00.000Z",
        label: "Xero",
        category: "finance",
        source: "el-business-mcp",
        metadata: {},
      },
    });
    expect(decision).toEqual({
      action: "upsert",
      catalogueId: "conn_xero",
      promoteFromDraft: true,
    });
  });
});

describe("customer-facing registry rows", () => {
  it("hides Microsoft children when the parent is present", () => {
    const visible = customerFacingConnectorInstances([
      { connectorDefinitionId: "conn_microsoft_365", status: "configured" },
      { connectorDefinitionId: "conn_sharepoint", status: "configured" },
      { connectorDefinitionId: "conn_xero", status: "configured" },
      { connectorDefinitionId: "conn_bigchange", status: "draft" },
    ]);
    expect(visible.map((item) => item.connectorDefinitionId)).toEqual([
      "conn_microsoft_365",
      "conn_xero",
    ]);
  });

  it("scopes instance ids by company", () => {
    expect(registryInstanceId("co_el", "conn_xero")).toBe("ci_co_el_xero");
    expect(registryInstanceId("co_ht", "conn_xero")).toBe("ci_co_ht_xero");
  });
});

describe("connected detection", () => {
  it("treats configured Microsoft MCP children as connected", () => {
    expect(mcpConnectorLooksConnected({ connectorType: "sharepoint", status: "configured" })).toBe(true);
    expect(mcpConnectorLooksConnected({ connectorType: "bigchange", status: "not_configured" })).toBe(false);
  });
});
