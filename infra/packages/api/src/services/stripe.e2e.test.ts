/**
 * Production Stripe sandbox E2E — runs against remote D1 + live worker secrets.
 * Execute: STRIPE_E2E=1 npx vitest run src/services/stripe.e2e.test.ts
 * Never logs secret values.
 */
import { describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTopUpCheckoutIntent,
  getStripeMode,
  isStripeConfigured,
} from "./stripe";
import { getWalletBalance } from "./ledger";
import type { Env } from "../env";

const RUN = process.env.STRIPE_E2E === "1";
const COMPANY_ID = "co_caddington";
const COMPANY_NAME = "Caddington Holdings Ltd";
const API = "https://infra-api.daniel-dwyer123.workers.dev";

async function signStripeWebhook(payload: string, secret: string): Promise<string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const sig = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${sig}`;
}

describe.runIf(RUN)("stripe sandbox production E2E", () => {
  let env: Env;
  let dispose: () => Promise<void>;
  let checkoutId: string;
  let paymentIntentId: string;
  let balanceBefore = 0;

  it("confirms test/sandbox configuration", async () => {
    const proxy = await getPlatformProxy({
      configPath: join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml"),
      remoteBindings: true,
    });
    env = proxy.env as Env;
    dispose = proxy.dispose;

    expect(isStripeConfigured(env)).toBe(true);
    expect(getStripeMode(env)).toBe("test");

    const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());
    expect(health.stripeConfigured).toBe(true);
    expect(health.stripeMode).toBe("test");
    expect(health.stripePaymentsAllowed).toBe(true);
  });

  it("creates £1 sandbox checkout and credits wallet via signed webhook", async () => {
    balanceBefore = (await getWalletBalance(env.DB, COMPANY_ID)).balanceCents;

    const created = await createTopUpCheckoutIntent(env, {
      companyId: COMPANY_ID,
      companyName: COMPANY_NAME,
      amountCents: 100,
      createdBy: "stripe-e2e-probe@infra.local",
      successUrl: "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=success",
      cancelUrl: "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=cancelled",
    });
    expect(created.configured).toBe(true);
    if (!created.configured || !("localId" in created)) throw new Error("Checkout not created");
    checkoutId = created.localId;
    paymentIntentId = `pi_e2e_${checkoutId.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`;

    await env.DB.prepare(
      `UPDATE stripe_checkout_sessions SET stripe_payment_intent_id = ? WHERE id = ?`,
    )
      .bind(paymentIntentId, checkoutId)
      .run();

    const eventPayload = {
      id: `evt_e2e_complete_${checkoutId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: created.checkoutSessionId ?? `cs_e2e_${checkoutId}`,
          payment_status: "paid",
          client_reference_id: checkoutId,
          metadata: {
            company_id: COMPANY_ID,
            infra_company_id: COMPANY_ID,
            infra_checkout_id: checkoutId,
            amount_cents: "100",
            currency: "GBP",
          },
          amount_total: 100,
          currency: "gbp",
          payment_intent: paymentIntentId,
        },
      },
    };
    const body = JSON.stringify(eventPayload);
    const signature = await signStripeWebhook(body, env.STRIPE_WEBHOOK_SECRET!);

    const httpRes = await fetch(`${API}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body,
    });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json();
    expect(httpBody.processed).toBe(true);

    const balanceAfter = (await getWalletBalance(env.DB, COMPANY_ID)).balanceCents;
    expect(balanceAfter - balanceBefore).toBe(100);

    const duplicateRes = await fetch(`${API}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body,
    });
    const duplicateBody = await duplicateRes.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect((await getWalletBalance(env.DB, COMPANY_ID)).balanceCents).toBe(balanceAfter);
  });

  it("records incremental refund via charge.refunded webhook", async () => {
    const beforeRefund = (await getWalletBalance(env.DB, COMPANY_ID)).balanceCents;

    const refundPayload = {
      id: `evt_e2e_refund_${checkoutId}`,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_e2e_${checkoutId}`,
          payment_intent: paymentIntentId,
          amount_refunded: 100,
        },
      },
    };
    const body = JSON.stringify(refundPayload);
    const signature = await signStripeWebhook(body, env.STRIPE_WEBHOOK_SECRET!);

    const res = await fetch(`${API}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.processed).toBe(true);

    const afterRefund = (await getWalletBalance(env.DB, COMPANY_ID)).balanceCents;
    expect(afterRefund - beforeRefund).toBe(-100);
    expect(afterRefund).toBe(balanceBefore);
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

  it("cleans up remote proxy", async () => {
    await dispose();
  });
});
