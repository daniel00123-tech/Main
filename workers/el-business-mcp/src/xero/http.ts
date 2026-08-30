import type { Env } from "../env";
import { ElXeroError, sanitizeErrorMessage } from "./errors";
import { completeXeroCallback, disconnectXero, startXeroConnect } from "./oauth";
import { recordOauthCallback } from "./store";

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui;max-width:42rem;margin:3rem auto;padding:0 1.25rem;color:#111}
code{background:#f3f4f6;padding:.1rem .35rem;border-radius:.25rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function handleXeroOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hasCode = Boolean(url.searchParams.get("code"));
  const hasState = Boolean(url.searchParams.get("state"));
  try {
    const result = await completeXeroCallback(env, url);
    await recordOauthCallback(env.EL_BUSINESS_DATA, { ok: true, hasCode, hasState });
    return htmlPage(
      "Xero connected",
      `<p>EL Business MCP is now connected to <strong>${result.organisationName}</strong>.</p>
<p>Tenant ID: <code>${result.tenantId}</code></p>
<p>You can close this window and return to INFRA.</p>`
    );
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    const code = error instanceof ElXeroError ? error.code : "EL_XERO_OAUTH";
    await recordOauthCallback(env.EL_BUSINESS_DATA, { ok: false, error: `${code}: ${message}`, hasCode, hasState });
    return htmlPage("Xero connection failed", `<p>${message}</p><p>Code: <code>${code}</code></p>`, 400);
  }
}

export async function handleXeroConnect(request: Request, env: Env): Promise<Response> {
  const started = await startXeroConnect(env);
  const accept = request.headers.get("Accept") ?? "";
  const forceRedirect = new URL(request.url).searchParams.get("redirect") === "1";
  if (forceRedirect || accept.includes("text/html")) {
    return Response.redirect(started.authorizeUrl, 302);
  }
  return new Response(
    JSON.stringify({
      ok: true,
      authorizeUrl: started.authorizeUrl,
      expiresInSeconds: started.expiresInSeconds,
      redirectUri: "https://el-business-mcp.infrastack.app/oauth/xero/callback",
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export async function handleXeroDisconnect(env: Env): Promise<{ ok: true }> {
  await disconnectXero(env);
  return { ok: true };
}
