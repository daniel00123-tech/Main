import { describe, expect, it } from "vitest";
import {
  isActionBetaEnabled,
  isActionProductionEnabled,
  XERO_WRITE_PRODUCTION_GATES,
} from "./beta-gates";

describe("Xero write beta gates", () => {
  it("keeps draft invoice create production enabled", () => {
    expect(isActionProductionEnabled("draftInvoiceCreate")).toBe(true);
  });

  it("gates invoice send as implemented only", () => {
    expect(isActionProductionEnabled("invoiceSend")).toBe(false);
    expect(isActionBetaEnabled("invoiceSend")).toBe(false);
  });

  it("allows invoice approve in production after beta hardening", () => {
    expect(isActionProductionEnabled("invoiceApprove", XERO_WRITE_PRODUCTION_GATES)).toBe(true);
  });
});
