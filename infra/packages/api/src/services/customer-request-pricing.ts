/**
 * Request-level commercial settlement is a reusable platform policy.
 * EL is configured at 3p. Other tenants keep their existing tariff
 * unless an explicit customer.request rule is enabled for them.
 */

export const CUSTOMER_REQUEST_ACTION = "customer.request";

export type RequestPricingPolicy = {
  companyId: string;
  enabled: boolean;
  chargeCents: number;
  action: typeof CUSTOMER_REQUEST_ACTION;
  label: string;
};

const EL_REQUEST_POLICY: RequestPricingPolicy = {
  companyId: "co_el",
  enabled: true,
  chargeCents: 3,
  action: CUSTOMER_REQUEST_ACTION,
  label: "EL Business: 3p per genuine customer request",
};

/** Explicit commercial config only. Never inherit EL's 3p. */
const CONFIGURED_POLICIES: Record<string, RequestPricingPolicy> = {
  [EL_REQUEST_POLICY.companyId]: EL_REQUEST_POLICY,
};

export function resolveRequestPricingPolicy(companyId?: string | null): RequestPricingPolicy | null {
  const id = String(companyId ?? "").trim();
  if (!id) return null;
  const policy = CONFIGURED_POLICIES[id];
  return policy?.enabled ? policy : null;
}

export function companyUsesRequestLevelPricing(companyId?: string | null): boolean {
  return resolveRequestPricingPolicy(companyId) !== null;
}

export function requestLevelChargeCents(companyId?: string | null): number | null {
  return resolveRequestPricingPolicy(companyId)?.chargeCents ?? null;
}

export function futureTenantNeedsExplicitPricing(companyId: string): boolean {
  return !CONFIGURED_POLICIES[companyId];
}
