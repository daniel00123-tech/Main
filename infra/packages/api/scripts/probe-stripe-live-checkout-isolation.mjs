#!/usr/bin/env node
/**
 * Create uncompleted LIVE checkout sessions to prove billing isolation (no payment).
 * Never prints secret values.
 */
import { unstable_dev } from "wrangler";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_AMOUNT_CENTS = 100;

async function createCheckout(worker, companyId, companyName, billingModeLabel) {
  const env = worker.env;
  const { createTopUpCheckoutIntent } = await import("../src/services/stripe.ts");
  const result = await createTopUpCheckoutIntent(env, {
    companyId,
    companyName,
    amountCents: LIVE_AMOUNT_CENTS,
    createdBy: "stripe-live-activation-probe",
    successUrl: "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=success",
    cancelUrl: "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=cancelled",
  });
  return {
    companyId,
    billingModeLabel,
    amountCents: LIVE_AMOUNT_CENTS,
    configured: "configured" in result ? result.configured : false,
    code: "code" in result ? result.code : null,
    error: "error" in result ? result.error : null,
    mode: "mode" in result ? result.mode : null,
    stripeMode: "stripeMode" in result ? result.stripeMode : null,
    hasCheckoutUrl: Boolean("url" in result && result.url),
    localId: "localId" in result ? result.localId : null,
  };
}

const worker = await unstable_dev("src/index.ts", {
  experimental: { disableExperimentalWarning: true },
  remote: true,
  local: false,
  config: join(apiDir, "wrangler.toml"),
  logLevel: "error",
});

try {
  const healthRes = await worker.fetch("https://infra-api.example/api/gateway/v1/health");
  const health = await healthRes.json();

  const results = {
    health,
    checkouts: [
      await createCheckout(worker, "co_caddington", "Caddington Holdings", "live"),
      await createCheckout(worker, "co_ht", "HT Business", "test"),
      await createCheckout(worker, "co_el", "Elvex Business", "test"),
    ],
  };

  const pass =
    health.stripeMode === "live" &&
    health.stripePaymentsAllowed === true &&
    results.checkouts[0]?.configured === true &&
    results.checkouts[0]?.hasCheckoutUrl === true &&
    results.checkouts[0]?.stripeMode === "live" &&
    results.checkouts[1]?.configured === false &&
    results.checkouts[1]?.code === "BILLING_MODE_BLOCKED" &&
    results.checkouts[2]?.configured === false &&
    results.checkouts[2]?.code === "BILLING_MODE_BLOCKED";

  console.log(
    JSON.stringify(
      {
        title: "STRIPE LIVE CHECKOUT ISOLATION PROBE",
        checkedAt: new Date().toISOString(),
        ...results,
        pass,
        note: "Sessions may be created but must not be completed — no wallet credit.",
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 1);
} finally {
  await worker.stop();
}
