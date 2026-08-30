import { describe, expect, it } from "vitest";
import {
  canConnectApprovedUserChannel,
  canManageCompanyAiPolicy,
  customerFacingConnectorInstances,
  deriveConnectorCustomerHealth,
  deriveGettingStartedItems,
  employeeMustNotSeeSharedToken,
  hasConnectedCustomerSystem,
  mapMcpConnectorsToRegistryRecords,
} from "@infra/shared";
import type { CompanyOverview, ConnectorInstance } from "@infra/shared";

const william = {
  role: "office_staff" as const,
  email: "william@elvexpropertyservices.com",
};

function overviewWith(connectors: ConnectorInstance[]): CompanyOverview {
  return {
    company: {
      id: "co_el",
      slug: "el-business",
      name: "EL Business",
      status: "active",
    },
    connectorInstances: connectors,
    paymentMethodReady: false,
    walletSettingsConfigured: false,
    aiClientConfigured: false,
    teamCount: 1,
    pendingInvitationCount: 0,
    successfulRequestCount: 0,
  } as CompanyOverview;
}

function synced(definitionId: string, name: string): ConnectorInstance {
  return {
    id: `ci_${definitionId}`,
    companyId: "co_el",
    connectorDefinitionId: definitionId,
    name,
    status: "configured",
    healthStatus: "healthy",
    authStatus: "connected",
    providerHealth: "healthy",
    lastVerifiedAt: "2026-08-30T10:00:00.000Z",
  } as ConnectorInstance;
}

describe("William office_staff acceptance", () => {
  it("cannot approve or disable company ChatGPT", () => {
    expect(canManageCompanyAiPolicy(william.role)).toBe(false);
  });

  it("can connect his own ChatGPT after company approval and never sees a shared token", () => {
    expect(
      canConnectApprovedUserChannel({
        role: william.role,
        companyApproved: true,
        membershipStatus: "active",
        userStatus: "active",
      }).allowed,
    ).toBe(true);
    expect(employeeMustNotSeeSharedToken({ role: william.role })).toBe(true);
  });

  it("cannot connect before company approval", () => {
    expect(
      canConnectApprovedUserChannel({
        role: william.role,
        companyApproved: false,
        membershipStatus: "active",
        userStatus: "active",
      }).allowed,
    ).toBe(false);
  });
});

describe("EL connector synchronisation acceptance", () => {
  it("shows Microsoft 365 and Xero as Connected and completes first-system onboarding", () => {
    const records = mapMcpConnectorsToRegistryRecords({
      source: "el-business-mcp",
      connectors: [
        { connectorType: "microsoft_365", connected: true, configured: true, health: "healthy", lastVerified: "2026-08-30T10:00:00.000Z" },
        { connectorType: "xero", connected: true, configured: true, health: "healthy", lastVerified: "2026-08-30T10:01:00.000Z" },
        { connectorType: "bigchange", status: "not_configured" },
      ],
    });
    const instances = records
      .filter((item) => item.connected)
      .map((item) =>
        synced(item.catalogueId, item.label),
      );
    const visible = customerFacingConnectorInstances(instances);
    expect(visible.map((item) => item.connectorDefinitionId).sort()).toEqual([
      "conn_microsoft_365",
      "conn_xero",
    ]);
    expect(deriveConnectorCustomerHealth(visible[0]!).label).toBe("Connected");
    expect(hasConnectedCustomerSystem(instances)).toBe(true);
    const checklist = deriveGettingStartedItems({ overview: overviewWith(instances) });
    expect(checklist.find((item) => item.key === "connector")?.complete).toBe(true);
  });

  it("keeps another tenant's connectors out of EL's mapped records", () => {
    const el = mapMcpConnectorsToRegistryRecords({
      source: "el-business-mcp",
      connectors: [{ connectorType: "xero", connected: true }],
    });
    const ht = mapMcpConnectorsToRegistryRecords({
      source: "ht-business-mcp",
      connectors: [{ connectorType: "commusoft", connected: true }],
    });
    expect(el.every((item) => item.source === "el-business-mcp")).toBe(true);
    expect(ht.every((item) => item.source === "ht-business-mcp")).toBe(true);
    expect(ht.some((item) => item.catalogueId === "conn_xero" && item.connected)).toBe(false);
  });
});
