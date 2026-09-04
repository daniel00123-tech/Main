import { describe, expect, it } from "vitest";
import { classifyUsageFailure } from "./format";

describe("usage failure categories for the admin Usage page", () => {
  it("classifies settlement_status=denied as PERMISSION, not UNKNOWN", () => {
    expect(
      classifyUsageFailure({
        success: false,
        settlementStatus: "denied",
        toolName: "xero_sales_summary",
        metadata: { denied: true, reason: "Office Staff permissions don’t allow access" },
      }),
    ).toBe("PERMISSION");
  });

  it("classifies pre-fix Xero execution failures as UPSTREAM_API", () => {
    expect(
      classifyUsageFailure({
        success: false,
        settlementStatus: "zero_charge",
        toolName: "xero_sales_summary",
        recordedAt: "2026-09-01T21:11:51.986Z",
        durationMs: 2011,
        metadata: {},
      }),
    ).toBe("UPSTREAM_API");
  });

  it("does not treat successful empty results as a failure category", () => {
    expect(
      classifyUsageFailure({
        success: true,
        toolName: "xero_search_invoices",
        metadata: { accessOutcome: "empty_result" },
      }),
    ).toBeNull();
  });
});
