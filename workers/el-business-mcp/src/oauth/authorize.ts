import type { Env } from "../env";
import { ELVEX_COMPANY_SLUG, infraAuthorizeUrl, mcpIssuer, mcpResourceUrl } from "./config";
import { withOauthCors } from "./cors";

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";

  if (responseType !== "code") {
    return authorizeError(env, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported.");
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return authorizeError(env, redirectUri, state, "invalid_request", "PKCE S256 code_challenge is required.");
  }

  const infra = infraAuthorizeUrl(env);
  if (!infra) {
    return oauthHtmlError("INFRA is the OAuth authority for Elvex Business MCP. INFRA_PUBLIC_API_URL is not configured.", 503);
  }

  const target = new URL(infra);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  if (!target.searchParams.get("company")) target.searchParams.set("company", ELVEX_COMPANY_SLUG);
  if (!target.searchParams.get("client")) target.searchParams.set("client", "chatgpt");
  if (!target.searchParams.get("resource")) target.searchParams.set("resource", mcpResourceUrl(env));
  return withOauthCors(request, Response.redirect(target.toString(), 302));
}

export async function handleMicrosoftCallback(_request: Request, _env: Env): Promise<Response> {
  return oauthHtmlError(
    "Microsoft sign-in is not used for INFRA MCP access. Connect ChatGPT through INFRA, then use Microsoft 365 only as a company data connector.",
    410
  );
}

function authorizeError(
  env: Env,
  redirectUri: string,
  state: string | null,
  error: string,
  description: string
): Response {
  if (!redirectUri) return oauthHtmlError(description, 400);
  try {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    target.searchParams.set("iss", mcpIssuer(env));
    return Response.redirect(target.toString(), 302);
  } catch {
    return oauthHtmlError(description, 400);
  }
}

function oauthHtmlError(message: string, status: number): Response {
  return new Response(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
