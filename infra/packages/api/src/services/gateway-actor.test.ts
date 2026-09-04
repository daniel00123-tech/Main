import { describe, expect, it } from "vitest";
import { createSessionToken } from "../auth/session";
import { issueMcpAccessToken } from "../auth/mcp-oauth";
import {
  extractServiceCredential,
  executeGatewayRequest,
  resolveGatewayActor,
} from "./gateway";
import type { Env } from "../env";
import type { ServiceIdentityRecord } from "./service-identities";

const SECRET = "test-session-secret-for-mcp-oauth";
const ISSUER = "https://app.infrastack.app";

function env(
  row: Record<string, unknown> | null,
  serviceRow: Record<string, unknown> | null = null,
  extras: { jti?: Record<string, unknown> | null } = {},
): Env {
  return {
    SESSION_SECRET: SECRET,
    INFRA_PUBLIC_API_URL: ISSUER,
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            const q = sql.toLowerCase();
            if (q.includes("oauth_access_jti")) return extras.jti === undefined ? null : extras.jti;
            if (q.includes("company_memberships")) return row;
            if (q.includes("service_identities") || q.includes("token_hash")) return serviceRow;
            return null;
          },
          run: async () => ({ success: true }),
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

  it("rejects a ChatGPT-typed service token on the MCP facade", async () => {
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp", {
      headers: {
        Authorization: "Bearer infra_shared_human",
        "User-Agent": "ChatGPT-User/1.0",
      },
    });
    const actor = await resolveGatewayActor(
      env(null, {
        id: "svc_chatgpt",
        company_id: "co_el",
        name: "EL Business ChatGPT",
        status: "active",
        identity_type: "chatgpt",
        token_hash: "abc",
        scopes_json: "[]",
      }),
      request,
      null,
      { mcpFacade: true },
    );
    expect("error" in actor && actor.status === 401).toBe(true);
    if ("error" in actor) {
      expect(actor.error).toMatch(/INFRA OAuth/);
    }
  });

  it("rejects cookie-only access on the MCP facade", async () => {
    const sessionUser = {
      userId: "user_william",
      email: "william@elvexpropertyservices.com",
      displayName: "William",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_el", role: "office_staff" as const }],
    };
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp");
    const actor = await resolveGatewayActor(env(null), request, sessionUser, {
      mcpFacade: true,
    });
    expect("error" in actor && actor.status === 401).toBe(true);
  });

  it("denies a valid token when the user has no company membership", async () => {
    const access = await issueMcpAccessToken(SECRET, ISSUER, `${ISSUER}/api/gateway/v1/mcp`, {
      userId: "user_sharon",
      email: "sharon@example.com",
      companyId: "co_el",
      membershipId: "mem_missing",
      clientId: "chatgpt-mcp",
      channel: "chatgpt",
    });
    const request = new Request("https://app.infrastack.app/api/gateway/v1/mcp", {
      headers: { Authorization: `Bearer ${access.token}` },
    });
    const actor = await resolveGatewayActor(env(null), request, null, { mcpFacade: true });
    expect("error" in actor && actor.status === 403).toBe(true);
  });

  it("denies a disabled company membership", async () => {
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
        membership_status: "disabled",
        custom_role_id: null,
        team_id: null,
      }),
      request,
      null,
      { mcpFacade: true },
    );
    expect("error" in actor && actor.status === 403).toBe(true);
    if ("error" in actor) expect(actor.error).toMatch(/membership is disabled/i);
  });

  it("denies a revoked access JTI", async () => {
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
      env(null, null, { jti: { revoked_at: "2026-09-01T00:00:00.000Z" } }),
      request,
      null,
      { mcpFacade: true },
    );
    expect("error" in actor && actor.status === 401).toBe(true);
    if ("error" in actor) expect(actor.error).toMatch(/revoked/i);
  });

  it("still accepts a machine service token on internal gateway routes", async () => {
    const request = new Request("https://app.infrastack.app/api/gateway/v1/execute", {
      headers: { Authorization: "Bearer infra_machine_token" },
    });
    const actor = await resolveGatewayActor(
      env(null, {
        id: "svc_internal",
        company_id: "co_el",
        name: "EL internal worker",
        status: "active",
        identity_type: "other",
        token_hash: "abc",
        scopes_json: "[]",
      }),
      request,
      null,
    );
    expect("type" in actor && actor.type === "service").toBe(true);
  });

  it("denies ChatGPT-typed service identities even if sourceClient is spoofed", async () => {
    const identity: ServiceIdentityRecord = {
      id: "svc_chatgpt",
      companyId: "co_el",
      name: "EL Business ChatGPT",
      description: null,
      identityType: "chatgpt",
      status: "active",
      tokenPrefix: "infra_xxx",
      hasToken: true,
      scopes: [],
      mcpEnvironmentId: null,
      lastUsedAt: null,
      requestCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await executeGatewayRequest(env(null), {
      actor: { type: "service", identity },
      companyId: "co_el",
      toolName: "search",
      sourceClient: "portal",
    });
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/INFRA OAuth/);
  });
});
