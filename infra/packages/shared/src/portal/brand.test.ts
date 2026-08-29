import { describe, expect, it } from "vitest";
import { companyDisplayName, companyInitials, companyLogoUrl } from "./brand";

describe("companyDisplayName", () => {
  it("prefers trading name when present", () => {
    expect(companyDisplayName({ name: "Caddington Holdings Ltd", tradingName: "Caddington" })).toBe(
      "Caddington",
    );
  });

  it("falls back to legal name", () => {
    expect(companyDisplayName({ name: "Heattech Ltd", tradingName: null })).toBe("Heattech Ltd");
  });
});

describe("companyInitials", () => {
  it("uses the first letter of the first two words", () => {
    expect(companyInitials("Caddington Holdings")).toBe("CH");
    expect(companyInitials("EL Business")).toBe("EB");
  });

  it("uses two letters from a single word", () => {
    expect(companyInitials("Acme")).toBe("AC");
  });

  it("falls back when the name is empty", () => {
    expect(companyInitials("   ")).toBe("CO");
  });
});

describe("companyLogoUrl", () => {
  it("reads logoUrl then branding.logoUrl", () => {
    expect(companyLogoUrl({ logoUrl: "https://cdn.example/logo.png", branding: {} })).toBe(
      "https://cdn.example/logo.png",
    );
    expect(companyLogoUrl({ logoUrl: null, branding: { logoUrl: "https://cdn.example/b.png" } })).toBe(
      "https://cdn.example/b.png",
    );
    expect(companyLogoUrl({ logoUrl: null, branding: {} })).toBeNull();
  });
});
