import { Hono } from "hono";
import type { Env } from "../env";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import { getUserById, listMembershipsForUser } from "../auth/users";
import { loadLiveCompanyActor } from "../auth/live-identity";
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  createAuthorizationCode,
  ensureDefaultChatgptClient,
  getOauthClient,
  isAiChannelEnabled,
  issueMcpAccessToken,
  issueRefreshToken,
  looksLikeJwt,
  normalizeOauthChannel,
  oauthAuthorizationServerMetadata,
  oauthIssuer,
  oauthProtectedResourceMetadata,
  openidConfiguration,
  recordAccessJti,
  redirectUriAllowed,
  registerOauthClient,
  upsertAiUserConnection,
} from "../auth/mcp-oauth";
import { getCompanyById, getCompanyBySlug } from "../services/control-plane";
import {
  infraBrowserPublicBase,
  infraMcpGatewayUrl,
} from "../services/public-urls";

const oauth = new Hono<{ Bindings: Env }>();

function issuerFrom(env: Env, request: Request): string {
  return oauthIssuer(infraBrowserPublicBase(env, request.url, request));
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
    .wrap { max-width: 440px; margin: 64px auto; padding: 28px; background: #1e293b; border-radius: 16px; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #94a3b8; line-height: 1.5; }
    .brand { letter-spacing: 0.14em; font-size: 0.75rem; color: #38bdf8; margin-bottom: 16px; }
    button, .btn { display: inline-block; background: #38bdf8; color: #0f172a; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 600; cursor: pointer; text-decoration: none; }
    .muted { font-size: 0.85rem; }
  </style>
</head>
<body><div class="wrap"><div class="brand">INFRA</div>${body}</div></body>
</html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function metadataHeaders(): Record<string, string> {
  return {
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  };
}

function authorizationServerDocument(c: { env: Env; req: { raw: Request; url: string } }) {
  const issuer = issuerFrom(c.env, c.req.raw);
  return oauthAuthorizationServerMetadata(issuer);
}

function protectedResourceDocument(c: { env: Env; req: { raw: Request; url: string } }) {
  const issuer = issuerFrom(c.env, c.req.raw);
  const resource = infraMcpGatewayUrl(c.env, c.req.url, c.req.raw);
  return oauthProtectedResourceMetadata(issuer, resource);
}

oauth.get("/.well-known/oauth-authorization-server", (c) => {
  return c.json(authorizationServerDocument(c), 200, metadataHeaders());
});

oauth.get("/.well-known/openid-configuration", (c) => {
  return c.json(openidConfiguration(issuerFrom(c.env, c.req.raw)), 200, metadataHeaders());
});

oauth.get("/.well-known/oauth-protected-resource", (c) => {
  return c.json(protectedResourceDocument(c), 200, metadataHeaders());
});

oauth.get("/.well-known/oauth-protected-resource/api/gateway/v1/mcp", (c) => {
  return c.json(protectedResourceDocument(c), 200, metadataHeaders());
});

oauth.get("/api/.well-known/oauth-authorization-server", (c) => {
  return c.json(authorizationServerDocument(c), 200, metadataHeaders());
});

oauth.get("/api/.well-known/openid-configuration", (c) => {
  return c.json(openidConfiguration(issuerFrom(c.env, c.req.raw)), 200, metadataHeaders());
});

oauth.get("/api/.well-known/oauth-protected-resource", (c) => {
  return c.json(protectedResourceDocument(c), 200, metadataHeaders());
});

oauth.get("/api/gateway/v1/mcp/.well-known/oauth-protected-resource", (c) => {
  return c.json(protectedResourceDocument(c), 200, metadataHeaders());
});

oauth.post("/oauth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  try {
    const client = await registerOauthClient(c.env.DB, {
      clientName: body.client_name,
      redirectUris,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
    });
    return c.json({
      client_id: client.id,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : "Invalid registration",
      },
      400,
    );
  }
});

oauth.get("/oauth/authorize", async (c) => {
  await ensureDefaultChatgptClient(c.env.DB);
  const query = c.req.query();
  const clientId = query.client_id ?? "";
  const redirectUri = query.redirect_uri ?? "";
  const responseType = query.response_type ?? "";
  const state = query.state ?? null;
  const codeChallenge = query.code_challenge ?? "";
  const method = query.code_challenge_method ?? "";
  const scope = query.scope ?? "mcp";
  const resource = query.resource ?? infraMcpGatewayUrl(c.env, c.req.url, c.req.raw);
  const companyHint = query.company ?? query.tenant ?? "";
  const channel = normalizeOauthChannel(query.channel ?? query.client_type);

  if (responseType !== "code") {
    return c.json({ error: "unsupported_response_type" }, 400);
  }
  if (!clientId || !redirectUri || !codeChallenge || method !== "S256") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "client_id, redirect_uri, and PKCE S256 code_challenge are required",
      },
      400,
    );
  }

  const client = await getOauthClient(c.env.DB, clientId);
  if (!client || !redirectUriAllowed(client, redirectUri)) {
    return c.json({ error: "invalid_client", error_description: "Unknown client or redirect_uri" }, 400);
  }

  const session = await sessionFromRequest(c.env, c.req.raw);
  if (!session) {
    const authorizeUrl = new URL(c.req.url);
    const loginBase = infraBrowserPublicBase(c.env, c.req.url, c.req.raw);
    const loginOrigin =
      loginBase.includes("infrastack.app") || loginBase.includes("pages.dev")
        ? loginBase
        : "https://app.infrastack.app";
    const login = new URL("/portal/login", `${loginOrigin}/`);
    login.searchParams.set("next", authorizeUrl.toString());
    return c.redirect(login.toString(), 302);
  }

  const memberships = await listMembershipsForUser(c.env.DB, session.userId);
  let company = companyHint
    ? (await getCompanyBySlug(c.env.DB, companyHint)) ??
      (await getCompanyById(c.env.DB, companyHint))
    : null;
  if (!company && memberships.length === 1) {
    company = await getCompanyById(c.env.DB, memberships[0]!.companyId);
  }
  if (!company) {
    const options = (
      await Promise.all(memberships.map((item) => getCompanyById(c.env.DB, item.companyId)))
    ).filter(Boolean);
    const list = options
      .map((item) => {
        const url = new URL(c.req.url);
        url.searchParams.set("company", item!.slug);
        return `<p><a class="btn" href="${escapeHtml(url.toString())}">${escapeHtml(item!.name)}</a></p>`;
      })
      .join("");
    return htmlPage(
      "Choose company",
      `<h1>Choose a company</h1><p>Connect ChatGPT as ${escapeHtml(session.displayName)}.</p>${list || "<p>No company memberships.</p>"}`,
    );
  }

  const actor = await loadLiveCompanyActor(c.env.DB, session.userId, company.id);
  if (!actor?.active) {
    return htmlPage(
      "Access denied",
      `<h1>Access denied</h1><p>${escapeHtml(actor?.denyReason ?? "This INFRA user cannot connect ChatGPT.")}</p>`,
      403,
    );
  }

  const enabled = await isAiChannelEnabled(c.env.DB, company.id, channel);
  if (!enabled) {
    return htmlPage(
      "ChatGPT is not enabled",
      `<h1>ChatGPT is not enabled</h1><p>Ask a company administrator to enable ChatGPT for ${escapeHtml(company.name)}. You do not need admin access to connect your own account once it is enabled.</p>`,
      403,
    );
  }

  const code = await createAuthorizationCode(c.env.DB, {
    clientId: client.id,
    actor,
    redirectUri,
    codeChallenge,
    scope,
    resource,
    channel,
  });
  await upsertAiUserConnection(c.env.DB, {
    companyId: company.id,
    userId: actor.userId,
    membershipId: actor.membershipId,
    clientType: channel,
    oauthClientId: client.id,
  });

  const next = new URL(redirectUri);
  next.searchParams.set("code", code);
  if (state) next.searchParams.set("state", state);
  return c.redirect(next.toString(), 302);
});

oauth.post("/oauth/token", async (c) => {
  const issuer = issuerFrom(c.env, c.req.raw);
  const resourceDefault = infraMcpGatewayUrl(c.env, c.req.url, c.req.raw);
  const contentType = c.req.header("content-type") ?? "";
  const params = contentType.includes("application/json")
    ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(await c.req.text()));

  const grantType = String(params.grant_type ?? "");
  const clientId = String(params.client_id ?? "");
  if (!clientId) return c.json({ error: "invalid_client" }, 401);
  const client = await getOauthClient(c.env.DB, clientId);
  if (!client) return c.json({ error: "invalid_client" }, 401);

  if (grantType === "authorization_code") {
    const code = String(params.code ?? "");
    const redirectUri = String(params.redirect_uri ?? "");
    const verifier = String(params.code_verifier ?? "");
    if (!code || !redirectUri || !verifier) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const consumed = await consumeAuthorizationCode(
      c.env.DB,
      code,
      clientId,
      redirectUri,
      verifier,
    );
    if ("error" in consumed) return c.json({ error: consumed.error }, 400);

    const actor = await loadLiveCompanyActor(c.env.DB, consumed.userId, consumed.companyId);
    if (!actor?.active) {
      return c.json({ error: "invalid_grant", error_description: actor?.denyReason ?? "User is not active" }, 400);
    }

    const access = await issueMcpAccessToken(c.env.SESSION_SECRET, issuer, resourceDefault, {
      userId: actor.userId,
      email: actor.email,
      companyId: actor.companyId,
      membershipId: actor.membershipId,
      clientId,
      channel: consumed.channel,
    });
    await recordAccessJti(c.env.DB, {
      jti: access.jti,
      userId: actor.userId,
      companyId: actor.companyId,
    });
    const refresh = await issueRefreshToken(c.env.DB, {
      clientId,
      userId: actor.userId,
      companyId: actor.companyId,
      membershipId: actor.membershipId,
      scope: consumed.scope,
      resource: consumed.resource,
      channel: consumed.channel,
    });
    await upsertAiUserConnection(c.env.DB, {
      companyId: actor.companyId,
      userId: actor.userId,
      membershipId: actor.membershipId,
      clientType: consumed.channel,
      oauthClientId: clientId,
    });

    return c.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refresh,
      scope: consumed.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refresh = String(params.refresh_token ?? "");
    if (!refresh || looksLikeJwt(refresh)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const consumed = await consumeRefreshToken(c.env.DB, refresh, clientId);
    if ("error" in consumed) return c.json({ error: consumed.error }, 400);
    const actor = await loadLiveCompanyActor(c.env.DB, consumed.userId, consumed.companyId);
    if (!actor?.active) {
      return c.json({ error: "invalid_grant", error_description: actor?.denyReason ?? "User is not active" }, 400);
    }
    const access = await issueMcpAccessToken(c.env.SESSION_SECRET, issuer, resourceDefault, {
      userId: actor.userId,
      email: actor.email,
      companyId: actor.companyId,
      membershipId: actor.membershipId,
      clientId,
      channel: consumed.channel,
    });
    await recordAccessJti(c.env.DB, {
      jti: access.jti,
      userId: actor.userId,
      companyId: actor.companyId,
    });
    return c.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      scope: consumed.scope,
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

oauth.post("/oauth/revoke", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  const params = contentType.includes("application/json")
    ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(await c.req.text()));
  const token = String(params.token ?? "");
  const clientId = String(params.client_id ?? "");
  if (token && clientId) {
    await consumeRefreshToken(c.env.DB, token, clientId);
  }
  return c.body(null, 200);
});

export default oauth;
