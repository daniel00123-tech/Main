import { describe, expect, it } from "vitest";
import {
  catalogueIdForMcpConnectorType,
  customerFacingConnectorInstances,
  decideRegistrySync,
  deriveMirroredConnectorState,
  deriveStatusUrlFromMcpEndpoint,
  mapMcpConnectorsToRegistryRecords,
  mcpConnectorLooksConnected,
  parseMcpConnectorSnapshot,
  registryInstanceId,
  resolveCatalogueConnector,
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

const ELVEX_STATUS = {
  connectors: [
    { type: "bigchange", status: "disabled", enabled: false },
    { type: "sharepoint", status: "configured", enabled: true, health: "healthy" },
    { type: "onedrive", status: "configured", enabled: true, health: "healthy" },
    { type: "xero", status: "configured", enabled: true, health: "healthy" },
    { type: "outlook_shared_mailbox", status: "configured", enabled: true, health: "healthy" },
    { type: "freshdesk", status: "disabled", enabled: false },
  ],
  xero: {
    configured: true,
    connected: true,
    organisationName: "Elvex Property Services Ltd",
    tenantId: "ec69a5fb-1b91-4cb5-a7f5-704dcecc5d2d",
    lastApiOk: true,
    lastApiAt: "2026-08-30 12:10:33",
    tokenHealth: "connected",
  },
  microsoft: {
    configured: true,
    approvedMailboxes: ["finance@elvexpropertyservices.com", "info@elvexpropertyservices.com"],
    sharePointHostname: "elvexpropertyservicesltd.sharepoint.com",
  },
};

describe("resolveCatalogueConnector", () => {
  it("maps MCP codes onto catalogue definitions without hardcoded UI cards", () => {
    expect(resolveCatalogueConnector("xero")?.id).toBe("conn_xero");
    expect(resolveCatalogueConnector("sharepoint")?.id).toBe("conn_sharepoint");
    expect(resolveCatalogueConnector("outlook_shared_mailbox")?.id).toBe("conn_outlook_shared");
    expect(resolveCatalogueConnector("bigchange")?.id).toBe("conn_bigchange");
    expect(resolveCatalogueConnector("unknown_future_system")).toBeNull();
  });
});

describe("deriveMirroredConnectorState", () => {
  it("requires a live Xero organisation, not just app credentials", () => {
    const disconnected = deriveMirroredConnectorState(
      { type: "xero", status: "configured", enabled: true, health: "healthy" },
      { xero: { configured: true, connected: false } },
    );
    expect(disconnected.connected).toBe(false);
    expect(disconnected.status).toBe("draft");

    const connected = deriveMirroredConnectorState(
      { type: "xero", status: "configured", enabled: true, health: "healthy" },
      {
        xero: {
          configured: true,
          connected: true,
          organisationName: "Elvex Property Services Ltd",
          tenantId: "tenant-1",
          lastApiOk: true,
        },
      },
    );
    expect(connected.connected).toBe(true);
    expect(connected.displayAccountName).toBe("Elvex Property Services Ltd");
    expect(connected.healthMessage).toContain("Elvex Property Services Ltd");
  });

  it("promotes Microsoft family connectors only when MCP policy is configured", () => {
    const denied = deriveMirroredConnectorState(
      { type: "sharepoint", status: "configured", enabled: true, health: "healthy" },
      { microsoft: { configured: false } },
    );
    expect(denied.connected).toBe(false);

    const ok = deriveMirroredConnectorState(
      { type: "sharepoint", status: "configured", enabled: true, health: "healthy" },
      { microsoft: { configured: true, sharePointHostname: "example.sharepoint.com" } },
    );
    expect(ok.connected).toBe(true);
    expect(ok.displayAccountName).toBe("example.sharepoint.com");
  });

  it("leaves disabled future connectors such as BigChange disconnected", () => {
    const state = deriveMirroredConnectorState({
      type: "bigchange",
      status: "disabled",
      enabled: false,
    });
    expect(state.connected).toBe(false);
  });
});

describe("parseMcpConnectorSnapshot", () => {
  it("reads connectors plus Xero/Microsoft policy from /status", () => {
    const snapshot = parseMcpConnectorSnapshot(ELVEX_STATUS);
    expect(snapshot?.connectors).toHaveLength(6);
    expect(snapshot?.xero?.organisationName).toBe("Elvex Property Services Ltd");
    expect(snapshot?.microsoft?.configured).toBe(true);
  });

  it("returns null when the payload has no connector evidence", () => {
    expect(parseMcpConnectorSnapshot({ ok: true })).toBeNull();
  });
});

describe("deriveStatusUrlFromMcpEndpoint", () => {
  it("maps the registered MCP route to /status", () => {
    expect(deriveStatusUrlFromMcpEndpoint("https://el-business-mcp.infrastack.app/mcp")).toBe(
      "https://el-business-mcp.infrastack.app/status",
    );
  });
});
