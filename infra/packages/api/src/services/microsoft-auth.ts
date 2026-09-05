/**
 * Microsoft Graph app-only authentication (client credentials).
 * READ ONLY — no delegated user session required for OneDrive/SharePoint sync.
 */

import type { Env } from "../env";
import {
  maskMicrosoftTenantId,
  platformMicrosoftConfigured,
  platformMultitenantAppEnabled,
  resolveMicrosoftAppCredentials,
  type MicrosoftAppCredentials,
} from "./microsoft-credentials";
import { recordMicrosoftTenantIdentityTokenResult } from "./microsoft-tenant-identity";

export type MicrosoftAuthMode = "app_only" | "delegated" | "not_configured";

export type MicrosoftCredentialStatus = {
  configured: boolean;
  authMode: MicrosoftAuthMode;
  tenantIdMasked: string | null;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  tenantIdConfigured: boolean;
  multitenantAppEnabled: boolean;
  platformConfigured: boolean;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const tokenCache = new Map<string, CachedToken>();

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
  const multitenantAppEnabled = platformMultitenantAppEnabled(env);
  const configured =
    clientIdConfigured &&
    clientSecretConfigured &&
    (multitenantAppEnabled || tenantIdConfigured);

  return {
    configured,
    authMode: configured ? "app_only" : "not_configured",
    tenantIdMasked: tenantId
      ? maskMicrosoftTenantId(tenantId)
      : multitenantAppEnabled
        ? "per-company"
        : null,
    clientIdConfigured,
    clientSecretConfigured,
    tenantIdConfigured,
    multitenantAppEnabled,
    platformConfigured: configured,
  };
}

export function microsoftAppConfigured(env: Env): boolean {
  return platformMicrosoftConfigured(env);
}

export type MicrosoftTokenContext = {
  companyId?: string;
  connectorInstanceId?: string;
  tenantId?: string;
  actor?: string;
};

/** Resolve Entra tenant ID from connector instance data, falling back to Worker secret. */
export async function resolveMicrosoftTenantId(
  env: Env,
  db: D1Database,
  input?: { companyId?: string; connectorInstanceId?: string },
): Promise<string | null> {
  const resolved = await resolveMicrosoftAppCredentials(env, db, {
    companyId: input?.companyId,
    connectorInstanceId: input?.connectorInstanceId,
  });
  if (resolved.ok) return resolved.credentials.tenantId;
  const global =
    typeof env.MICROSOFT_TENANT_ID === "string" ? env.MICROSOFT_TENANT_ID.trim() : "";
  return global || null;
}

export type MicrosoftTokenDenialDetail = {
  httpStatus?: number;
  aadError?: string | null;
  aadErrorCodes?: number[];
  correlationId?: string | null;
  traceId?: string | null;
  timestamp?: string | null;
  tokenUrl?: string | null;
  clientId?: string | null;
};

async function requestClientCredentialsToken(
  credentials: MicrosoftAppCredentials,
  options?: { bypassCache?: boolean },
): Promise<
  | { ok: true; accessToken: string; tenantId: string; expiresAtMs: number; cached: boolean }
  | ({ ok: false; code: string; message: string } & MicrosoftTokenDenialDetail)
> {
  const tenantId = credentials.tenantId.trim();
  const cacheKey = `${credentials.authMode}:${tenantId}:${credentials.clientId}`;
  if (options?.bypassCache) tokenCache.delete(cacheKey);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return { ok: true, accessToken: cached.accessToken, tenantId, expiresAtMs: cached.expiresAtMs, cached: true };
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
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
    error_codes?: number[];
    timestamp?: string;
    trace_id?: string;
    correlation_id?: string;
  };

  if (!response.ok || !payload.access_token) {
    const aadCode = Array.isArray(payload.error_codes) && payload.error_codes[0]
      ? `AADSTS${payload.error_codes[0]}`
      : "";
    const description = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    return {
      ok: false,
      code: "MICROSOFT_TOKEN_DENIED",
      message: aadCode && !description.includes(aadCode) ? `${aadCode}: ${description}` : description,
      httpStatus: response.status,
      aadError: payload.error ?? null,
      aadErrorCodes: Array.isArray(payload.error_codes) ? payload.error_codes : [],
      correlationId: payload.correlation_id ?? null,
      traceId: payload.trace_id ?? null,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      tokenUrl,
      clientId: credentials.clientId,
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
    cached: false,
  };
}

export async function acquireMicrosoftAppToken(
  env: Env,
  context?: MicrosoftTokenContext & { bypassCache?: boolean },
): Promise<
  | {
      ok: true;
      accessToken: string;
      tenantId: string;
      expiresAtMs: number;
      authMode: string;
      cached?: boolean;
      clientId?: string;
      identityKind?: string;
      displayName?: string;
    }
  | ({ ok: false; code: string; message: string } & MicrosoftTokenDenialDetail)
> {
  if (context?.companyId) {
    const resolved = await resolveMicrosoftAppCredentials(env, env.DB, {
      companyId: context.companyId,
      connectorInstanceId: context.connectorInstanceId,
      actor: context.actor,
    });
    if (!resolved.ok) {
      if (resolved.code === "MICROSOFT_TENANT_SECRET_MISSING") {
        await recordMicrosoftTenantIdentityTokenResult(env.DB, context.companyId, {
          ok: false,
          error: resolved.message,
        }).catch(() => undefined);
      }
      return { ok: false, code: resolved.code, message: resolved.message };
    }
    const token = await requestClientCredentialsToken(resolved.credentials, {
      bypassCache: context.bypassCache,
    });
    if (resolved.credentials.identityKind === "tenant_native") {
      await recordMicrosoftTenantIdentityTokenResult(
        env.DB,
        context.companyId,
        token.ok ? { ok: true } : { ok: false, error: token.message },
      ).catch(() => undefined);
    }
    if (!token.ok) {
      return {
        ...token,
        clientId: resolved.credentials.clientId,
      };
    }
    return {
      ...token,
      authMode: resolved.credentials.authMode,
      clientId: resolved.credentials.clientId,
      identityKind: resolved.credentials.identityKind ?? "connector",
      displayName: resolved.credentials.displayName,
    };
  }

  const status = microsoftCredentialStatus(env);
  if (!status.configured) {
    return {
      ok: false,
      code: "MICROSOFT_NOT_CONFIGURED",
      message: "Microsoft 365 app credentials are not configured.",
    };
  }

  let tenantId = context?.tenantId?.trim();
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

  const token = await requestClientCredentialsToken(
    {
      tenantId,
      clientId: String(env.MICROSOFT_CLIENT_ID).trim(),
      clientSecret: String(env.MICROSOFT_CLIENT_SECRET).trim(),
      authMode: "platform_legacy",
      credentialSource: "platform",
    },
    { bypassCache: context?.bypassCache },
  );
  if (!token.ok) return token;
  return { ...token, authMode: "platform_legacy" };
}

/** Clear in-memory token cache (tests). */
export function clearMicrosoftTokenCache(): void {
  tokenCache.clear();
}
