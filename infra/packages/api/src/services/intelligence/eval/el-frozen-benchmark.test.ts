import { describe, expect, it } from "vitest";
import { compareFrozenBrains, frozenElCases } from "./el-frozen-benchmark.js";

describe("EL frozen 100-turn benchmark", () => {
  it("covers 100 frozen turns and scores Cloudflare vs OpenAI-quality completer", async () => {
    expect(frozenElCases()).toHaveLength(100);
    const compared = await compareFrozenBrains();
    expect(compared.cloudflare.cases).toBe(100);
    expect(compared.openai.cases).toBe(100);
    expect(compared.cloudflare.rbac).toBe(100);
    expect(compared.openai.rbac).toBe(100);
    expect(compared.cloudflare.overall).toBeGreaterThan(50);
    expect(compared.openai.overall).toBeGreaterThan(50);
    // eslint-disable-next-line no-console
    console.log("FROZEN_BENCH", JSON.stringify({ cloudflare: compared.cloudflare, openai: compared.openai, winner: compared.winner }));
  });
});
