import { describe, expect, it } from "vitest";
import { pickTaxTypeForTreatment } from "./tax-rates";

describe("pickTaxTypeForTreatment", () => {
  const ukRates = [
    { Name: "20% (VAT on Income)", TaxType: "OUTPUT2", EffectiveRate: 20, Status: "ACTIVE" },
    { Name: "No VAT", TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" },
    { Name: "Zero Rated Income", TaxType: "ZERORATEDOUTPUT", EffectiveRate: 0, Status: "ACTIVE" },
  ];

  it("selects No VAT tax type for natural-language no vat treatment", () => {
    const picked = pickTaxTypeForTreatment(ukRates, { taxTreatment: "No VAT" });
    expect(picked.taxType).toBe("NONE");
    expect(picked.label).toBe("No VAT");
  });

  it("uses account default when treatment is unspecified", () => {
    const picked = pickTaxTypeForTreatment(ukRates, { accountDefaultTaxType: "ZERORATEDOUTPUT" });
    expect(picked.taxType).toBe("ZERORATEDOUTPUT");
  });

  it("accepts explicit taxtype prefix", () => {
    const picked = pickTaxTypeForTreatment(ukRates, { taxTreatment: "taxtype:OUTPUT2" });
    expect(picked.taxType).toBe("OUTPUT2");
  });
});
