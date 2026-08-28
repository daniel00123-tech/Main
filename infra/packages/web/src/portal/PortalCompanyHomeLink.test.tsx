import { describe, expect, it } from "vitest";
import { portalOverviewPath } from "./PortalCompanyHomeLink";

describe("portalOverviewPath", () => {
  it("builds canonical company overview route from tenant slug", () => {
    expect(portalOverviewPath("caddington-holdings")).toBe(
      "/portal/caddington-holdings/dashboard",
    );
    expect(portalOverviewPath("heattech")).toBe("/portal/heattech/dashboard");
  });

  it("encodes slug segments safely", () => {
    expect(portalOverviewPath("acme co")).toBe("/portal/acme%20co/dashboard");
  });
});
