import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOGUE,
  getAiChannelConnectors,
  getBusinessSystemConnectors,
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

  it("includes AI and messaging channel connectors", () => {
    const slugs = CONNECTOR_CATALOGUE.map((c) => c.slug);
    expect(slugs).toContain("chatgpt");
    expect(slugs).toContain("claude");
    expect(slugs).toContain("whatsapp");
  });

  it("declares capabilities and marketplace metadata on each connector", () => {
    for (const connector of CONNECTOR_CATALOGUE) {
      expect(connector.capabilities.length).toBeGreaterThan(0);
      expect(connector.integrationType).toMatch(/business_system|ai_channel/);
      expect(connector.catalogueStatus).toBeTruthy();
    }
  });

  it("marks Google Drive as the active operational connector", () => {
    const gdrive = getConnectorBySlug("google-drive");
    expect(gdrive?.catalogueStatus).toBe("active");
    expect(gdrive?.integrationType).toBe("business_system");
  });

  it("marks ChatGPT as available now and WhatsApp as coming soon", () => {
    expect(getConnectorBySlug("chatgpt")?.catalogueStatus).toBe("active");
    expect(getConnectorBySlug("claude")?.catalogueStatus).toBe("available");
    expect(getConnectorBySlug("whatsapp")?.catalogueStatus).toBe("coming_soon");
  });

  it("separates business systems from AI channels", () => {
    expect(getBusinessSystemConnectors().length).toBeGreaterThan(0);
    expect(getAiChannelConnectors().length).toBe(3);
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
