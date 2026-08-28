import { describe, expect, it } from "vitest";
import {
  connectorOverviewDescription,
  connectorOverviewTitle,
  deriveConnectorCustomerHealth,
} from "./customer-health";

describe("deriveConnectorCustomerHealth", () => {
  it("shows Healthy when healthStatus is healthy", () => {
    expect(
      deriveConnectorCustomerHealth({
        status: "configured",
        healthStatus: "healthy",
        authStatus: "connected",
      }),
    ).toEqual({ badgeStatus: "healthy", label: "Healthy" });
  });

  it("shows Healthy when providerHealth is healthy", () => {
    expect(
      deriveConnectorCustomerHealth({
        status: "configured",
        healthStatus: "unknown",
        authStatus: "connected",
        providerHealth: "healthy",
      }),
    ).toEqual({ badgeStatus: "healthy", label: "Healthy" });
  });

  it("does not surface Configured as a customer label", () => {
    const result = deriveConnectorCustomerHealth({
      status: "configured",
      healthStatus: "unknown",
      authStatus: "connected",
    });
    expect(result.label).not.toBe("Configured");
    expect(result.label).toBe("Checking…");
  });

  it("maps Microsoft-style connected + configured + healthy provider to Healthy", () => {
    expect(
      deriveConnectorCustomerHealth({
        status: "configured",
        healthStatus: "healthy",
        authStatus: "connected",
        providerHealth: "healthy",
      }),
    ).toEqual({ badgeStatus: "healthy", label: "Healthy" });
  });

  it("maps degraded sync to Attention needed", () => {
    expect(
      deriveConnectorCustomerHealth({
        status: "healthy",
        healthStatus: "healthy",
        authStatus: "connected",
        syncHealth: "failed",
      }),
    ).toEqual({ badgeStatus: "warning", label: "Attention needed" });
  });

  it("maps draft connectors to Disconnected", () => {
    expect(
      deriveConnectorCustomerHealth({
        status: "draft",
        authStatus: "not_configured",
      }),
    ).toEqual({ badgeStatus: "not_configured", label: "Disconnected" });
  });
});

describe("connector overview copy", () => {
  it("uses customer descriptions by connector id", () => {
    expect(connectorOverviewDescription("conn_google_drive")).toBe(
      "Files and company knowledge",
    );
    expect(connectorOverviewDescription("conn_xero")).toBe(
      "Accounting and financial data",
    );
    expect(connectorOverviewDescription("conn_microsoft_365")).toBe(
      "OneDrive, SharePoint and email",
    );
  });

  it("includes Xero organisation in the title when available", () => {
    expect(
      connectorOverviewTitle({
        connectorDefinitionId: "conn_xero",
        name: "Xero",
        displayAccountName: "Caddington Holdings",
      }),
    ).toBe("Caddington Holdings · Xero");
  });
});
