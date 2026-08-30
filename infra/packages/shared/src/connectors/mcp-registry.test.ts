import { describe, expect, it } from "vitest";
import {
  deriveMirroredConnectorState,
  deriveStatusUrlFromMcpEndpoint,
  parseMcpConnectorSnapshot,
  resolveCatalogueConnector,
} from "./mcp-registry";

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
