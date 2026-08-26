import { describe, expect, it } from "vitest";
import { connectorNeedsAttention } from "./attention";
import type { ConnectorInstance } from "@infra/shared";

function connector(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: "ci_1",
    companyId: "co_alpha",
    connectorDefinitionId: "conn_xero",
    name: "Xero",
    status: "configured",
    config: {},
    syncSettings: { enabled: false, mode: "manual", schedule: null },
    dataEnvironmentId: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncMessage: null,
    healthStatus: "healthy",
    healthMessage: null,
    authStatus: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("connectorNeedsAttention", () => {
  it("flags expired OAuth", () => {
    expect(connectorNeedsAttention(connector({ authStatus: "auth_expired" }))).toBe(
      "Authentication expired",
    );
  });

  it("flags rotation required", () => {
    expect(
      connectorNeedsAttention(connector({ authStatus: "rotation_required" })),
    ).toBe("Re-authentication required");
  });

  it("flags degraded connectors", () => {
    expect(
      connectorNeedsAttention(
        connector({ status: "degraded", healthStatus: "degraded", lastErrorMessage: "Sync lag" }),
      ),
    ).toBe("Sync lag");
  });

  it("ignores healthy connected connectors", () => {
    expect(connectorNeedsAttention(connector())).toBeNull();
  });

  it("ignores draft not configured state", () => {
    expect(
      connectorNeedsAttention(connector({ status: "draft", authStatus: "not_configured" })),
    ).toBeNull();
  });
});
