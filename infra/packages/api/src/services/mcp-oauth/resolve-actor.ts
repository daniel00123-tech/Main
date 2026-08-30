import type { Env } from "../../env";
import type { SessionUser } from "../../auth/session";
import { peekMcpAccessTyp, verifyInfraMcpAccessToken } from "./tokens";
import { MCP_ACCESS_TYP } from "./types";
import { resolveLiveMcpPrincipal, sessionUserFromPrincipal } from "./principal";

export type ResolvedMcpUser = {
  user: SessionUser;
  companyId: string;
  companySlug: string;
  client: string;
  jti: string;
};

export type ResolveMcpUserResult =
  | { ok: true; value: ResolvedMcpUser }
  | { ok: false; status: 401 | 403; error: string; isMcpToken: boolean };

export async function resolveMcpUserFromBearer(
  env: Env,
  token: string,
  requestUrl?: string | URL | null,
): Promise<ResolveMcpUserResult> {
  const typ = peekMcpAccessTyp(token);
  if (typ !== MCP_ACCESS_TYP) {
    return { ok: false, status: 401, error: "Not an INFRA MCP access token", isMcpToken: false };
  }
  const claims = await verifyInfraMcpAccessToken(env, token, requestUrl);
  if (!claims) {
    return { ok: false, status: 401, error: "INFRA MCP access token is invalid or expired", isMcpToken: true };
  }
  const live = await resolveLiveMcpPrincipal(env.DB, {
    userId: claims.sub,
    companyId: claims.company_id,
  });
  if (!live.ok) {
    return {
      ok: false,
      status: 403,
      error: live.reason === "unknown_user" ? "Unknown INFRA user" : "INFRA user is disabled or has no active membership",
      isMcpToken: true,
    };
  }
  if (live.principal.companyId !== claims.company_id || live.principal.companySlug !== claims.company_slug) {
    return { ok: false, status: 403, error: "MCP token company does not match current INFRA membership", isMcpToken: true };
  }
  return {
    ok: true,
    value: {
      user: sessionUserFromPrincipal({ ...live.principal, client: claims.client }),
      companyId: live.principal.companyId,
      companySlug: live.principal.companySlug,
      client: claims.client,
      jti: claims.jti,
    },
  };
}

export function introspectPayload(
  result: ResolveMcpUserResult,
  claims?: { client?: string; exp?: number; jti?: string } | null,
) {
  if (!result.ok) {
    return { active: false, reason: result.error };
  }
  const membership = result.value.user.memberships[0];
  return {
    active: true,
    user_id: result.value.user.userId,
    email: result.value.user.email,
    display_name: result.value.user.displayName,
    company_id: result.value.companyId,
    company_slug: result.value.companySlug,
    role: membership?.role ?? null,
    client: result.value.client,
    jti: result.value.jti,
    exp: claims?.exp ?? null,
  };
}
