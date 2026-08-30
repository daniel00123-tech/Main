import type { Env } from "../env";

export const DEFAULT_XERO_REDIRECT_URI = "https://el-business-mcp.infrastack.app/oauth/xero/callback";
export const DEFAULT_EXPECTED_ORG = "Elvex Property Services Ltd";
export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

/**
 * Granular Xero scopes (required for apps created on/after 2 March 2026).
 * Broad accounting.transactions / accounting.reports.read are not requested.
 * Write scopes are limited to invoices/contacts so drafts can be created;
 * payment, bank-write, journal and payroll scopes are never requested.
 */
export const XERO_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "accounting.settings.read",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.attachments",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.aged.read",
  "accounting.reports.banksummary.read",
  "accounting.reports.trialbalance.read",
  "accounting.reports.executivesummary.read",
] as const;

export const XERO_SCOPE_STRING = XERO_SCOPES.join(" ");

export const XERO_CONNECTOR_CODES = new Set(["xero"]);

export type ElXeroConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  expectedOrganisation: string;
};

export function xeroCredentialsPresent(env: Env): boolean {
  return Boolean(env.EL_XERO_CLIENT_ID?.trim() && env.EL_XERO_CLIENT_SECRET?.trim());
}

export function loadXeroConfig(env: Env): ElXeroConfig | null {
  if (!xeroCredentialsPresent(env)) return null;
  return {
    clientId: env.EL_XERO_CLIENT_ID!.trim(),
    clientSecret: env.EL_XERO_CLIENT_SECRET!.trim(),
    redirectUri: (env.EL_XERO_REDIRECT_URI?.trim() || DEFAULT_XERO_REDIRECT_URI).replace(/\/$/, ""),
    expectedOrganisation: env.EL_XERO_EXPECTED_ORG?.trim() || DEFAULT_EXPECTED_ORG,
  };
}

export function organisationMatchesExpected(actual: string | null | undefined, expected: string): boolean {
  const left = (actual ?? "").trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith(right) || right.startsWith(left)) return true;
  const compact = (value: string) => value.replace(/[^a-z0-9]+/g, "");
  return compact(left) === compact(right);
}

export function publicXeroPolicy(
  config: ElXeroConfig | null,
  connection?: {
    connected: boolean;
    organisationName?: string | null;
    tenantId?: string | null;
    scopes?: string[] | null;
    accessExpiresAt?: string | null;
    lastRefreshAt?: string | null;
    lastApiAt?: string | null;
    lastApiOk?: boolean | null;
  } | null
): {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  expectedOrganisation: string;
  organisationName: string | null;
  tenantId: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
  lastRefreshAt: string | null;
  lastApiAt: string | null;
  lastApiOk: boolean | null;
  tokenHealth: "missing" | "connected" | "expiring" | "unknown";
} {
  const expires = connection?.accessExpiresAt ? Date.parse(connection.accessExpiresAt) : NaN;
  let tokenHealth: "missing" | "connected" | "expiring" | "unknown" = "missing";
  if (connection?.connected) {
    if (Number.isFinite(expires)) {
      tokenHealth = expires - Date.now() < 5 * 60 * 1000 ? "expiring" : "connected";
    } else {
      tokenHealth = "unknown";
    }
  }
  return {
    configured: Boolean(config),
    connected: Boolean(connection?.connected),
    redirectUri: config?.redirectUri ?? DEFAULT_XERO_REDIRECT_URI,
    expectedOrganisation: config?.expectedOrganisation ?? DEFAULT_EXPECTED_ORG,
    organisationName: connection?.organisationName ?? null,
    tenantId: connection?.tenantId ?? null,
    scopes: connection?.scopes ?? [...XERO_SCOPES],
    accessExpiresAt: connection?.accessExpiresAt ?? null,
    lastRefreshAt: connection?.lastRefreshAt ?? null,
    lastApiAt: connection?.lastApiAt ?? null,
    lastApiOk: connection?.lastApiOk ?? null,
    tokenHealth,
  };
}
