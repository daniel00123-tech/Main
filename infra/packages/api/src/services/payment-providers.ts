import type { PaymentProviderId } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { getStripeMode, isStripeConfigured, isStripeTestModeActive } from "./stripe";

export interface PaymentProviderStatus {
  provider: PaymentProviderId;
  label: string;
  configured: boolean;
  status: "not_configured" | "ready" | "disabled";
  message: string;
  stripeMode: "unconfigured" | "test" | "live";
  testModeOnly: boolean;
  autoTopUp: {
    supported: boolean;
    enabled: boolean;
    thresholdCents: number | null;
    amountCents: number | null;
  };
  topUpOptionsCents: number[];
}

export const DEFAULT_TOP_UP_OPTIONS_CENTS = [1000, 2500, 5000, 10000];

export function getPlatformPaymentProviderStatus(env: Env): PaymentProviderStatus {
  const configured = isStripeConfigured(env);
  const stripeMode = getStripeMode(env);
  const testMode = isStripeTestModeActive(env);
  return {
    provider: "stripe",
    label: "Stripe",
    configured,
    status: configured ? "ready" : "not_configured",
    stripeMode,
    testModeOnly: testMode,
    message: configured
      ? testMode
        ? "Stripe Checkout is configured in TEST MODE for prepaid wallet top-ups."
        : "Stripe is configured but live mode is blocked until operator approval."
      : "Online payments not configured",
    autoTopUp: {
      supported: true,
      enabled: false,
      thresholdCents: 500,
      amountCents: 2500,
    },
    topUpOptionsCents: DEFAULT_TOP_UP_OPTIONS_CENTS,
  };
}

export async function ensurePaymentProviderAccount(
  db: D1Database,
  companyId: string,
  provider: PaymentProviderId = "stripe",
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_provider_accounts
        (id, company_id, provider, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'not_configured', '{}', ?, ?)`,
    )
    .bind(newId("pay"), companyId, provider, now, now)
    .run();
}

/**
 * Tide is the business bank account that receives Stripe payouts.
 * INFRA does not integrate with a Tide API for v1.
 */
export const TIDE_PAYOUT_NOTE =
  "Stripe payouts settle to the Tide business bank account. No Tide API is required.";
