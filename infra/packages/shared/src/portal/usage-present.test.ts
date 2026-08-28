import { describe, expect, it } from "vitest";
import { buildUsageSpendSummary, usageClientCategory } from "./usage-present";
import type { UsageInteraction } from "../types";

function interaction(partial: Partial<UsageInteraction>): UsageInteraction {
  return {
    id: "int_1",
    companyId: "co_test",
    actorType: "user",
    actorId: null,
    actorLabel: null,
    clientKind: "chatgpt",
    mcpId: null,
    mcpSessionId: null,
    label: "Test",
    status: "completed",
    currency: "GBP",
    operationCount: 1,
    customerChargeCents: 100,
    providerCostCents: null,
    providerCostKnown: false,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    operations: [],
    ...partial,
  };
}

describe("buildUsageSpendSummary", () => {
  it("groups AI and other spend from genuine interaction charges", () => {
    const summary = buildUsageSpendSummary([
      interaction({ clientKind: "chatgpt", customerChargeCents: 150 }),
      interaction({ id: "int_2", clientKind: "portal", customerChargeCents: 50 }),
    ]);
    expect(summary.totalCents).toBe(200);
    expect(summary.aiCents).toBe(150);
    expect(summary.otherCents).toBe(50);
  });
});

describe("usageClientCategory", () => {
  it("classifies chatgpt as AI", () => {
    expect(usageClientCategory("chatgpt")).toBe("ai");
  });
});
