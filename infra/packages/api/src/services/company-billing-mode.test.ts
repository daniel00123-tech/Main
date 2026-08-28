import { describe, expect, it } from "vitest";
import {
  companyCanReceiveLiveWalletCredit,
  companyStripeCheckoutAllowed,
  stripeCheckoutAllowedForCompany,
} from "./company-billing-mode";
import { STRIPE_LIVE_MODE_ALLOWED } from "./stripe";

describe("company billing mode vs Stripe platform", () => {
  const testEnv = {
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  } as never;

  const liveEnv = {
    STRIPE_SECRET_KEY: "sk_live_abc",
    STRIPE_WEBHOOK_SECRET: "whsec_live",
  } as never;

  it("allows test-mode checkout for test billing companies", () => {
    expect(companyStripeCheckoutAllowed(testEnv, "test").allowed).toBe(true);
    expect(stripeCheckoutAllowedForCompany(testEnv, "test")).toBe(true);
  });

  it("allows test-mode checkout even when company billing mode is live", () => {
    expect(companyStripeCheckoutAllowed(testEnv, "live").allowed).toBe(true);
  });

  it("blocks live checkout for test billing companies when platform is live", () => {
    const result = companyStripeCheckoutAllowed(liveEnv, "test");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("billing mode is test");
  });

  it("allows live checkout when STRIPE_LIVE_MODE_ALLOWED is true", () => {
    expect(STRIPE_LIVE_MODE_ALLOWED).toBe(true);
    const result = companyStripeCheckoutAllowed(liveEnv, "live");
    expect(result.allowed).toBe(true);
  });

  it("companyCanReceiveLiveWalletCredit requires live billing mode", () => {
    expect(companyCanReceiveLiveWalletCredit("live")).toBe(true);
    expect(companyCanReceiveLiveWalletCredit("test")).toBe(false);
  });
});
