import { describe, expect, it, vi } from "vitest";
import {
  initBatchState,
  nextBatchTargetIndex,
  updateBatchTargetState,
  validateBatchPlan,
  isBatchPlan,
} from "./batch-executor";
import { isAllowedInfraTestPrefix, recommendedCleanupAction } from "./xero-test-artefacts";
import { evaluateUnifiedActionPermission } from "./unified-permission";
import type { ActionPlanRecord } from "@infra/shared";

class FakeD1 {
  prepare() {
    return {
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    };
  }
}

describe("CMD11 unified permission", () => {
  it("denies platform-restricted actions", async () => {
    const decision = await evaluateUnifiedActionPermission(new FakeD1() as unknown as D1Database, {
      action: "xero.payments.allocate",
      riskClass: "financial_action",
      companyId: "co_test",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "director",
      actorType: "user",
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe("PLATFORM_RESTRICTED");
  });

  it("denies self-approval for money movement actions", async () => {
    const decision = await evaluateUnifiedActionPermission(new FakeD1() as unknown as D1Database, {
      action: "xero.credit_notes.allocate",
      riskClass: "financial_action",
      companyId: "co_test",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "director",
      actorType: "user",
      requesterEmail: "a@test.com",
      approverEmail: "a@test.com",
      flags: { financialWritesEnabled: true, writesEnabled: true },
      skipRoleCheck: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe("PLATFORM_RESTRICTED");
  });

  it("closes production gate for implemented-only actions", async () => {
    const decision = await evaluateUnifiedActionPermission(new FakeD1() as unknown as D1Database, {
      action: "xero.invoices.send",
      riskClass: "external_send",
      companyId: "co_test",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "director",
      actorType: "user",
      flags: { financialWritesEnabled: true, writesEnabled: true },
      skipRoleCheck: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe("PLATFORM_RESTRICTED");
  });
});

describe("CMD11 batch resume", () => {
  const basePlan = {
    id: "act_batch",
    companyId: "co_test",
    requestedAction: "xero.invoices.create",
    targets: [
      { targetId: "t1", targetType: "draft_invoice", humanRef: "A", currentState: {}, proposedState: {}, validation: "valid" as const },
      { targetId: "t2", targetType: "draft_invoice", humanRef: "B", currentState: {}, proposedState: {}, validation: "valid" as const },
      { targetId: "t3", targetType: "draft_invoice", humanRef: "C", currentState: {}, proposedState: {}, validation: "valid" as const },
    ],
  } as unknown as ActionPlanRecord;

  it("identifies batch plans", () => {
    expect(isBatchPlan(basePlan)).toBe(true);
    expect(isBatchPlan({ ...basePlan, targets: [basePlan.targets[0]!] })).toBe(false);
  });

  it("resumes from first pending after partial success", () => {
    let state = initBatchState(basePlan);
    state = updateBatchTargetState(state, "t1", { status: "succeeded", executionId: "ex1" });
    state = updateBatchTargetState(state, "t2", { status: "succeeded", executionId: "ex2" });
    state = updateBatchTargetState(state, "t3", { status: "failed", error: "xero error" });
    expect(nextBatchTargetIndex(state)).toBe(2);
    expect(state.targetStates[0]?.status).toBe("succeeded");
    expect(state.targetStates[1]?.status).toBe("succeeded");
  });

  it("rejects payment batch", () => {
    const plan = { ...basePlan, requestedAction: "xero.payments.allocate" };
    expect(validateBatchPlan(plan).ok).toBe(false);
  });
});

describe("CMD11 test artefact cleanup", () => {
  it("enforces INFRA prefix", () => {
    expect(isAllowedInfraTestPrefix("INFRA-CMD11-UAT-foo")).toBe(true);
    expect(isAllowedInfraTestPrefix("LEGIT-INV-001")).toBe(false);
  });

  it("recommends delete for DRAFT", () => {
    expect(
      recommendedCleanupAction({
        type: "ACCREC",
        invoiceNumber: "INV-1",
        reference: "INFRA-CMD11-UAT-x",
        xeroId: "id",
        amount: 0.01,
        status: "DRAFT",
        createdDate: "2026-08-27",
        contactName: "Test",
      }),
    ).toBe("delete_draft");
  });

  it("recommends void for AUTHORISED", () => {
    expect(
      recommendedCleanupAction({
        type: "ACCREC",
        invoiceNumber: "INV-1",
        reference: "INFRA-CMD11-UAT-x",
        xeroId: "id",
        amount: 0.01,
        status: "AUTHORISED",
        createdDate: "2026-08-27",
        contactName: "Test",
      }),
    ).toBe("void_authorised");
  });
});

describe("CMD11 credit note allocation planner", () => {
  it("exports planner function", async () => {
    const mod = await import("./xero-planner-beta");
    expect(typeof mod.planXeroCreditNoteAllocation).toBe("function");
  });
});

describe("CMD11 security matrix", () => {
  it("rejects non-INFRA cleanup targets at prefix check", () => {
    expect(isAllowedInfraTestPrefix("CUSTOMER-INV-001")).toBe(false);
  });

  it("blocks batch injection of void actions", () => {
    const plan = {
      id: "act_x",
      requestedAction: "xero.invoice.void",
      targets: [{ targetId: "1" }, { targetId: "2" }],
    } as unknown as ActionPlanRecord;
    expect(validateBatchPlan(plan).ok).toBe(false);
  });
});
