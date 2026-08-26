import { describe, expect, it } from "vitest";
import {
  normalizeCompanySlug,
  RESERVED_COMPANY_SLUGS,
  slugifyCompanyName,
  validateCompanySlug,
} from "./company";

describe("company slug rules", () => {
  it("slugifies legal names", () => {
    expect(slugifyCompanyName("ABC Plumbing Ltd")).toBe("abc-plumbing-ltd");
    expect(slugifyCompanyName("Heat & Air")).toBe("heat-and-air");
  });

  it("rejects reserved and unsafe slugs", () => {
    expect(validateCompanySlug("admin").ok).toBe(false);
    expect(validateCompanySlug("portal").ok).toBe(false);
    expect(validateCompanySlug("mcp").ok).toBe(false);
    expect(validateCompanySlug("javascript").ok).toBe(false);
    expect(RESERVED_COMPANY_SLUGS.has("caddington-holdings")).toBe(false);
  });

  it("accepts ordinary tenant slugs", () => {
    expect(validateCompanySlug("abc-plumbing-ltd")).toEqual({
      ok: true,
      slug: "abc-plumbing-ltd",
    });
    expect(validateCompanySlug("caddington-holdings").ok).toBe(true);
    expect(validateCompanySlug("ht-business").ok).toBe(true);
  });

  it("normalises dirty input before validating", () => {
    expect(normalizeCompanySlug("  ABC Plumbing  ")).toBe("abc-plumbing");
    expect(validateCompanySlug("ABC Plumbing!!").ok).toBe(true);
  });
});
