/**
 * Per-company billing mode vs platform Stripe environment.
 * Separates "Stripe is live" from "this company may incur live charges".
 */

import type { BillingMode } from "@infra/shared";
import {
  getStripeMode,
  isStripeConfigured,
  isStripeTestModeActive,
  STRIPE_LIVE_MODE_ALLOWED,
  stripePaymentsAllowed,
} from "./stripe";
import type { Env } from "../env";

export async function getCompanyBillingMode(
  db: D1Database,
  companyId: string,
): Promise<BillingMode> {
  const row = await db
    .prepare(`SELECT billing_mode FROM companies WHERE id = ? LIMIT 1`)
    .bind(companyId)
    .first<{ billing_mode: string | null }>();
  const mode = row?.billing_mode;
  return mode === "live" ? "live" : "test";
}

export function companyStripeCheckoutAllowed(
  env: Env,
  companyBillingMode: BillingMode,
): { allowed: boolean; reason?: string } {
  if (!isStripeConfigured(env)) {
    return { allowed: true };
  }
  const platformMode = getStripeMode(env);
  if (platformMode === "test" || isStripeTestModeActive(env)) {
    return { allowed: true };
  }
  if (platformMode === "live") {
    if (companyBillingMode !== "live") {
      return {
        allowed: false,
        reason: "Company billing mode is test — live card charges are not permitted for this company",
      };
    }
    if (!STRIPE_LIVE_MODE_ALLOWED) {
      return {
        allowed: false,
        reason: "Live Stripe checkout is blocked until operator enables STRIPE_LIVE_MODE_ALLOWED",
      };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: "Stripe platform mode is unconfigured" };
}

export function companyCanReceiveLiveWalletCredit(
  companyBillingMode: BillingMode,
): boolean {
  return companyBillingMode === "live";
}

/** Platform-wide payment gate (legacy) combined with company mode for checkout. */
export function stripeCheckoutAllowedForCompany(
  env: Env,
  companyBillingMode: BillingMode,
): boolean {
  if (!stripePaymentsAllowed(env) && !isStripeTestModeActive(env)) {
    return false;
  }
  return companyStripeCheckoutAllowed(env, companyBillingMode).allowed;
}
