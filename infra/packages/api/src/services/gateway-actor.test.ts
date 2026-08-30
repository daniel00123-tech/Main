import { describe, expect, it } from "vitest";
import { createSessionToken } from "../auth/session";
import { issueMcpAccessToken } from "../auth/mcp-oauth";
import { extractServiceCredential, resolveGatewayActor } from "./gateway";
import type { Env } from "../env";

const SECRET = "test-session-secret-for-mcp-oauth";
const ISSUER = "https://app.infrastack.app";

function env(row: Record<string, unknown> | null, serviceRow: Record<string, unknown> | null = null): Env {
  return {
    SESSION_SECRET: SECRET,
    INFRA_PUBLIC_API_URL: ISSUER,
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            const q = sql.toLowerCase();
            if (q.includes("oauth_access_jti")) return null;
            if (q.includes("company_memberships")) return row;
            if (q.includes("service_identities") || q.includes("token_hash")) return serviceRow;
            return null;
          },
        }),
      }),
    },
  } as unknown as Env;
}

describe("gateway actor resolution", () => {
  it("binds an INFRA user JWT and reloads live membership", async () => {
    const access = await issueMcpAccessToken(SECRET, ISSUER, `${ISSUER}/api/gateway/v1/mcp`, {
      userId: "user_william",
      email: "william@elvexpropertyservices.com",
      companyId: "co_el",
      membershipId: "mem_william",
      clientId: "chatgpt-mcp",
      channel: "chatgpt",
    });
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp", {
      headers: { Authorization: `Bearer ${access.token}` },
    });
    const actor = await resolveGatewayActor(
      env({
        user_id: "user_william",
        email: "william@elvexpropertyservices.com",
        display_name: "William",
        is_platform_admin: 0,
        user_status: "active",
        membership_id: "mem_william",
        company_id: "co_el",
        role: "office_staff",
        membership_status: "active",
        custom_role_id: null,
        team_id: null,
      }),
      request,
      null,
    );
    expect("type" in actor && actor.type === "user").toBe(true);
    if ("type" in actor && actor.type === "user") {
      expect(actor.boundCompanyId).toBe("co_el");
      expect(actor.channel).toBe("chatgpt");
      expect(actor.user.memberships[0]?.role).toBe("office_staff");
    }
  });

  it("does not accept a portal session JWT as an MCP bearer", async () => {
    const session = await createSessionToken(
      {
        userId: "user_william",
        email: "william@elvexpropertyservices.com",
        displayName: "William",
        isPlatformAdmin: false,
        memberships: [{ companyId: "co_el", role: "director" }],
      },
      SECRET,
    );
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp", {
      headers: { Authorization: `Bearer ${session}` },
    });
    const actor = await resolveGatewayActor(env(null), request, null);
    expect("error" in actor).toBe(true);
    if ("error" in actor) expect(actor.status).toBe(401);
  });

  it("denies a disabled user with an otherwise valid access token", async () => {
    const access = await issueMcpAccessToken(SECRET, ISSUER, `${ISSUER}/api/gateway/v1/mcp`, {
      userId: "user_william",
      email: "william@elvexpropertyservices.com",
      companyId: "co_el",
      membershipId: "mem_william",
      clientId: "chatgpt-mcp",
      channel: "chatgpt",
    });
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp", {
      headers: { Authorization: `Bearer ${access.token}` },
    });
    const actor = await resolveGatewayActor(
      env({
        user_id: "user_william",
        email: "william@elvexpropertyservices.com",
        display_name: "William",
        is_platform_admin: 0,
        user_status: "disabled",
        membership_id: "mem_william",
        company_id: "co_el",
        role: "office_staff",
        membership_status: "active",
        custom_role_id: null,
        team_id: null,
      }),
      request,
      null,
    );
    expect("error" in actor && actor.status === 403).toBe(true);
  });

  it("reads bearer credentials without treating cookies as MCP auth", () => {
    const request = new Request("https://el-business-mcp.infrastack.app/mcp", {
      headers: {
        Cookie: "infra_session=abc",
        Authorization: "Bearer infra_company_token",
      },
    });
    expect(extractServiceCredential(request)).toBe("infra_company_token");
  });
});
