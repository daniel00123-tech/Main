import { describe, expect, it } from "vitest";
import {
  buildKnowledgeNotConfiguredGuidance,
  buildWeakEvidenceGuidance,
} from "../src/retrieval/confidence-guidance";
import {
  classifyChunkConfidence,
  classifyOverallConfidence,
} from "../src/retrieval/ranking";

describe("confidence classification", () => {
  it("classifies strong evidence", () => {
    expect(classifyChunkConfidence(1.5, 0.5, 0.2, 0.2)).toBe("strong");
  });

  it("classifies weak evidence", () => {
    expect(classifyChunkConfidence(0.2, 0.1, 0, 0)).toBe("weak");
  });

  it("classifies overall weak when empty", () => {
    expect(classifyOverallConfidence([], 8)).toBe("weak");
  });
});

describe("confidence guidance", () => {
  it("returns empty-results guidance", () => {
    const guidance = buildWeakEvidenceGuidance({
      companyName: "EL Business",
      overallConfidence: "weak",
      resultCount: 0,
    });
    expect(guidance).toContain("No indexed EL Business knowledge");
  });

  it("returns not configured guidance", () => {
    expect(buildKnowledgeNotConfiguredGuidance("HT Business")).toContain(
      "not configured"
    );
  });
});
