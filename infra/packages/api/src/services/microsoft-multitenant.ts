/**
 * Platform multitenant Microsoft 365 helpers.
 */

import type { Env } from "../env";

export const CADDINGTON_LEGACY_COMPANY_ID = "co_caddington";

export function isMicrosoftMultitenantApp(env: Env): boolean {
  const flag = String(env.MICROSOFT_MULTITENANT_APP ?? "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

export function microsoftPlatformAppConfigured(env: Env): boolean {
  const clientId =
    typeof env.MICROSOFT_CLIENT_ID === "string" ? env.MICROSOFT_CLIENT_ID.trim() : "";
  const clientSecret =
    typeof env.MICROSOFT_CLIENT_SECRET === "string" ? env.MICROSOFT_CLIENT_SECRET.trim() : "";
  if (!clientId || !clientSecret) return false;
  if (isMicrosoftMultitenantApp(env)) return true;
  const tenantId =
    typeof env.MICROSOFT_TENANT_ID === "string" ? env.MICROSOFT_TENANT_ID.trim() : "";
  return Boolean(tenantId);
}

export function allowLegacyMicrosoftTenantFallback(env: Env, companyId?: string | null): boolean {
  if (!companyId) return !isMicrosoftMultitenantApp(env);
  if (companyId === CADDINGTON_LEGACY_COMPANY_ID) return true;
  return !isMicrosoftMultitenantApp(env);
}
