import { describe, expect, it } from "vitest";
import {
  actualMarginBps,
  calculateChargeCents,
  chargeFromMarkupOnCost,
  chargeFromTargetMargin,
  centsToMicros,
  DEFAULT_MINIMUM_CHARGE_CENTS,
  DEFAULT_TARGET_MARGIN_BPS,
  microsToCentsRoundedUp,
  type PricingRule,
} from "./pricing";

const baseRule = (overrides: Partial<PricingRule> = {}): PricingRule => ({
  id: "price_test",
  companyId: null,
  action: "knowledge.search",
  pricingMode: "fixed",
  fixedChargeCents: 1,
  markupPercent: null,
  targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
  minimumChargeCents: DEFAULT_MINIMUM_CHARGE_CENTS,
  chargeOnFailure: false,
  isBillable: true,
  label: "test",
  isTestConfig: true,
  enabled: true,
  rateCardId: null,
  versionLabel: "v1",
  effectiveFrom: null,
  effectiveTo: null,
  marginBasis: "gross_margin",
  costCategory: null,
  ...overrides,
});

describe("commercial pricing engine", () => {
  it("calculates 60% gross margin as cost / 0.40 (not markup × 1.60)", () => {
    // £0.01 underlying = 10_000 micros
    const charge = chargeFromTargetMargin(10_000, 6000);
    expect(charge).toBe(3); // £0.025 → rounds up to 3p? 
    // 10000 micros / 0.4 = 25000 micros = 2.5 cents → ceil = 3 cents
    // User example: £0.01 → £0.025. With cent wallet we ceil to £0.03
    // Better example with exact cents:
    const exact = chargeFromTargetMargin(centsToMicros(4), 6000);
    // 4p cost → charge = 4/0.4 = 10p
    expect(exact).toBe(10);
    expect(actualMarginBps(10, centsToMicros(4))).toBe(6000);
  });

  it("matches documented £0.01 cost → £0.025 charge before cent rounding", () => {
    const costMicros = centsToMicros(1); // £0.01
    const chargeMicros = Math.ceil((costMicros * 10_000) / 4000);
    expect(chargeMicros).toBe(25_000); // £0.025
    expect(microsToCentsRoundedUp(chargeMicros)).toBe(3); // wallet cents ceil
  });

  it("applies minimum £0.01 when calculated selling price is below minimum", () => {
    const result = calculateChargeCents(
      baseRule({
        pricingMode: "target_margin",
        fixedChargeCents: null,
        minimumChargeCents: 1,
      }),
      {
        success: true,
        underlyingCostMicros: 2_400, // £0.0024
        costBasis: "actual",
        policy: {
          id: "p",
          companyId: null,
          targetMarginBps: 6000,
          minimumChargeCents: 1,
          currency: "GBP",
          isTestConfig: true,
          enabled: true,
          label: null,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          marginBasis: "gross_margin",
        },
      },
    );
    // calculated selling = 0.0024/0.4 = 0.006 → 1 cent ceil from formula may be 1 already
    // chargeFromTargetMargin(2400, 6000) = ceil(2400*10000/4000)=ceil(6000)=6000 micros = 1 cent
    expect(result.calculatedSellingCents).toBe(1);
    expect(result.customerChargeCents).toBe(1);
    expect(result.billable).toBe(true);
  });

  it("forces minimum when selling price is below configured minimum", () => {
    const result = calculateChargeCents(
      baseRule({
        pricingMode: "target_margin",
        fixedChargeCents: null,
        minimumChargeCents: 2, // £0.02 minimum
      }),
      {
        success: true,
        underlyingCostMicros: 100, // tiny cost → ~1p calculated
        costBasis: "actual",
      },
    );
    expect(result.calculatedSellingCents).toBe(1);
    expect(result.customerChargeCents).toBe(2);
    expect(result.minimumChargeApplied).toBe(true);
  });

  it("keeps TEST fixed 1p pricing for knowledge.search", () => {
    const result = calculateChargeCents(baseRule(), {
      success: true,
      costBasis: "unknown",
    });
    expect(result.customerChargeCents).toBe(1);
    expect(result.billable).toBe(true);
    expect(result.costBasis).toBe("unknown");
  });

  it("does not charge failed requests by default", () => {
    const result = calculateChargeCents(baseRule(), {
      success: false,
      costBasis: "unknown",
    });
    expect(result.billable).toBe(false);
    expect(result.customerChargeCents).toBeNull();
  });

  it("does not invent underlying cost when unknown", () => {
    const result = calculateChargeCents(
      baseRule({ pricingMode: "target_margin", fixedChargeCents: null }),
      { success: true, costBasis: "unknown" },
    );
    expect(result.underlyingCostCents).toBeNull();
    expect(result.costBasis).toBe("unknown");
  });

  it("distinguishes 60% gross margin from 60% markup on cost", () => {
    const cost = centsToMicros(4); // 4p
    expect(chargeFromTargetMargin(cost, 6000)).toBe(10); // 4 / 0.40
    expect(chargeFromMarkupOnCost(cost, 6000)).toBe(7); // 4 * 1.60
  });

  it("uses markup_on_cost only when a rule explicitly selects that basis", () => {
    const result = calculateChargeCents(
      baseRule({
        pricingMode: "target_margin",
        fixedChargeCents: null,
        marginBasis: "markup_on_cost",
        targetMarginBps: 6000,
      }),
      {
        success: true,
        underlyingCostMicros: centsToMicros(4),
        costBasis: "actual",
      },
    );
    expect(result.customerChargeCents).toBe(7);
  });

  it("does not invent a Xero read tariff — missing rule is zero_charge", () => {
    const result = calculateChargeCents(null, { success: true, policy: null });
    expect(result.billable).toBe(false);
    expect(result.customerChargeCents).toBeNull();
    expect(result.pricingRuleId).toBeNull();
  });
});
