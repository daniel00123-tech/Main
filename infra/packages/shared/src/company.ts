/** Company identity, slug rules, and lifecycle constants. */

export const COMPANY_LIFECYCLE_STATUSES = [
  "draft",
  "provisioning",
  "onboarding",
  "active",
  "suspended",
  "archived",
  "closed",
] as const;

export type CompanyLifecycleStatus = (typeof COMPANY_LIFECYCLE_STATUSES)[number];

/** Gateway paid operations are allowed only for these statuses. */
export const GATEWAY_ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "onboarding",
]);

/**
 * Route / product words that must never become a company slug.
 * Tenant names such as caddington / ht / el are valid configuration, not reserved.
 */
export const RESERVED_COMPANY_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "company",
  "companies",
  "connector",
  "connectors",
  "dashboard",
  "health",
  "infra",
  "internal",
  "login",
  "mcp",
  "new",
  "null",
  "platform",
  "portal",
  "ready",
  "setup",
  "static",
  "status",
  "system",
  "undefined",
  "usage",
  "www",
  "www2",
  "settings",
  "users",
  "team",
  "activity",
  "ai",
  "chatgpt",
  "claude",
  "whatsapp",
  "create",
  "delete",
  "true",
  "false",
  "javascript",
  "about",
  "data",
]);

export const DEFAULT_TEST_OPENING_CREDIT_CENTS = 1000;

export const DEFAULT_COMPANY_CURRENCY = "GBP";

export function slugifyCompanyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

export function normalizeCompanySlug(value: string): string {
  return slugifyCompanyName(value);
}

export function validateCompanySlug(
  raw: string,
): { ok: true; slug: string } | { ok: false; error: string } {
  const slug = normalizeCompanySlug(raw);
  if (!slug || slug.length < 2) {
    return { ok: false, error: "Slug must be at least 2 characters" };
  }
  if (slug.length > 48) {
    return { ok: false, error: "Slug must be 48 characters or fewer" };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    return {
      ok: false,
      error: "Slug must be lowercase letters, numbers, and hyphens only",
    };
  }
  if (RESERVED_COMPANY_SLUGS.has(slug)) {
    return { ok: false, error: `"${slug}" is reserved and cannot be used` };
  }
  return { ok: true, slug };
}

export type McpOnboardingStatus =
  | "not_provisioned"
  | "provisioning_required"
  | "registered"
  | "authentication_required"
  | "connected"
  | "healthy"
  | "degraded"
  | "offline";

export type BillingMode = "test" | "live";

export type CreditClass = "test" | "paid";

export type ConnectorLifecycleStatus =
  | "available"
  | "not_configured"
  | "configuring"
  | "connected"
  | "degraded"
  | "auth_expired"
  | "error"
  | "disconnected";

export type AiChannelKind =
  | "chatgpt"
  | "claude"
  | "whatsapp"
  | "automation"
  | "internal";

export type PaymentProviderId = "stripe";
