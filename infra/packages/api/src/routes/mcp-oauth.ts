import { Hono } from "hono";
import type { Env } from "../env";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import { getUserByEmail, getUserById, recordUserLogin, toSessionUser } from "../auth/users";
import { verifyPassword } from "../auth/password";
import { setSessionCookie } from "../auth/middleware";
import { createSessionToken } from "../auth/session";
import { getCompanyById } from "../services/control-plane";
import {
  mcpOAuthAuthorizationServerMetadata,
  mcpOAuthOpenIdConfiguration,
  mcpOAuthProtectedResourceMetadata,
} from "../services/mcp-oauth/metadata";
import { issueInfraMcpAccessToken, mcpOAuthIssuer, verifyInfraMcpAccessToken } from "../services/mcp-oauth/tokens";
import {
  resolveCompanyForMcpResource,
  resolveLiveMcpPrincipal,
} from "../services/mcp-oauth/principal";
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  issueAuthorizationCode,
  issueRefreshToken,
  upsertMcpOAuthGrant,
} from "../services/mcp-oauth/store";
import {
  dcrResponse,
  McpOAuthRequestError,
  registerMcpOAuthClient,
  resolveMcpOAuthClient,
} from "../services/mcp-oauth/clients";
import { verifyPkceS256 } from "../services/mcp-oauth/crypto";
import { normalizeAiClient } from "../services/mcp-oauth/types";
import {
  mcpOAuthConsentPage,
  mcpOAuthErrorPage,
  mcpOAuthLoginPage,
} from "../services/mcp-oauth/authorize-page";

const oauth = new Hono<{ Bindings: Env }>();

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function redirectWithParams(
  env: Env,
  requestUrl: string,
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set("iss", mcpOAuthIssuer(env, requestUrl));
  return Response.redirect(target.toString(), 302);
}

async function sessionFromRequest(env: Env, request: Request) {
  const token = readSessionCookie(request.headers.get("Cookie"));
  if (!token) return null;
  const session = await verifySessionToken(token, env.SESSION_SECRET);
  if (!session) return null;
  const dbUser = await getUserById(env.DB, session.userId);
  if (!dbUser || dbUser.status !== "active") return null;
  return session;
}

function authorizeQuery(source: URLSearchParams | FormData): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "resource",
    "company",
    "client",
  ]) {
    const value = source.get(key);
    if (typeof value === "string" && value) out.set(key, value);
  }
  return out;
}

oauth.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(mcpOAuthAuthorizationServerMetadata(c.env, c.req.url)),
);
oauth.get("/.well-known/oauth-authorization-server/oauth/mcp", (c) =>
  c.json(mcpOAuthAuthorizationServerMetadata(c.env, c.req.url)),
);
oauth.get("/.well-known/openid-configuration", (c) =>
  c.json(mcpOAuthOpenIdConfiguration(c.env, c.req.url)),
);
oauth.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(mcpOAuthProtectedResourceMetadata(c.env, c.req.url)),
);
oauth.get("/.well-known/oauth-protected-resource/api/gateway/v1/mcp", (c) =>
  c.json(mcpOAuthProtectedResourceMetadata(c.env, c.req.url)),
);

oauth.post("/oauth/mcp/register", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const { client, clientIdIssuedAt } = await registerMcpOAuthClient(c.env.DB, body);
    return c.json(dcrResponse(client, clientIdIssuedAt, mcpOAuthIssuer(c.env, c.req.url)), 201);
  } catch (error) {
    if (error instanceof McpOAuthRequestError) {
      return c.json({ error: error.error, error_description: error.message }, error.status as 400);
    }
    return c.json({ error: "server_error", error_description: "Registration failed." }, 500);
  }
});

oauth.get("/oauth/mcp/authorize", async (c) => {
  return handleAuthorize(c.env, c.req.raw, new URL(c.req.url));
});

oauth.post("/oauth/mcp/authorize", async (c) => {
  return handleAuthorize(c.env, c.req.raw, new URL(c.req.url));
});

oauth.post("/oauth/mcp/token", async (c) => {
  const form = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") params.set(key, value);
  }
  try {
    const grantType = params.get("grant_type") ?? "";
    if (grantType === "authorization_code") {
      return c.json(await exchangeCode(c.env, params, c.req.url));
    }
    if (grantType === "refresh_token") {
      return c.json(await exchangeRefresh(c.env, params, c.req.url));
    }
    return c.json(
      { error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." },
      400,
    );
  } catch (error) {
    if (error instanceof McpOAuthRequestError) {
      return c.json({ error: error.error, error_description: error.message }, error.status as 400);
    }
    return c.json({ error: "server_error", error_description: "Token endpoint failed." }, 500);
  }
});

oauth.on(["GET", "POST"], "/oauth/mcp/userinfo", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const claims = token ? await verifyInfraMcpAccessToken(c.env, token, c.req.url) : null;
  if (!claims) {
    return c.json({ error: "invalid_token", error_description: "Bearer token required." }, 401);
  }
  const live = await resolveLiveMcpPrincipal(c.env.DB, {
    userId: claims.sub,
    companyId: claims.company_id,
  });
  if (!live.ok) {
    return c.json({ error: "invalid_token", error_description: live.reason }, 401);
  }
  return c.json({
    sub: live.principal.userId,
    email: live.principal.email,
    name: live.principal.displayName,
    company_id: live.principal.companyId,
    company_slug: live.principal.companySlug,
    client: claims.client,
    email_verified: true,
  });
});

oauth.post("/oauth/mcp/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  if (token) {
    await consumeRefreshToken(c.env.DB, token).catch(() => null);
  }
  return c.json({ revoked: true });
});

async function handleAuthorize(env: Env, request: Request, url: URL): Promise<Response> {
  const incoming = request.method === "POST" ? await request.formData() : url.searchParams;
  const params = authorizeQuery(incoming);
  const responseType = params.get("response_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const scope = params.get("scope");
  const resource = params.get("resource");
  const clientType = normalizeAiClient(params.get("client"));

  if (responseType !== "code") {
    return html(mcpOAuthErrorPage("Only response_type=code is supported."), 400);
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return html(mcpOAuthErrorPage("PKCE S256 code_challenge is required."), 400);
  }
  const client = await resolveMcpOAuthClient(env.DB, clientId, redirectUri);
  if (!client) {
    return html(mcpOAuthErrorPage("Unknown or unregistered OAuth client, or redirect_uri mismatch."), 400);
  }

  const intent = request.method === "POST" && incoming instanceof FormData ? String(incoming.get("intent") ?? "") : "";

  if (intent === "login") {
    const email = String(incoming.get("email") ?? "");
    const password = String(incoming.get("password") ?? "");
    const user = await getUserByEmail(env.DB, email);
    if (!user || user.status !== "active" || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) {
      return html(mcpOAuthLoginPage(params, "Email or password is incorrect."), 401);
    }
    const sessionUser = await toSessionUser(env.DB, user);
    const sessionToken = await createSessionToken(sessionUser, env.SESSION_SECRET);
    await recordUserLogin(env.DB, user.id);
    const company = await resolveCompanyForMcpResource(env.DB, {
      companySlug: params.get("company"),
      resource,
    });
    if (!company) {
      return html(mcpOAuthErrorPage("This connection is missing a company. Restart Connect ChatGPT from your INFRA portal."), 400);
    }
    const live = await resolveLiveMcpPrincipal(env.DB, { userId: user.id, companyId: company.id });
    if (!live.ok) {
      return html(mcpOAuthErrorPage("You do not have an active membership for this company."), 403);
    }
    const response = html(mcpOAuthConsentPage(params, { ...live.principal, client: clientType }, client.clientName));
    const wrapper = {
      header: (name: string, value: string) => response.headers.set(name, value),
      req: { url: request.url },
      env,
    };
    setSessionCookie(wrapper, sessionToken);
    return response;
  }

  if (intent === "deny") {
    return redirectWithParams(env, request.url, redirectUri, {
      error: "access_denied",
      error_description: "The employee cancelled the INFRA authorisation.",
      state,
    });
  }

  const session = await sessionFromRequest(env, request);
  if (!session) {
    return html(mcpOAuthLoginPage(params));
  }

  const company = await resolveCompanyForMcpResource(env.DB, {
    companySlug: params.get("company"),
    resource,
  });
  if (!company) {
    const only = session.memberships.length === 1 ? await getCompanyById(env.DB, session.memberships[0].companyId) : null;
    if (!only) {
      return html(mcpOAuthErrorPage("Select a company in INFRA AI Access, then connect ChatGPT again."), 400);
    }
    const liveOnly = await resolveLiveMcpPrincipal(env.DB, { userId: session.userId, companyId: only.id });
    if (!liveOnly.ok) {
      return html(mcpOAuthErrorPage("You do not have an active membership for this company."), 403);
    }
    if (intent === "allow") {
      return completeAuthorize(env, request, {
        clientId,
        redirectUri,
        state,
        codeChallenge,
        resource,
        scope,
        clientType,
        userId: session.userId,
        companyId: only.id,
      });
    }
    return html(mcpOAuthConsentPage(params, { ...liveOnly.principal, client: clientType }, client.clientName));
  }

  const live = await resolveLiveMcpPrincipal(env.DB, { userId: session.userId, companyId: company.id });
  if (!live.ok) {
    return html(mcpOAuthErrorPage("You do not have an active membership for this company."), 403);
  }
  if (intent === "allow") {
    return completeAuthorize(env, request, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      resource,
      scope,
      clientType,
      userId: session.userId,
      companyId: company.id,
    });
  }
  return html(mcpOAuthConsentPage(params, { ...live.principal, client: clientType }, client.clientName));
}

async function completeAuthorize(
  env: Env,
  request: Request,
  input: {
    clientId: string;
    redirectUri: string;
    state: string | null;
    codeChallenge: string;
    resource: string | null;
    scope: string | null;
    clientType: string;
    userId: string;
    companyId: string;
  },
): Promise<Response> {
  const live = await resolveLiveMcpPrincipal(env.DB, {
    userId: input.userId,
    companyId: input.companyId,
  });
  if (!live.ok) {
    return html(mcpOAuthErrorPage("You do not have an active membership for this company."), 403);
  }
  const code = await issueAuthorizationCode(env.DB, {
    clientId: input.clientId,
    userId: input.userId,
    companyId: input.companyId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    scope: input.scope,
    clientType: input.clientType,
  });
  await upsertMcpOAuthGrant(env.DB, {
    userId: input.userId,
    companyId: input.companyId,
    clientType: input.clientType,
    clientId: input.clientId,
  });
  return redirectWithParams(env, request.url, input.redirectUri, {
    code,
    state: input.state,
  });
}

async function exchangeCode(env: Env, form: URLSearchParams, requestUrl: string) {
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const clientId = form.get("client_id") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";
  const resource = form.get("resource");
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    throw new McpOAuthRequestError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required.");
  }
  const stored = await consumeAuthorizationCode(env.DB, code);
  if (!stored) {
    throw new McpOAuthRequestError("invalid_grant", "Authorization code is invalid, expired, or already used.");
  }
  if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
    throw new McpOAuthRequestError("invalid_grant", "Authorization code client or redirect_uri mismatch.");
  }
  if (!(await verifyPkceS256(codeVerifier, stored.codeChallenge))) {
    throw new McpOAuthRequestError("invalid_grant", "PKCE verification failed.");
  }
  const live = await resolveLiveMcpPrincipal(env.DB, {
    userId: stored.userId,
    companyId: stored.companyId,
  });
  if (!live.ok) {
    throw new McpOAuthRequestError("access_denied", "INFRA user is disabled or has no active membership.", 403);
  }
  const issued = await issueInfraMcpAccessToken(env, {
    userId: live.principal.userId,
    companyId: live.principal.companyId,
    companySlug: live.principal.companySlug,
    client: stored.clientType,
    clientId,
    email: live.principal.email,
    name: live.principal.displayName,
    resource: resource || stored.resource,
    scope: stored.scope,
    requestUrl,
  });
  if (!issued) {
    throw new McpOAuthRequestError("server_error", "Unable to issue INFRA MCP access token.", 500);
  }
  const refreshToken = await issueRefreshToken(env.DB, {
    clientId,
    userId: live.principal.userId,
    companyId: live.principal.companyId,
    resource: issued.claims.aud,
    scope: stored.scope,
    clientType: stored.clientType,
  });
  return {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: refreshToken,
    scope: issued.claims.scope,
  };
}

async function exchangeRefresh(env: Env, form: URLSearchParams, requestUrl: string) {
  const refresh = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  if (!refresh || !clientId) {
    throw new McpOAuthRequestError("invalid_request", "refresh_token and client_id are required.");
  }
  const stored = await consumeRefreshToken(env.DB, refresh);
  if (!stored || stored.clientId !== clientId) {
    throw new McpOAuthRequestError("invalid_grant", "Refresh token is invalid or revoked.");
  }
  const live = await resolveLiveMcpPrincipal(env.DB, {
    userId: stored.userId,
    companyId: stored.companyId,
  });
  if (!live.ok) {
    throw new McpOAuthRequestError("access_denied", "INFRA user is disabled or has no active membership.", 403);
  }
  const issued = await issueInfraMcpAccessToken(env, {
    userId: live.principal.userId,
    companyId: live.principal.companyId,
    companySlug: live.principal.companySlug,
    client: stored.clientType,
    clientId,
    email: live.principal.email,
    name: live.principal.displayName,
    resource: stored.resource,
    scope: stored.scope,
    requestUrl,
  });
  if (!issued) {
    throw new McpOAuthRequestError("server_error", "Unable to issue INFRA MCP access token.", 500);
  }
  const nextRefresh = await issueRefreshToken(env.DB, {
    clientId,
    userId: live.principal.userId,
    companyId: live.principal.companyId,
    resource: stored.resource,
    scope: stored.scope,
    clientType: stored.clientType,
  });
  return {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: nextRefresh,
    scope: issued.claims.scope,
  };
}

export default oauth;
