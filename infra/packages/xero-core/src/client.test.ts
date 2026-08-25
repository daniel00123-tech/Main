import { describe, expect, it, vi } from "vitest";
import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";
import { XeroClient } from "./client";

describe("XeroClient", () => {
  it("clamps list limits to data bounds", () => {
    const client = new XeroClient({ accessToken: "t", tenantId: "x" });
    expect(client.clampLimit(undefined)).toBe(XERO_DATA_BOUNDS.defaultListResults);
    expect(client.clampLimit(999)).toBe(XERO_DATA_BOUNDS.maxListResults);
  });

  it("preserves the Xero API base path when building request URLs", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${XERO_AUTH.apiBaseUrl}/Organisation`);
      return new Response(JSON.stringify({ Organisations: [] }), { status: 200 });
    });
    const client = new XeroClient({
      accessToken: "token",
      tenantId: "tenant",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.get("/Organisation");
  });
});
