import type { ElMicrosoftConfig } from "./config";
import { ElMicrosoftError, sanitizeErrorMessage } from "./errors";

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const tokenCache = new Map<string, CachedToken>();
const EXPIRY_SKEW_MS = 60_000;

export function clearMicrosoftTokenCache(): void {
  tokenCache.clear();
}

export function microsoftTokenCacheSize(): number {
  return tokenCache.size;
}

function cacheKey(config: ElMicrosoftConfig): string {
  return `${config.tenantId}:${config.clientId}`;
}

export async function acquireGraphToken(config: ElMicrosoftConfig): Promise<{
  accessToken: string;
  expiresAtMs: number;
  cached: boolean;
}> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now() + EXPIRY_SKEW_MS) {
    return { accessToken: cached.accessToken, expiresAtMs: cached.expiresAtMs, cached: true };
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
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
  } catch (error) {
    throw new ElMicrosoftError(
      sanitizeErrorMessage(error instanceof Error ? error.message : "Token request failed"),
      "EL_MS_TOKEN_NETWORK",
      502,
      true
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new ElMicrosoftError(
      sanitizeErrorMessage(payload.error_description ?? payload.error ?? `HTTP ${response.status}`),
      "EL_MS_TOKEN_DENIED",
      response.status || 401,
      response.status >= 500
    );
  }

  const expiresIn = Number(payload.expires_in ?? 3600);
  const expiresAtMs = Date.now() + Math.max(60, expiresIn) * 1000;
  tokenCache.set(key, { accessToken: payload.access_token, expiresAtMs });
  return { accessToken: payload.access_token, expiresAtMs, cached: false };
}
