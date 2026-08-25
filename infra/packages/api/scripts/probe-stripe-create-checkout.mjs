#!/usr/bin/env node
/** Create £10 Stripe Sandbox checkout via remote worker bindings — never prints secrets. */
import { getPlatformProxy } from "wrangler";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createTopUpCheckoutIntent,
  getStripeMode,
  isStripeConfigured,
  STRIPE_LIVE_MODE_ALLOWED,
} from "../src/services/stripe.ts";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const { env, dispose } = await getPlatformProxy({
  configPath: join(apiDir, "wrangler.toml"),
  remoteBindings: true,
});

try {
  const result = await createTopUpCheckoutIntent(env, {
    companyId: "co_caddington",
    companyName: "Caddington Holdings",
    amountCents: 1000,
    createdBy: "stripe-acceptance-probe@infra.local",
    successUrl:
      "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=success",
    cancelUrl:
      "https://infra-web.pages.dev/portal/caddington-holdings/billing?topup=cancelled",
  });

  console.log(
    JSON.stringify(
      {
        stripeConfigured: isStripeConfigured(env),
        stripeMode: getStripeMode(env),
        liveModeAllowed: STRIPE_LIVE_MODE_ALLOWED,
        amountCents: 1000,
        result:
          result.configured && "url" in result
            ? {
                configured: true,
                localId: result.localId,
                mode: result.mode,
                stripeMode: result.stripeMode,
                checkoutUrlDomain: result.url ? new URL(result.url).hostname : null,
                checkoutUrl: result.url,
              }
            : result,
      },
      null,
      2,
    ),
  );
} finally {
  await dispose();
}
