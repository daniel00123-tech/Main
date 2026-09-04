import { describe, expect, it } from "vitest";
import { platformToolCases, scorePlatformToolBenchLocal } from "./platform-tool-bench.js";

describe("platform 100-turn tool bench", () => {
  it("covers the shared 100-turn mix without company-specific phrases", () => {
    const cases = platformToolCases();
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(cases.filter((row) => row.family === "outlook").length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((row) => row.family === "xero").length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((row) => row.family === "knowledge").length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((row) => row.family === "catalogue").length).toBeGreaterThanOrEqual(15);
    expect(cases.some((row) => /elvexpropertyservices|sharon|caddington/i.test(row.text))).toBe(false);
  });

  it("scores the local platform mix with no inbox/xero misses and no system swaps", async () => {
    const scored = await scorePlatformToolBenchLocal();
    expect(scored.scorecard.cases).toBeGreaterThanOrEqual(100);
    expect(scored.scorecard.inboxNoTool).toBe(0);
    expect(scored.scorecard.xeroNoTool).toBe(0);
    expect(scored.scorecard.knowledgeToXero).toBe(0);
    expect(scored.scorecard.emailToXero).toBe(0);
    expect(scored.scorecard.familyAgreement).toBeGreaterThanOrEqual(90);
  });
});
