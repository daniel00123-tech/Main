import { describe, expect, it } from "vitest";
import { classifyTurnComplexity, recommendModelTier } from "./complexity-router.js";

describe("tenant-independent complexity router", () => {
  it("routes greetings to fast/local", () => {
    expect(classifyTurnComplexity({ userText: "Hi" })).toBe("fast_local");
    expect(recommendModelTier({ userText: "Hi" })).toBe("fast");
  });

  it("routes a single live business ask to standard planning", () => {
    expect(classifyTurnComplexity({ userText: "What's Xero sales this month?", hasFreshBusinessQuestion: true })).toBe(
      "standard_planning",
    );
    expect(recommendModelTier({ userText: "What's Xero sales this month?", hasFreshBusinessQuestion: true })).toBe(
      "default",
    );
  });

  it("escalates compare-and-recommend multi-system asks", () => {
    const text =
      "Compare sales, explain the change, find related emails, and recommend actions for the board this month";
    expect(classifyTurnComplexity({ userText: text, hasFreshBusinessQuestion: true })).toBe("high_complexity");
    expect(recommendModelTier({ userText: text, hasFreshBusinessQuestion: true })).toBe("reasoning");
  });

  it("reasons from existing evidence without a fresh connector call", () => {
    expect(classifyTurnComplexity({ userText: "Draft a response based on this email", canAnswerFromEvidence: true })).toBe(
      "evidence_only",
    );
    expect(recommendModelTier({ userText: "Draft a response based on this email", canAnswerFromEvidence: true })).toBe(
      "fast",
    );
  });
});
