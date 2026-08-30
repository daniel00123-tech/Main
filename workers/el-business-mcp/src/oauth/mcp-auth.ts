import type { Env } from "../env";
import { mcpPublicOrigin } from "./config";
import { oauthWwwAuthenticate } from "./cors";
import { verifyMcpAccessToken } from "./jwt";
import { resolveActor } from "../rbac/identity";
import type { ElvexActor } from "../rbac/actor";

export type McpAuthGate = {
  allowed: boolean;
  actor: ElvexActor;
  challenge: boolean;
  reason: string;
};

const DISCOVERY_METHODS = new Set([
  "initialize",
  "initialized",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "logging/setLevel",
]);

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function peekJsonRpcMethod(request: Request): Promise<string | null> {
  if (request.method !== "POST") return null;
  try {
    const body = (await request.clone().json()) as { method?: unknown };
    return typeof body.method === "string" ? body.method : null;
  } catch {
    return null;
  }
}

export function isMcpDiscoveryMethod(method: string | null): boolean {
  return Boolean(method && DISCOVERY_METHODS.has(method));
}

/**
 * Employee ChatGPT access uses a verified MCP JWT (Entra oid).
 * Shared MCP_AUTH_TOKEN is machine/service transport only — never a human admin.
 * Unauthenticated tool calls fail closed with an OAuth challenge.
 * Discovery methods may proceed without a token so ChatGPT can list tools after
 * reading protected-resource metadata; business tools still deny unbound actors.
 */
export async function gateMcpRequest(request: Request, env: Env): Promise<McpAuthGate> {
  const actor = await resolveActor(env, request);
  const bearer = extractBearerToken(request);
  const method = await peekJsonRpcMethod(request);

  if (actor.identityBound) {
    return { allowed: true, actor, challenge: false, reason: "bound_identity" };
  }

  if (bearer) {
    const mcpJwt = await verifyMcpAccessToken(env, bearer);
    if (mcpJwt) {
      return { allowed: true, actor, challenge: false, reason: "microsoft_oidc_unbound" };
    }
    if (env.MCP_AUTH_TOKEN?.trim() && bearer === env.MCP_AUTH_TOKEN.trim()) {
      return { allowed: true, actor, challenge: false, reason: "service_token_unbound" };
    }
    return {
      allowed: false,
      actor,
      challenge: true,
      reason: "invalid_bearer",
    };
  }

  if (isMcpDiscoveryMethod(method) || request.method === "GET") {
    return { allowed: true, actor, challenge: false, reason: "discovery" };
  }

  return {
    allowed: false,
    actor,
    challenge: true,
    reason: "unauthenticated",
  };
}

export function mcpOAuthUnauthorizedResponse(env: Env, reason = "unauthorized"): Response {
  const origin = mcpPublicOrigin(env);
  return new Response(JSON.stringify({ error: "Unauthorized", reason }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": oauthWwwAuthenticate(origin),
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    },
  });
}
