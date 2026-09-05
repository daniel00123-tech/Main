import { describe, expect, it } from "vitest";
import { knowledgeSearchTokens } from "./company-knowledge-index";

describe("company knowledge search tokens", () => {
  it("prefers the distinctive invoice number over the generic INV prefix", () => {
    expect(knowledgeSearchTokens("INV-02277.pdf")[0]).toBe("02277");
    expect(knowledgeSearchTokens("INV 02277")[0]).toBe("02277");
  });
});
