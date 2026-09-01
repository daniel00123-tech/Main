import { describe, expect, it } from "vitest";
import {
  attributableCostCents,
  classifyUsageResource,
  computeMargin,
  estimateStripeFeeCents,
  ocrCostCentsFromUsage,
  perActiveUser,
  resolveEconomicsPeriod,
  usdToGbpCents,
} from "./customer-economics";

describe("customer economics calculations", () => {
  it("resolves current and previous month in UTC", () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    const current = resolveEconomicsPeriod({ preset: "current_month" }, now);
    expect(current.from).toBe("2026-08-01T00:00:00.000Z");
    expect(current.to).toBe(now.toISOString());
    const previous = resolveEconomicsPeriod({ preset: "previous_month" }, now);
    expect(previous.from).toBe("2026-07-01T00:00:00.000Z");
    expect(previous.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("estimates Stripe UK fees from published rates", () => {
    expect(estimateStripeFeeCents(10000)).toBe(170);
    expect(estimateStripeFeeCents(0)).toBe(0);
  });

  it("estimates OCR cost from pages and metadata without inventing zero as known", () => {
    const fromPages = ocrCostCentsFromUsage({ quantity: 10, unit: "pages", metadata: {} });
    expect(fromPages.basis).toBe("estimated");
    expect(fromPages.cents).toBeGreaterThan(0);
    const fromUsd = ocrCostCentsFromUsage({ metadata: { estimatedUsd: 0.015 } });
    expect(fromUsd.cents).toBe(usdToGbpCents(0.015));
    const unknown = ocrCostCentsFromUsage({ metadata: {} });
    expect(unknown).toEqual({ cents: 0, basis: "unknown" });
  });

  it("does not treat unknown AI cost as £0 attributable", () => {
    const cost = attributableCostCents({
      classification: "ai_model",
      costBasis: "unknown",
      underlyingCostCents: null,
    });
    expect(cost).toEqual({ cents: 0, basis: "unknown" });
  });

  it("uses actual underlying cost when present", () => {
    const cost = attributableCostCents({
      classification: "other",
      costBasis: "actual",
      underlyingCostCents: 42,
    });
    expect(cost).toEqual({ cents: 42, basis: "actual" });
  });

  it("classifies OCR, AI, and other usage", () => {
    expect(classifyUsageResource({ resourceType: "knowledge_ocr" }).classification).toBe("ocr");
    expect(classifyUsageResource({ toolName: "openai.chat", unit: "tokens" }).classification).toBe("ai_model");
    expect(classifyUsageResource({ resourceType: "gateway", toolName: "search" }).classification).toBe("other");
    expect(classifyUsageResource({ resourceType: "whatsapp_transcription", action: "whatsapp.transcribe" }).service).toBe(
      "whatsapp_transcription",
    );
  });

  it("computes margin and leaves percent null when revenue is zero", () => {
    expect(computeMargin(1000, 250)).toEqual({
      grossProfitCents: 750,
      grossMarginPercent: 75,
    });
    expect(computeMargin(0, 0).grossMarginPercent).toBeNull();
    expect(computeMargin(0, 10)).toEqual({
      grossProfitCents: -10,
      grossMarginPercent: null,
    });
  });

  it("keeps per-user metrics null when there are no active users", () => {
    expect(perActiveUser(100, 0)).toBeNull();
    expect(perActiveUser(100, 4)).toBe(25);
  });
});
