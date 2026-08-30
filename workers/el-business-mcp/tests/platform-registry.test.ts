import { describe, expect, it } from "vitest";
import { elPlatformRegistrySnapshot } from "../src/registry";
import type { Env } from "../src/env";

function env(partial: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    } as unknown as D1Database,
    EL_MS_TENANT_ID: "tenant",
    EL_MS_CLIENT_ID: "client",
    EL_MS_CLIENT_SECRET: "secret",
    EL_XERO_CLIENT_ID: "xero-client",
    EL_XERO_CLIENT_SECRET: "xero-secret",
    ...partial,
  } as Env;
}

describe("EL platform registry snapshot", () => {
  it("exposes Microsoft 365 and Xero without secrets", async () => {
    const snapshot = await elPlatformRegistrySnapshot(env());
    expect(snapshot.connectors.some((item) => item.connectorType === "microsoft_365" && item.connected)).toBe(true);
    expect(snapshot.connectors.some((item) => item.connectorType === "xero")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/EL_MS_CLIENT_SECRET|EL_XERO_CLIENT_SECRET|Bearer |refresh/i);
    expect(snapshot.connectors.find((item) => item.connectorType === "bigchange")?.connected).toBe(false);
  });
});
