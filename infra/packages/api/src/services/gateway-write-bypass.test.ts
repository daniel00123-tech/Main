import { describe, expect, it } from "vitest";
import { isXeroWriteToolName } from "./xero-tools";

describe("gateway direct write bypass protection", () => {
  it("classifies draft invoice, credit note, and allocation as write tools", () => {
    expect(isXeroWriteToolName("xero_create_draft_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_create_credit_note")).toBe(true);
    expect(isXeroWriteToolName("xero_allocate_payment")).toBe(true);
    expect(isXeroWriteToolName("xero_approve_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_send_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_create_draft_bill")).toBe(true);
  });

  it("does not classify read tools as write tools", () => {
    expect(isXeroWriteToolName("xero_search_invoices")).toBe(false);
    expect(isXeroWriteToolName("xero_get_organisation")).toBe(false);
    expect(isXeroWriteToolName("xero_sales_summary")).toBe(false);
    expect(isXeroWriteToolName("xero_profit_and_loss")).toBe(false);
  });
});
