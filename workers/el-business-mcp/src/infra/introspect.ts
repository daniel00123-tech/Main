import type { Env } from "../env";
import { infraIntrospectUrl } from "../oauth/config";
import { isElvexRole, type ElvexRole } from "../rbac/roles";

export type InfraIntrospectResult = {
  active: boolean;
  user_id?: string;
  email?: string;
  display_name?: string;
  company_id?: string;
  company_slug?: string;
  role?: ElvexRole | null;
  client?: string;
  reason?: string;
};

/**
 * Ask INFRA for the current membership/role. Fail closed when INFRA says
 * inactive. If INFRA is not configured, return null so D1 can be used.
 */
export async function introspectInfraMcpToken(
  env: Env,
  input: { token?: string | null; userId: string; companyId: string }
): Promise<InfraIntrospectResult | null> {
  const url = infraIntrospectUrl(env);
  if (!url) return null;
  const bearer = env.MCP_AUTH_TOKEN?.trim() || env.INFRA_MCP_INTERNAL_SECRET?.trim();
  if (!bearer) return null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        token: input.token,
        companyId: input.companyId,
        userId: input.userId,
      }),
    });
    if (!response.ok) {
      return { active: false, reason: `introspect_http_${response.status}` };
    }
    const body = (await response.json()) as InfraIntrospectResult;
    if (body.role && !isElvexRole(body.role)) {
      return { ...body, role: null, active: body.active === true };
    }
    return body;
  } catch {
    return { active: false, reason: "introspect_unreachable" };
  }
}
