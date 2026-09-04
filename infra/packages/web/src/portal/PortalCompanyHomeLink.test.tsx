import { describe, expect, it } from "vitest";
import { portalCompanyHomePath, portalOverviewPath } from "./PortalCompanyHomeLink";

describe("company portal paths", () => {
  it("uses Chat as the company home and keeps Overview as a deep link", () => {
    expect(portalCompanyHomePath("caddington-holdings")).toBe("/portal/caddington-holdings/chat");
    expect(portalCompanyHomePath("heattech")).toBe("/portal/heattech/chat");
    expect(portalOverviewPath("caddington-holdings")).toBe("/portal/caddington-holdings/dashboard");
    expect(portalOverviewPath("heattech")).toBe("/portal/heattech/dashboard");
  });

  it("encodes slug segments safely", () => {
    expect(portalCompanyHomePath("acme co")).toBe("/portal/acme%20co/chat");
    expect(portalOverviewPath("acme co")).toBe("/portal/acme%20co/dashboard");
  });
});
