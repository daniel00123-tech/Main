/**
 * Microsoft Graph app-only authentication (client credentials).
 * READ ONLY — no delegated user session required for OneDrive/SharePoint sync.
 */

import type { Env } from "../env";

export type MicrosoftAuthMode = "app_only" | "delegated" | "not_configured";

export type MicrosoftCredentialStatus = {
  configured: boolean;
  authMode: MicrosoftAuthMode;
  tenantIdMasked: string | null;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  tenantIdConfigured: boolean;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const tokenCache = new Map<string, CachedToken>();

function maskTenantId(tenantId: string): string {
  if (tenantId.length <= 8) return "****";
  return `${tenantId.slice(0, 4)}…${tenantId.slice(-4)}`;
}

export function microsoftCredentialStatus(env: Env): MicrosoftCredentialStatus {
  const tenantId =
    typeof env.MICROSOFT_TENANT_ID === "string" ? env.MICROSOFT_TENANT_ID.trim() : "";
  const clientId =
    typeof env.MICROSOFT_CLIENT_ID === "string" ? env.MICROSOFT_CLIENT_ID.trim() : "";
  const clientSecret =
    typeof env.MICROSOFT_CLIENT_SECRET === "string" ? env.MICROSOFT_CLIENT_SECRET.trim() : "";

  const tenantIdConfigured = Boolean(tenantId);
  const clientIdConfigured = Boolean(clientId);
  const clientSecretConfigured = Boolean(clientSecret);
  const configured = tenantIdConfigured && clientIdConfigured && clientSecretConfigured;

  return {
    configured,
    authMode: configured ? "app_only" : "not_configured",
    tenantIdMasked: tenantId ? maskTenantId(tenantId) : null,
    clientIdConfigured,
    clientSecretConfigured,
    tenantIdConfigured,
  };
}

export function microsoftAppConfigured(env: Env): boolean {
  return microsoftCredentialStatus(env).configured;
}

export type MicrosoftTokenContext = {
  companyId?: string;
  connectorInstanceId?: string;
  tenantId?: string;
};

/** Resolve Entra tenant ID from connector instance data, falling back to Worker secret. */
export async function resolveMicrosoftTenantId(
  env: Env,
  db: D1Database,
  input?: { companyId?: string; connectorInstanceId?: string },
): Promise<string | null> {
  if (input?.connectorInstanceId && input?.companyId) {
    const row = await db
      .prepare(
        `SELECT microsoft_tenant_id, external_account_id FROM connector_instances
         WHERE id = ? AND company_id = ? LIMIT 1`,
      )
      .bind(input.connectorInstanceId, input.companyId)
      .first<{ microsoft_tenant_id: string | null; external_account_id: string | null }>();
    const fromInstance = row?.microsoft_tenant_id?.trim() || row?.external_account_id?.trim();
    if (fromInstance) return fromInstance;
  }
  const global =
    typeof env.MICROSOFT_TENANT_ID === "string" ? env.MICROSOFT_TENANT_ID.trim() : "";
  return global || null;
}

export async function acquireMicrosoftAppToken(
  env: Env,
  context?: MicrosoftTokenContext,
): Promise<
  | { ok: true; accessToken: string; tenantId: string; expiresAtMs: number }
  | { ok: false; code: string; message: string }
> {
  const status = microsoftCredentialStatus(env);
  if (!status.configured) {
    return {
      ok: false,
      code: "MICROSOFT_NOT_CONFIGURED",
      message: "Microsoft 365 app credentials are not configured.",
    };
  }

  let tenantId = context?.tenantId?.trim();
  if (!tenantId && context?.companyId) {
    tenantId =
      (await resolveMicrosoftTenantId(env, env.DB, {
        companyId: context.companyId,
        connectorInstanceId: context.connectorInstanceId,
      })) ?? undefined;
  }
  if (!tenantId) {
    tenantId = String(env.MICROSOFT_TENANT_ID ?? "").trim();
  }
  if (!tenantId) {
    return {
      ok: false,
      code: "MICROSOFT_TENANT_MISSING",
      message: "Microsoft tenant ID is not configured for this company.",
    };
  }

  const cacheKey = `${tenantId}:${String(env.MICROSOFT_CLIENT_ID).trim()}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return { ok: true, accessToken: cached.accessToken, tenantId, expiresAtMs: cached.expiresAtMs };
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: String(env.MICROSOFT_CLIENT_ID).trim(),
    client_secret: String(env.MICROSOFT_CLIENT_SECRET).trim(),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      code: "MICROSOFT_TOKEN_NETWORK_ERROR",
      message: err instanceof Error ? err.message : "Token request failed",
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    return {
      ok: false,
      code: "MICROSOFT_TOKEN_DENIED",
      message: payload.error_description ?? payload.error ?? `HTTP ${response.status}`,
    };
  }

  const expiresIn = Number(payload.expires_in ?? 3600);
  const expiresAtMs = Date.now() + expiresIn * 1000;
  tokenCache.set(cacheKey, { accessToken: payload.access_token, expiresAtMs });

  return {
    ok: true,
    accessToken: payload.access_token,
    tenantId,
    expiresAtMs,
  };
}

/** Clear in-memory token cache (tests). */
export function clearMicrosoftTokenCache(): void {
  tokenCache.clear();
}
