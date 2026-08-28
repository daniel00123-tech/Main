import type { BillingMode, PaymentProviderId } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { companyStripeCheckoutAllowed, getCompanyBillingMode } from "./company-billing-mode";
import { getStripeMode, isStripeConfigured, isStripeTestModeActive, STRIPE_LIVE_MODE_ALLOWED } from "./stripe";
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
    liveEligible?: boolean;
  };
  topUpOptionsCents: number[];
  companyBillingMode?: BillingMode;
  topUpCheckoutAllowed?: boolean;
  topUpBlockedReason?: string | null;
}

/** Deliberate live acceptance top-up — Caddington £1.00 GBP (100 pence). */
export const LIVE_ACCEPTANCE_TOP_UP_CENTS = 100;

/** Standard preset top-ups (£5 minimum for non-live acceptance companies). */
export const DEFAULT_TOP_UP_OPTIONS_CENTS = [500, 1000, 2500, 5000, 10000];

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
  const companyBillingMode = await getCompanyBillingMode(db, companyId);
  const checkoutGate = companyStripeCheckoutAllowed(env, companyBillingMode);
  const topUpOptionsCents =
    base.testModeOnly || (companyBillingMode === "live" && checkoutGate.allowed)
      ? [LIVE_ACCEPTANCE_TOP_UP_CENTS, ...DEFAULT_TOP_UP_OPTIONS_CENTS]
      : [...DEFAULT_TOP_UP_OPTIONS_CENTS];
  const withBilling = {
    ...base,
    companyBillingMode,
    topUpCheckoutAllowed: checkoutGate.allowed,
    topUpBlockedReason: checkoutGate.reason ?? null,
    topUpOptionsCents,
  };
  const settings = await getCompanySettings(db, companyId);
  if (!settings) return withBilling;

  const executionEnabled = String(env.AUTO_TOPUP_EXECUTION_ENABLED ?? "").toLowerCase() === "true";
  const liveAutoTopUpEligible =
    !base.testModeOnly &&
    companyBillingMode === "live" &&
    checkoutGate.allowed &&
    STRIPE_LIVE_MODE_ALLOWED;
  const canExecute =
    settings.autoTopUp.enabled &&
    settings.autoTopUp.paymentMethodReady &&
    ((base.testModeOnly && executionEnabled) || (liveAutoTopUpEligible && executionEnabled));

  let autoTopUpMessage = "Auto top-up is off.";
  if (settings.autoTopUp.enabled) {
    if (!settings.autoTopUp.paymentMethodReady) {
      autoTopUpMessage = liveAutoTopUpEligible
        ? "Ready for live auto top-up — add a payment method to activate."
        : base.testModeOnly
          ? "Auto top-up enabled — add a payment method to activate."
          : "Auto top-up enabled — add a payment method to activate.";
    } else if (canExecute) {
      autoTopUpMessage = liveAutoTopUpEligible
        ? "Auto top-up is active in live billing mode."
        : "Auto top-up is active in Stripe test mode.";
    } else if (liveAutoTopUpEligible) {
      autoTopUpMessage =
        "Live auto top-up is configured — explicit enablement and operator execution gate required.";
    } else {
      autoTopUpMessage = "Auto top-up configured — execution awaits operator enablement.";
    }
  } else if (liveAutoTopUpEligible && !settings.autoTopUp.paymentMethodReady) {
    autoTopUpMessage = "Ready for live auto top-up — add a payment method to activate.";
  }

  return {
    ...withBilling,
    message: base.testModeOnly
      ? base.message
      : liveAutoTopUpEligible
        ? "Stripe live billing is active for this company."
        : "Stripe is configured in live platform mode.",
    autoTopUp: {
      supported: base.configured,
      enabled: settings.autoTopUp.enabled,
      thresholdCents: settings.autoTopUp.thresholdCents ?? 500,
      amountCents: settings.autoTopUp.amountCents ?? 2500,
      paymentMethodReady: settings.autoTopUp.paymentMethodReady,
      canExecute,
      setupRequired: !settings.autoTopUp.paymentMethodReady,
      message: autoTopUpMessage,
      liveEligible: liveAutoTopUpEligible,
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
