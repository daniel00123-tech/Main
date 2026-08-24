import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOGUE,
  getConnectorBySlug,
} from "./catalogue";

describe("connector catalogue", () => {
  it("includes planned business connectors", () => {
    const slugs = CONNECTOR_CATALOGUE.map((c) => c.slug);
    expect(slugs).toContain("google-drive");
    expect(slugs).toContain("bigchange");
    expect(slugs).toContain("commusoft");
    expect(slugs).toContain("xero");
    expect(slugs).toContain("freshdesk");
  });

  it("declares capabilities on each connector", () => {
    for (const connector of CONNECTOR_CATALOGUE) {
      expect(connector.capabilities.length).toBeGreaterThan(0);
      expect(connector.capabilities).toContain("read");
    }
  });

  it("does not include personal connector types", () => {
    const names = CONNECTOR_CATALOGUE.map((c) => c.name.toLowerCase()).join(" ");
    expect(names).not.toContain("personal gmail");
    expect(names).not.toContain("personal outlook");
  });

  it("resolves connectors by slug", () => {
    const bigchange = getConnectorBySlug("bigchange");
    expect(bigchange?.category).toBe("field_service");
    expect(bigchange?.capabilities).toContain("live_query");
  });
});
