import { describe, expect, it } from "vitest";
import {
  buildSearchGuidance,
  CADDINGTON_SERVER_INSTRUCTIONS,
  SEARCH_COMPANY_KNOWLEDGE_DESCRIPTION,
} from "../src/caddington-usage";

describe("caddington usage policy", () => {
  it("includes authoritative usage rules in server instructions", () => {
    expect(CADDINGTON_SERVER_INSTRUCTIONS).toContain("authoritative");
    expect(CADDINGTON_SERVER_INSTRUCTIONS).toContain("search_company_knowledge");
    expect(CADDINGTON_SERVER_INSTRUCTIONS).toContain("Never invent");
  });

  it("describes search tool as authoritative Caddington source", () => {
    expect(SEARCH_COMPANY_KNOWLEDGE_DESCRIPTION).toContain("Authoritative");
    expect(SEARCH_COMPANY_KNOWLEDGE_DESCRIPTION).toContain("provenance");
  });

  it("returns guidance for empty and weak-confidence results", () => {
    expect(buildSearchGuidance("weak", 0)).toContain("No matching");
    expect(buildSearchGuidance("weak", 3)).toContain("confidence is weak");
    expect(buildSearchGuidance("strong", 3)).toBeUndefined();
    expect(buildSearchGuidance("plausible", 2)).toBeUndefined();
  });
});
