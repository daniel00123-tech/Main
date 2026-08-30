import type { Env } from "../env";
import { mcpIssuer } from "./config";
import { getOAuthClient, insertOAuthClient, type OAuthClientRow } from "./store";
import { sha256Hex } from "./crypto";

const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

export async function registerOAuthClient(
  env: Env,
  body: Record<string, unknown>
): Promise<{ client: OAuthClientRow; clientIdIssuedAt: number }> {
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (redirectUris.length === 0) {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris is required");
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new OAuthRequestError("invalid_redirect_uri", `Redirect URI is not allowed: ${uri}`);
    }
  }
  const method =
    body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
  let clientSecretHash: string | null = null;
  if (method === "client_secret_post" && typeof body.client_secret === "string") {
    clientSecretHash = await sha256Hex(body.client_secret);
  }
  const client = await insertOAuthClient(env, {
    clientName: typeof body.client_name === "string" ? body.client_name : "ChatGPT",
    redirectUris,
    tokenEndpointAuthMethod: method,
    clientSecretHash,
  });
  return { client, clientIdIssuedAt: Math.floor(Date.now() / 1000) };
}

export async function resolveOAuthClient(
  env: Env,
  clientId: string,
  redirectUri: string
): Promise<OAuthClientRow | null> {
  if (!clientId) return null;
  if (clientId.startsWith("https://")) {
    return resolveCimdClient(clientId, redirectUri);
  }
  const registered = await getOAuthClient(env, clientId);
  if (!registered) return null;
  if (!registered.redirectUris.includes(redirectUri)) return null;
  return registered;
}

async function resolveCimdClient(clientId: string, redirectUri: string): Promise<OAuthClientRow | null> {
  let doc: {
    client_id?: string;
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  try {
    const response = await fetch(clientId, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    doc = (await response.json()) as typeof doc;
  } catch {
    return null;
  }
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (!uris.includes(redirectUri)) return null;
  if (doc.client_id && doc.client_id !== clientId) return null;
  return {
    clientId,
    clientName: doc.client_name ?? "CIMD client",
    redirectUris: uris,
    tokenEndpointAuthMethod: doc.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none",
    clientSecretHash: null,
  };
}

export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") {
      return (
        url.hostname === "chatgpt.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        url.hostname === "chat.openai.com" ||
        url.hostname.endsWith(".openai.com") ||
        uri === CHATGPT_REDIRECT
      );
    }
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function dcrResponse(client: OAuthClientRow, issuedAt: number, issuer: string): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_id_issued_at: issuedAt,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    issuer,
  };
}

export function issuerForDcr(env: Env): string {
  return mcpIssuer(env);
}

export class OAuthRequestError extends Error {
  error: string;
  status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.name = "OAuthRequestError";
    this.error = error;
    this.status = status;
  }
}
