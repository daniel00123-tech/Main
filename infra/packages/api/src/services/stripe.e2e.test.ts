/**
 * Production Stripe sandbox E2E — HTTP checks against deployed worker.
 * Full wallet credit/refund simulation requires STRIPE_WEBHOOK_SECRET in the
 * probe runtime (not available in CI); see probe-stripe-e2e-acceptance.mjs.
 */
import { describe, expect, it } from "vitest";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const RUN = process.env.STRIPE_E2E === "1";

describe.runIf(RUN)("stripe production HTTP acceptance", () => {
  it("reports test/sandbox Stripe on gateway health", async () => {
    const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
    expect(health.stripeConfigured).toBe(true);
    expect(health.stripeMode).toBe("test");
    expect(health.stripePaymentsAllowed).toBe(true);
  });

  it("rejects invalid webhook signatures", async () => {
    const res = await fetch(`${API}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=0,v1=invalid",
      },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});
