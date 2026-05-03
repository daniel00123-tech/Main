import { describe, expect, it } from "vitest";
import { calculateMarketplaceFees } from "@/services/fee-service";

describe("calculateMarketplaceFees", () => {
  it("applies 10% customer fee and a 1 GBP supplier fee", () => {
    expect(calculateMarketplaceFees(10000)).toEqual({
      jobAmount: 10000,
      customerFee: 1000,
      supplierFee: 100,
      customerTotal: 11000,
      supplierReceives: 9900,
      platformFeeTotal: 1100,
    });
  });

  it("rejects invalid job amounts", () => {
    expect(() => calculateMarketplaceFees(0)).toThrow("Job amount must be a positive integer");
  });
});
