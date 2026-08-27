import { describe, expect, it } from "vitest";
import {
  PLATFORM_XERO_SAFETY_CEILING,
  isPlatformBlockedXeroAction,
  XERO_PERMISSION_GROUPS,
} from "@infra/shared";
import { validateBatchPlan, BATCH_MAX_DRAFT_INVOICES } from "./batch-executor";
import type { ActionPlanRecord } from "@infra/shared";

describe("Xero permission groups", () => {
  it("blocks platform ceiling actions from tenant override", () => {
    expect(isPlatformBlockedXeroAction("xero.invoices.send")).toBe(true);
    expect(isPlatformBlockedXeroAction("xero.invoices.create")).toBe(false);
    expect(PLATFORM_XERO_SAFETY_CEILING.has("xero.payments.allocate")).toBe(true);
  });

  it("defines grouped Xero permissions", () => {
    expect(XERO_PERMISSION_GROUPS.some((g) => g.id === "xero_sales")).toBe(true);
    expect(XERO_PERMISSION_GROUPS.some((g) => g.id === "xero_destructive")).toBe(true);
  });
});

describe("batch executor", () => {
  const basePlan = {
    id: "act_1",
    companyId: "co_test",
    requestedAction: "xero.invoices.create",
    targets: [{ targetId: "1", targetType: "draft_invoice", humanRef: "A", currentState: {}, proposedState: {}, validation: "valid" as const }],
  } as unknown as ActionPlanRecord;

  it("rejects bulk send", () => {
    const plan = { ...basePlan, requestedAction: "xero.invoices.send", targets: [basePlan.targets[0], basePlan.targets[0]] };
    expect(validateBatchPlan(plan).ok).toBe(false);
  });

  it("limits draft invoice batch size", () => {
    const targets = Array.from({ length: BATCH_MAX_DRAFT_INVOICES + 1 }, (_, i) => ({
      ...basePlan.targets[0],
      targetId: String(i),
    }));
    const plan = { ...basePlan, targets };
    const result = validateBatchPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BATCH_LIMIT_EXCEEDED");
  });
});

describe("update draft planner types", () => {
  it("exports plan function", async () => {
    const mod = await import("./xero-planner-beta");
    expect(typeof mod.planXeroUpdateDraftInvoice).toBe("function");
    expect(typeof mod.planXeroApproveCreditNote).toBe("function");
    expect(typeof mod.planXeroVoidDocument).toBe("function");
  });
});
