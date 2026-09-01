import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_SCENARIOS,
  ADVERSARIAL_SUITE_VERSION,
  FALLBACK_ADAPTERS,
  applyAdapter,
  assertSuiteIntegrity,
  instantiateScenarios,
  instantiateTwentyTurn,
} from "./adversarial-scenarios.js";
import { bandFor, compareSummaries, scoreTurn, summariseCaptures } from "./adversarial-score.js";
import { runAdversarialSuite } from "./adversarial-runner.js";
import type { IntelligenceTurnResult } from "../types.js";

describe("adversarial 100-scenario harness", () => {
  it("contains exactly 50 distinct intents and frozen suite version", () => {
    const integrity = assertSuiteIntegrity();
    expect(integrity.count).toBe(50);
    expect(new Set(integrity.intents).size).toBe(50);
    expect(ADVERSARIAL_SUITE_VERSION).toBe("adversarial-100-v1");
    expect(ADVERSARIAL_SCENARIOS[0]?.intent).toBe("greeting");
    expect(ADVERSARIAL_SCENARIOS[49]?.intent).toBe("mini_conversation");
    expect(ADVERSARIAL_SCENARIOS[49]?.turns?.length).toBeGreaterThanOrEqual(10);
    expect(ADVERSARIAL_SCENARIOS[49]?.turns?.length).toBeLessThanOrEqual(15);
  });

  it("adapts subjects per tenant without baking Caddington-only names into the suite", () => {
    const raw = JSON.stringify(ADVERSARIAL_SCENARIOS);
    expect(raw).not.toMatch(/Van Policy|CV 2015|Coal Search|William/i);
    const cadd = instantiateScenarios(FALLBACK_ADAPTERS.caddington);
    const elvex = instantiateScenarios(FALLBACK_ADAPTERS.elvex);
    expect(cadd).toHaveLength(50);
    expect(elvex).toHaveLength(50);
    expect(cadd[7]?.text).toContain(FALLBACK_ADAPTERS.caddington.primary);
    expect(elvex[7]?.text).toContain(FALLBACK_ADAPTERS.elvex.primary);
    expect(cadd[7]?.text).not.toBe(elvex[7]?.text);
    expect(applyAdapter("Find the {primary}", FALLBACK_ADAPTERS.elvex)).toBe("Find the service agreement");
    expect(instantiateTwentyTurn(FALLBACK_ADAPTERS.caddington)).toHaveLength(20);
  });

  it("marks invented confident answers UNUSABLE", () => {
    const scenario = ADVERSARIAL_SCENARIOS[6]!;
    const result = baseResult({
      text: "There are exactly 12,345 files on the system.",
      confidence: "strong",
      kind: "answer",
    });
    const scored = scoreTurn({
      scenario,
      tenant: "caddington",
      text: scenario.text,
      turnIndex: 0,
      result,
      latencyMs: 80,
      transport: "OFFLINE",
    });
    expect(scored.band).toBe("UNUSABLE");
    expect(scored.invented || scored.score <= 15).toBe(true);
  });

  it("compares before/after without rewarding more invented answers", () => {
    const before = summariseCaptures([
      fakeCapture(80, "GOOD", false),
      fakeCapture(70, "ACCEPTABLE", false),
    ]);
    const worse = summariseCaptures([
      fakeCapture(90, "GOOD", true),
      fakeCapture(90, "UNUSABLE", true),
    ]);
    expect(compareSummaries(before, worse).objectivelyBetter).toBe(false);
    const better = summariseCaptures([
      fakeCapture(88, "GOOD", false),
      fakeCapture(82, "GOOD", false),
    ]);
    expect(compareSummaries(before, better).objectivelyBetter).toBe(true);
  });

  it("runs the offline 100 (50 x 2 tenants) through the same intelligence path", async () => {
    const run = await runAdversarialSuite({ mode: "offline" });
    expect(run.rows.length).toBeGreaterThanOrEqual(100);
    expect(run.tenants.map((row) => row.tenant).sort()).toEqual(["caddington", "elvex"]);
    expect(run.transport).toBe("OFFLINE");
    expect(run.summary.cases).toBe(run.rows.length);
    expect(run.perTenant.caddington.cases).toBe(run.perTenant.elvex.cases);
    expect(run.rows.every((row) => row.reply.length > 0 || row.kind === "failed")).toBe(true);
  }, 30_000);
});

function baseResult(partial: Partial<IntelligenceTurnResult>): IntelligenceTurnResult {
  return {
    kind: "answer",
    text: "Hi — what do you need?",
    confidence: "strong",
    offerSearchOther: false,
    toolCalls: [],
    currentDocument: null,
    evidenceDocumentIds: [],
    clarification: false,
    citeSource: false,
    modelRounds: [],
    totalModelMs: 4,
    totalToolMs: 0,
    provider: "none",
    model: null,
    estimatedCostUsd: 0,
    route: "FAST_LOCAL",
    scope: "GENERAL_CONVERSATION",
    ...partial,
  };
}

function fakeCapture(score: number, band: "GOOD" | "ACCEPTABLE" | "POOR" | "UNUSABLE", invented: boolean) {
  return {
    scenarioId: "s01",
    tenant: "caddington" as const,
    intent: "greeting",
    text: "Hi",
    turnIndex: 0,
    scope: "GENERAL_CONVERSATION",
    route: "FAST_LOCAL",
    tools: [],
    toolOk: [],
    evidenceIds: [],
    reply: invented ? "exactly 12,345 files" : "Hi — happy to help.",
    confidence: "strong",
    kind: "answer",
    latencyMs: 20,
    modelMs: 0,
    toolMs: 0,
    permission: "admin",
    metered: false,
    invented,
    grounded: !invented,
    assistantLike: true,
    flags: [],
    transport: "OFFLINE" as const,
    score,
    band,
    cluster: invented ? ("SEARCH/INDEX" as const) : null,
    reasons: invented ? ["invented_confident"] : [],
  };
}

void bandFor;
