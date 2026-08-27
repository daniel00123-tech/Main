import type { PaymentProviderId } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { getStripeMode, isStripeConfigured, isStripeTestModeActive } from "./stripe";
import { getCompanySettings } from "./company-settings";

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
    paymentMethodReady?: boolean;
    canExecute?: boolean;
    setupRequired?: boolean;
    message?: string;
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

export async function getCompanyPaymentProviderStatus(
  env: Env,
  db: D1Database,
  companyId: string,
): Promise<PaymentProviderStatus> {
  const base = getPlatformPaymentProviderStatus(env);
  const settings = await getCompanySettings(db, companyId);
  if (!settings) return base;

  const executionEnabled = String(env.AUTO_TOPUP_EXECUTION_ENABLED ?? "").toLowerCase() === "true";
  const canExecute =
    executionEnabled &&
    base.configured &&
    base.testModeOnly &&
    settings.autoTopUp.enabled &&
    settings.autoTopUp.paymentMethodReady;

  return {
    ...base,
    autoTopUp: {
      supported: base.configured,
      enabled: settings.autoTopUp.enabled,
      thresholdCents: settings.autoTopUp.thresholdCents ?? 500,
      amountCents: settings.autoTopUp.amountCents ?? 2500,
      paymentMethodReady: settings.autoTopUp.paymentMethodReady,
      canExecute,
      setupRequired: !settings.autoTopUp.paymentMethodReady,
      message: settings.autoTopUp.enabled
        ? settings.autoTopUp.paymentMethodReady
          ? canExecute
            ? "Auto top-up is active in Stripe test mode."
            : "Auto top-up configured — execution awaits operator enablement."
          : "Auto top-up enabled — add a payment method to activate."
        : "Auto top-up is off.",
    },
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
