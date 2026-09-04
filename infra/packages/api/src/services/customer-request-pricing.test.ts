import { describe, expect, it } from "vitest";
import {
  companyUsesRequestLevelPricing,
  futureTenantNeedsExplicitPricing,
  requestLevelChargeCents,
  resolveRequestPricingPolicy,
} from "./customer-request-pricing.js";
import { classifyElTraffic, shouldChargeElCustomerRequest } from "./el-customer-billing.js";

describe("request-level pricing policy", () => {
  it("keeps EL at 3p per customer request", () => {
    expect(resolveRequestPricingPolicy("co_el")?.chargeCents).toBe(3);
    expect(companyUsesRequestLevelPricing("co_el")).toBe(true);
    expect(requestLevelChargeCents("co_el")).toBe(3);
    expect(shouldChargeElCustomerRequest("co_el", "CUSTOMER_REQUEST")).toBe(true);
  });

  it("does not apply EL 3p to Caddington, HT, or a future tenant", () => {
    expect(resolveRequestPricingPolicy("co_caddington")).toBeNull();
    expect(resolveRequestPricingPolicy("co_ht")).toBeNull();
    expect(resolveRequestPricingPolicy("co_newco")).toBeNull();
    expect(futureTenantNeedsExplicitPricing("co_newco")).toBe(true);
    expect(shouldChargeElCustomerRequest("co_caddington", "CUSTOMER_REQUEST")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_ht", "CUSTOMER_REQUEST")).toBe(false);
  });

  it("never charges automation, shadow, quality, or health traffic", () => {
    expect(classifyElTraffic({ sourceClient: "automation-engine" })).toBe("AUTOMATION");
    expect(classifyElTraffic({ shadow: true, sourceClient: "portal_chat" })).toBe("SHADOW");
    expect(classifyElTraffic({ sourceClient: "quality_loop" })).toBe("QUALITY");
    expect(classifyElTraffic({ sourceClient: "health" })).toBe("HEALTH");
    expect(shouldChargeElCustomerRequest("co_el", "AUTOMATION")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_el", "SHADOW")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_el", "QUALITY")).toBe(false);
    expect(shouldChargeElCustomerRequest("co_el", "HEALTH")).toBe(false);
  });
});
