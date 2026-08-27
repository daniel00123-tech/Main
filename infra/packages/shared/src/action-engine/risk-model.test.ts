import { describe, expect, it } from "vitest";
import { actionRiskProfile, XERO_ACTION_RISK_MAP } from "./risk-model";

describe("action risk model", () => {
  it("maps draft invoice create to DRAFT_WRITE", () => {
    expect(XERO_ACTION_RISK_MAP["xero.invoices.create"]).toBe("DRAFT_WRITE");
    const profile = actionRiskProfile("xero.invoices.create");
    expect(profile.requiresConfirmation).toBe(true);
    expect(profile.requiresEnhancedConfirmation).toBe(false);
    expect(profile.idempotencyMandatory).toBe(true);
  });

  it("maps invoice approve to ACCOUNTING_COMMITMENT with enhanced confirmation", () => {
    const profile = actionRiskProfile("xero.invoices.approve");
    expect(profile.level).toBe("ACCOUNTING_COMMITMENT");
    expect(profile.requiresEnhancedConfirmation).toBe(true);
    expect(profile.warning).toContain("accounting");
  });

  it("maps invoice send to EXTERNAL_COMMUNICATION", () => {
    expect(actionRiskProfile("xero.invoices.send").level).toBe("EXTERNAL_COMMUNICATION");
  });

  it("maps payment allocation to MONEY_MOVEMENT", () => {
    expect(actionRiskProfile("xero.payments.allocate").level).toBe("MONEY_MOVEMENT");
    expect(actionRiskProfile("xero.payments.allocate").requiresApproval).toBe(true);
  });
});
