import { describe, expect, it } from "vitest";
import {
  pickContactFromRankedMatches,
  rankContactNameMatches,
  scoreContactNameMatch,
} from "./xero-contact-resolve";

describe("scoreContactNameMatch", () => {
  it("matches exact and short names against full Xero contact names", () => {
    expect(scoreContactNameMatch("Elvex", "Elvex Property Services")).toBeGreaterThan(85);
    expect(scoreContactNameMatch("elvex", "ELVEX Property Services")).toBeGreaterThan(85);
    expect(scoreContactNameMatch("Elvex Property Services", "Elvex Property Services")).toBe(100);
  });

  it("returns zero for unrelated names", () => {
    expect(scoreContactNameMatch("Acme", "Elvex Property Services")).toBe(0);
  });
});

describe("pickContactFromRankedMatches", () => {
  const elvex = { ContactID: "id-elvex", Name: "Elvex Property Services" };
  const elvex2 = { ContactID: "id-elvex-2", Name: "Elvex Maintenance Ltd" };

  it("resolves a single unambiguous match", () => {
    const ranked = rankContactNameMatches("Elvex", [elvex]);
    const result = pickContactFromRankedMatches("Elvex", ranked);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contact.contactId).toBe("id-elvex");
      expect(result.contact.contactName).toBe("Elvex Property Services");
    }
  });

  it("returns ambiguous when multiple contacts score similarly", () => {
    const ranked = rankContactNameMatches("Elvex", [elvex, elvex2]);
    const result = pickContactFromRankedMatches("Elvex", ranked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validation).toBe("ambiguous");
      expect(result.candidates?.length).toBeGreaterThan(1);
    }
  });
});
