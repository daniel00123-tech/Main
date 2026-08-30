import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { can } from "../src/rbac/authorize";
import { extractUntrustedRole, resolveActor, resolveMicrosoftOidActor } from "../src/rbac/identity";
import { bindUserMicrosoftOid, updateUserRole, updateUserStatus, upsertCompanyUser } from "../src/rbac/store";
import { issueMcpAccessToken, signHs256Jwt, verifyMcpAccessToken } from "../src/oauth/jwt";
import { oauthAuthorizationServerMetadata, oauthProtectedResourceMetadata, openIdConfiguration } from "../src/oauth/metadata";
import { MCP_VERSION } from "../src/constants";
import { createMemoryD1 } from "./helpers/memory-d1";
import { organisationMatchesExpected } from "../src/xero/config";
import { DEFAULT_PROTECTED_USER_HINTS } from "../src/microsoft/config";
import { COMPANY_KNOWLEDGE_TOOLS, createElBusinessMcpServer } from "../src/mcp-server";

const ELLA_ID = "user_ella";
const ELLA_EMAIL = "Ella@elvexpropertyservices.com";
const ELLA_OID = "716e49a7-d69b-48de-8213-2fc1afdab288";
const ORIGIN = "https://el-business-mcp.infrastack.app";
const INFRA = "https://infra-api.example.test";
const TOKEN_SECRET = "test-mcp-token-secret-not-for-production";

function env(overrides: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: createMemoryD1(),
    MCP_AUTH_TOKEN: "shared-service-token",
    EL_ADMIN_TOKEN: "admin-token",
    EL_RBAC_IDENTITY_SECRET: TOKEN_SECRET,
    EL_MCP_TOKEN_SECRET: TOKEN_SECRET,
    EL_MCP_PUBLIC_ORIGIN: ORIGIN,
    EL_XERO_EXPECTED_ORG: "Elvex Property Services Ltd",
    ...overrides,
  };
}

const exec = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function fetchWorker(testEnv: Env, request: Request): Promise<Response> {
  return worker.fetch(request, testEnv, exec);
}

async function infraJwt(
  testEnv: Env,
  input: { userId: string; companyId?: string; companySlug?: string; client?: string; email?: string; name?: string }
) {
  const issued = await issueMcpAccessToken(testEnv, {
    userId: input.userId,
    companyId: input.companyId ?? "co_el",
    companySlug: input.companySlug ?? "el-business",
    client: input.client ?? "chatgpt",
    email: input.email,
    name: input.name,
  });
  if (!issued) throw new Error("failed to issue INFRA MCP JWT");
  return issued.accessToken;
}

function expectDenied(actor: Parameters<typeof can>[0], capability: string) {
  expect(can(actor, capability).allowed, `${capability} should be denied`).toBe(false);
}

function expectAllowed(actor: Parameters<typeof can>[0], capability: string) {
  expect(can(actor, capability).allowed, `${capability} should be allowed`).toBe(true);
}

describe("OAuth discovery metadata", () => {
  it("advertises INFRA as the human OAuth authority when configured", async () => {
    const testEnv = env({ INFRA_PUBLIC_API_URL: INFRA });
    const protectedResource = oauthProtectedResourceMetadata(testEnv);
    const as = oauthAuthorizationServerMetadata(testEnv);
    const oidc = openIdConfiguration(testEnv);
    expect(protectedResource.resource).toBe(`${ORIGIN}/mcp`);
    expect(protectedResource.authorization_servers).toEqual([INFRA, ORIGIN]);
    expect(as.issuer).toBe(INFRA);
    expect(as.authorization_endpoint).toBe(`${INFRA}/oauth/mcp/authorize`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.service_documentation).toMatch(/INFRA company account/);
    expect(oidc.claims_supported).toEqual(expect.arrayContaining(["sub", "company_id", "company_slug", "client"]));
    expect(MCP_VERSION).toBe("1.5.0");
  });

  it("authorize redirects to INFRA, not Microsoft", async () => {
    const testEnv = env({ INFRA_PUBLIC_API_URL: INFRA });
    const response = await fetchWorker(
      testEnv,
      new Request(
        `${ORIGIN}/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=${encodeURIComponent("http://localhost:9/callback")}&state=s&code_challenge=abc&code_challenge_method=S256`
      )
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe(INFRA);
    expect(location.pathname).toBe("/oauth/mcp/authorize");
    expect(location.searchParams.get("company")).toBe("el-business");
    expect(location.searchParams.get("client")).toBe("chatgpt");
    expect(location.hostname).not.toBe("login.microsoftonline.com");
  });
});

describe("INFRA MCP token verification", () => {
  it("rejects forged, expired, role-bearing, and alg=none tokens", async () => {
    const testEnv = env();
    const now = Math.floor(Date.now() / 1000);
    const forged = await signHs256Jwt("wrong-secret", {
      typ: "infra_mcp_access",
      iss: ORIGIN,
      aud: `${ORIGIN}/mcp`,
      sub: ELLA_ID,
      company_id: "co_el",
      company_slug: "el-business",
      client: "chatgpt",
      exp: now + 3600,
      iat: now,
      nbf: now,
    });
    expect(await verifyMcpAccessToken(testEnv, forged)).toBeNull();

    const expired = await signHs256Jwt(TOKEN_SECRET, {
      typ: "infra_mcp_access",
      iss: ORIGIN,
      aud: `${ORIGIN}/mcp`,
      sub: ELLA_ID,
      company_id: "co_el",
      company_slug: "el-business",
      client: "chatgpt",
      exp: now - 120,
      iat: now - 200,
      nbf: now - 200,
    });
    expect(await verifyMcpAccessToken(testEnv, expired)).toBeNull();

    const withRole = await signHs256Jwt(TOKEN_SECRET, {
      typ: "infra_mcp_access",
      iss: ORIGIN,
      aud: `${ORIGIN}/mcp`,
      sub: ELLA_ID,
      company_id: "co_el",
      company_slug: "el-business",
      client: "chatgpt",
      role: "company_admin",
      exp: now + 3600,
      iat: now,
      nbf: now,
    });
    expect(await verifyMcpAccessToken(testEnv, withRole)).toBeNull();

    const noneTok = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({
        typ: "infra_mcp_access",
        iss: ORIGIN,
        aud: `${ORIGIN}/mcp`,
        sub: ELLA_ID,
        company_id: "co_el",
        company_slug: "el-business",
        exp: now + 3600,
      })
    ).toString("base64url")}.`;
    expect(await verifyMcpAccessToken(testEnv, noneTok)).toBeNull();
  });
});

describe("INFRA human identity binding", () => {
  it("unknown / unprovisioned INFRA user is authenticated but denied ALL business tools", async () => {
    const testEnv = env();
    const token = await infraJwt(testEnv, { userId: ELLA_ID, email: ELLA_EMAIL, name: "Ella May" });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identitySource).toBe("infra_oauth");
    expect(actor.identityBound).toBe(false);
    for (const capability of [
      "knowledge.company.read",
      "mail.info.read",
      "xero.sales.read",
      "admin.portal.access",
    ]) {
      expectDenied(actor, capability);
    }
  });

  it("company isolation: another INFRA company token cannot use EL Business MCP", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "company_admin",
    });
    const token = await infraJwt(testEnv, {
      userId: ELLA_ID,
      companyId: "co_ht",
      companySlug: "ht-business",
    });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(false);
    expectDenied(actor, "knowledge.company.read");
  });

  it("provisioned office_staff allows general/info and denies finance/Xero/admin", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
    });
    const token = await infraJwt(testEnv, { userId: ELLA_ID, email: ELLA_EMAIL });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(true);
    expect(actor.identitySource).toBe("infra_oauth");
    expect(actor.role).toBe("office_staff");
    expectAllowed(actor, "knowledge.company.read");
    expectAllowed(actor, "mail.info.read");
    expectAllowed(actor, "mail.info.write");
    expectDenied(actor, "mail.finance.read");
    expectDenied(actor, "xero.sales.read");
    expectDenied(actor, "admin.portal.access");
  });

  it("same INFRA token picks up a role change without reconnecting", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
    });
    const token = await infraJwt(testEnv, { userId: ELLA_ID });
    await updateUserRole(testEnv.EL_BUSINESS_DATA, user.id, "finance_team");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.role).toBe("finance_team");
    expectAllowed(actor, "mail.finance.read");
    expectAllowed(actor, "xero.sales.read");
    expectDenied(actor, "xero.draft.write");
  });

  it("disabling the INFRA user immediately denies subsequent calls", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      role: "finance_team",
    });
    const token = await infraJwt(testEnv, { userId: ELLA_ID });
    await updateUserStatus(testEnv.EL_BUSINESS_DATA, user.id, "disabled");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(false);
    expectDenied(actor, "knowledge.company.read");
  });

  it("user-supplied role cannot override the live INFRA/D1 role", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      role: "office_staff",
    });
    const token = await infraJwt(testEnv, { userId: ELLA_ID });
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "company_admin", method: "tools/call" }),
    });
    expect(extractUntrustedRole({ role: "company_admin" })).toBe("company_admin");
    const actor = await resolveActor(testEnv, request);
    expect(actor.role).toBe("office_staff");
    expectDenied(actor, "admin.roles.manage");
  });
});

describe("auth fail-closed and service token isolation", () => {
  it("unauthenticated tool calls fail closed with an OAuth challenge", async () => {
    const testEnv = env();
    const response = await fetchWorker(
      testEnv,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system_health" } }),
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
  });

  it("shared service token cannot impersonate a human employee", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      role: "company_admin",
    });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: "Bearer shared-service-token" } })
    );
    expect(actor.identitySource).toBe("service_token");
    expect(actor.identityBound).toBe(false);
    expectDenied(actor, "admin.roles.manage");
    expectDenied(actor, "knowledge.company.read");
  });

  it("microsoft_oid remains optional and is not required for human MCP access", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      externalId: ELLA_ID,
      email: ELLA_EMAIL,
      role: "office_staff",
    });
    const token = await infraJwt(testEnv, { userId: ELLA_ID });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(true);
    expect(actor.microsoftOid ?? null).toBeNull();
  });

  it("legacy microsoft_oid helper still works for Graph binding only", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
    });
    await bindUserMicrosoftOid(testEnv.EL_BUSINESS_DATA, user.id, ELLA_OID);
    const actor = await resolveMicrosoftOidActor(testEnv, ELLA_OID);
    expect(actor.identityBound).toBe(true);
    expect(actor.role).toBe("office_staff");
  });
});

describe("Company Knowledge and MCP tools", () => {
  it("search/fetch company-knowledge tools remain registered", async () => {
    const testEnv = env();
    const listed = await fetchWorker(
      testEnv,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(listed.status).toBeLessThan(500);
    expect(createElBusinessMcpServer(testEnv)).toBeTruthy();
    expect(COMPANY_KNOWLEDGE_TOOLS).toEqual(
      expect.arrayContaining(["search", "fetch", "search_company_knowledge"])
    );
    expect(MCP_VERSION).toBe("1.5.0");
    expect(DEFAULT_PROTECTED_USER_HINTS).toEqual(expect.arrayContaining(["William", "Ella"]));
  });

  it("Xero remains locked to Elvex Property Services Ltd", () => {
    expect(organisationMatchesExpected("Elvex Property Services Ltd", "Elvex Property Services Ltd")).toBe(true);
    expect(organisationMatchesExpected("Caddington Holdings Ltd", "Elvex Property Services Ltd")).toBe(false);
  });
});
