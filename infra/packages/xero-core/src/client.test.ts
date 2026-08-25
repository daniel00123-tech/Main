import { describe, expect, it } from "vitest";
import { XERO_DATA_BOUNDS } from "@infra/shared";
import { XeroClient } from "./client";

describe("XeroClient", () => {
  it("clamps list limits to data bounds", () => {
    const client = new XeroClient({ accessToken: "t", tenantId: "x" });
    expect(client.clampLimit(undefined)).toBe(XERO_DATA_BOUNDS.defaultListResults);
    expect(client.clampLimit(999)).toBe(XERO_DATA_BOUNDS.maxListResults);
  });
});
