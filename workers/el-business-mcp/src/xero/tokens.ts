import type { Env } from "../env";
import { loadXeroConfig } from "./config";
import { ElXeroError } from "./errors";
import { refreshXeroTokens } from "./oauth";
import {
  clearRefreshLock,
  decryptTokens,
  loadConnectionRow,
  saveConnection,
  tryAcquireRefreshLock,
  type XeroTokenPayload,
} from "./store";

const REFRESH_SKEW_MS = 2 * 60 * 1000;

export async function getValidAccessToken(env: Env): Promise<{
  accessToken: string;
  tenantId: string;
  organisationName: string;
  scopes: string[];
  expiresAt: string;
}> {
  const config = loadXeroConfig(env);
  if (!config) {
    throw new ElXeroError("Xero is not configured on EL Business MCP.", "EL_XERO_NOT_CONFIGURED", 503);
  }
  const row = await loadConnectionRow(env.EL_BUSINESS_DATA);
  if (!row) {
    throw new ElXeroError(
      "Xero is not connected. An INFRA admin must complete GET /admin/xero/connect.",
      "EL_XERO_NOT_CONNECTED",
      503
    );
  }

  let tokens: XeroTokenPayload = await decryptTokens(config, row);
  const expiresAt = Date.parse(tokens.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    const locked = await tryAcquireRefreshLock(env.EL_BUSINESS_DATA);
    if (!locked) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const latest = await loadConnectionRow(env.EL_BUSINESS_DATA);
      if (!latest) throw new ElXeroError("Xero connection disappeared during refresh.", "EL_XERO_NOT_CONNECTED", 503);
      tokens = await decryptTokens(config, latest);
    } else {
      try {
        const refreshed = await refreshXeroTokens(config, tokens.refreshToken);
        await saveConnection(env.EL_BUSINESS_DATA, config, {
          tenantId: row.tenant_id,
          organisationName: row.organisation_name ?? config.expectedOrganisation,
          connectionId: row.connection_id,
          scopes: refreshed.scopes,
          tokens: refreshed,
        });
        tokens = refreshed;
      } catch (error) {
        await clearRefreshLock(env.EL_BUSINESS_DATA);
        throw error;
      }
    }
  }

  return {
    accessToken: tokens.accessToken,
    tenantId: row.tenant_id,
    organisationName: row.organisation_name ?? config.expectedOrganisation,
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
  };
}
