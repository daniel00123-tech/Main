import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { can } from "../src/rbac/authorize";
import { extractUntrustedRole, resolveActor, resolveMicrosoftOidActor } from "../src/rbac/identity";
import { bindUserMicrosoftOid, updateUserRole, updateUserStatus, upsertCompanyUser } from "../src/rbac/store";
import { issueMcpAccessToken, signHs256Jwt, verifyMcpAccessToken } from "../src/oauth/jwt";
import { clearEntraJwksCache, validateEntraIdToken } from "../src/oauth/entra";
import { toBase64Url } from "../src/oauth/crypto";
import { oauthAuthorizationServerMetadata, oauthProtectedResourceMetadata, openIdConfiguration } from "../src/oauth/metadata";
import { MCP_VERSION } from "../src/constants";
import { createMemoryD1 } from "./helpers/memory-d1";
import { organisationMatchesExpected } from "../src/xero/config";
import { DEFAULT_PROTECTED_USER_HINTS } from "../src/microsoft/config";
import { sha256Base64Url } from "../src/oauth/crypto";
import { COMPANY_KNOWLEDGE_TOOLS, createElBusinessMcpServer } from "../src/mcp-server";

const ELLA_OID = "716e49a7-d69b-48de-8213-2fc1afdab288";
const ELLA_EMAIL = "Ella@elvexpropertyservices.com";
const ORIGIN = "https://el-business-mcp.infrastack.app";
const TENANT = "af32e619-3647-44a2-85d9-1c45457c0e91";
const CLIENT_ID = "f8ec6a91-f043-4f63-8800-64135af48c4e";
const TOKEN_SECRET = "test-mcp-token-secret-not-for-production";

function env(overrides: Partial<Env> = {}): Env {
  return {
    EL_BUSINESS_DATA: createMemoryD1(),
    MCP_AUTH_TOKEN: "shared-service-token",
    EL_ADMIN_TOKEN: "admin-token",
    EL_RBAC_IDENTITY_SECRET: TOKEN_SECRET,
    EL_MCP_TOKEN_SECRET: TOKEN_SECRET,
    EL_MCP_PUBLIC_ORIGIN: ORIGIN,
    EL_MS_TENANT_ID: TENANT,
    EL_MS_CLIENT_ID: CLIENT_ID,
    EL_MS_CLIENT_SECRET: "entra-client-secret",
    EL_MS_OIDC_JWKS_URL: "https://login.microsoftonline.com/test/discovery/v2.0/keys",
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

async function ellaJwt(testEnv: Env) {
  const issued = await issueMcpAccessToken(testEnv, {
    oid: ELLA_OID,
    email: ELLA_EMAIL,
    name: "Ella May",
  });
  if (!issued) throw new Error("failed to issue MCP JWT");
  return issued.accessToken;
}

function expectDenied(actor: Parameters<typeof can>[0], capability: string) {
  const decision = can(actor, capability);
  expect(decision.allowed, `${capability} should be denied`).toBe(false);
}

function expectAllowed(actor: Parameters<typeof can>[0], capability: string) {
  const decision = can(actor, capability);
  expect(decision.allowed, `${capability} should be allowed`).toBe(true);
}

describe("OAuth discovery metadata", () => {
  it("1 advertises ChatGPT-compatible protected-resource and AS metadata", async () => {
    const testEnv = env();
    const protectedResource = oauthProtectedResourceMetadata(testEnv);
    const as = oauthAuthorizationServerMetadata(testEnv);
    const oidc = openIdConfiguration(testEnv);
    expect(protectedResource.resource).toBe(`${ORIGIN}/mcp`);
    expect(protectedResource.authorization_servers).toEqual([ORIGIN]);
    expect(as.issuer).toBe(ORIGIN);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.grant_types_supported).toContain("refresh_token");
    expect(as.scopes_supported).toEqual(expect.arrayContaining(["openid", "offline_access"]));
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(oidc.userinfo_endpoint).toBe(`${ORIGIN}/oauth/userinfo`);

    const response = await fetchWorker(testEnv, new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { issuer: string };
    expect(body.issuer).toBe(ORIGIN);
    expect(MCP_VERSION).toBe("1.4.0");
  });
});

describe("Microsoft login / authorization flow", () => {
  let rsa: CryptoKeyPair;
  let publicJwk: JsonWebKey & { kid?: string };

  beforeEach(async () => {
    clearEntraJwksCache();
    rsa = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ["sign", "verify"]
    );
    publicJwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey & { kid?: string };
    publicJwk.kid = "entra-test-kid";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";
  });

  afterEach(() => {
    clearEntraJwksCache();
  });

  async function signEntra(payload: Record<string, unknown>, kid = "entra-test-kid"): Promise<string> {
    const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const body = toBase64Url(JSON.stringify(payload));
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(`${header}.${body}`))
    );
    return `${header}.${body}.${toBase64Url(sig)}`;
  }

  function mockEntraFetch(idToken: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/discovery/v2.0/keys")) {
        return new Response(JSON.stringify({ keys: [publicJwk] }));
      }
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }));
      }
      return original(input as Request, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("2-3 Microsoft authorization code + PKCE issues an MCP JWT for the Entra oid", async () => {
    const testEnv = env();
    const now = Math.floor(Date.now() / 1000);
    const idToken = await signEntra({
      iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      tid: TENANT,
      aud: CLIENT_ID,
      oid: ELLA_OID,
      email: ELLA_EMAIL,
      name: "Ella May",
      iat: now,
      nbf: now,
      exp: now + 3600,
    });
    const restore = mockEntraFetch(idToken);
    try {
      const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz012345";
      const challenge = await sha256Base64Url(verifier);
      const register = await fetchWorker(
        testEnv,
        new Request(`${ORIGIN}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "external-mcp-client",
            redirect_uris: ["http://localhost:9/callback"],
            token_endpoint_auth_method: "none",
          }),
        })
      );
      expect(register.status).toBe(201);
      const client = (await register.json()) as { client_id: string };
      const authorize = await fetchWorker(
        testEnv,
        new Request(
          `${ORIGIN}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("http://localhost:9/callback")}&state=client-state&code_challenge=${challenge}&code_challenge_method=S256&scope=openid%20offline_access&resource=${encodeURIComponent(`${ORIGIN}/mcp`)}`
        )
      );
      expect(authorize.status).toBe(302);
      const entraLocation = new URL(authorize.headers.get("Location") ?? "");
      expect(entraLocation.hostname).toBe("login.microsoftonline.com");
      expect(entraLocation.pathname).toContain(`/${TENANT}/oauth2/v2.0/authorize`);
      expect(entraLocation.searchParams.get("scope")).toContain("offline_access");
      const entraState = entraLocation.searchParams.get("state");
      expect(entraState).toBeTruthy();

      const callback = await fetchWorker(
        testEnv,
        new Request(`${ORIGIN}/oauth/microsoft/callback?code=entra-code&state=${entraState}`)
      );
      expect(callback.status).toBe(302);
      const clientRedirect = new URL(callback.headers.get("Location") ?? "");
      expect(clientRedirect.origin).toBe("http://localhost:9");
      expect(clientRedirect.searchParams.get("iss")).toBe(ORIGIN);
      expect(clientRedirect.searchParams.get("state")).toBe("client-state");
      const code = clientRedirect.searchParams.get("code");
      expect(code).toBeTruthy();

      const token = await fetchWorker(
        testEnv,
        new Request(`${ORIGIN}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code!,
            client_id: client.client_id,
            redirect_uri: "http://localhost:9/callback",
            code_verifier: verifier,
            resource: `${ORIGIN}/mcp`,
          }),
        })
      );
      expect(token.status).toBe(200);
      const issued = (await token.json()) as { access_token: string; refresh_token: string };
      expect(issued.refresh_token).toBeTruthy();
      const claims = await verifyMcpAccessToken(testEnv, issued.access_token);
      expect(claims?.oid).toBe(ELLA_OID);
      expect(claims?.iss).toBe(ORIGIN);
      expect(claims?.aud).toBe(`${ORIGIN}/mcp`);

      const userinfo = await fetchWorker(
        testEnv,
        new Request(`${ORIGIN}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${issued.access_token}` },
        })
      );
      expect(userinfo.status).toBe(200);
      expect(((await userinfo.json()) as { oid: string }).oid).toBe(ELLA_OID);
    } finally {
      restore();
    }
  });

  it("4-5 wrong tenant, forged, expired, and alg=none tokens are denied", async () => {
    const testEnv = env();
    const now = Math.floor(Date.now() / 1000);
    const restore = mockEntraFetch("unused");
    try {
      const wrongTenant = await signEntra({
        iss: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
        tid: "00000000-0000-0000-0000-000000000000",
        aud: CLIENT_ID,
        oid: ELLA_OID,
        exp: now + 3600,
        iat: now,
        nbf: now,
      });
      expect(await validateEntraIdToken(testEnv, wrongTenant)).toBeNull();

      const wrongAud = await signEntra({
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        tid: TENANT,
        aud: "other-app",
        oid: ELLA_OID,
        exp: now + 3600,
        iat: now,
        nbf: now,
      });
      expect(await validateEntraIdToken(testEnv, wrongAud)).toBeNull();

      const expired = await signEntra({
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        tid: TENANT,
        aud: CLIENT_ID,
        oid: ELLA_OID,
        exp: now - 120,
        iat: now - 200,
        nbf: now - 200,
      });
      expect(await validateEntraIdToken(testEnv, expired)).toBeNull();

      const missingOid = await signEntra({
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        tid: TENANT,
        aud: CLIENT_ID,
        email: ELLA_EMAIL,
        exp: now + 3600,
        iat: now,
        nbf: now,
      });
      expect(await validateEntraIdToken(testEnv, missingOid)).toBeNull();

      const noneTok = `${toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${toBase64Url(
        JSON.stringify({
          iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          tid: TENANT,
          aud: CLIENT_ID,
          oid: ELLA_OID,
          exp: now + 3600,
        })
      )}.`;
      expect(await validateEntraIdToken(testEnv, noneTok)).toBeNull();

      const forged = await signHs256Jwt("wrong-secret", {
        typ: "mcp_access",
        iss: ORIGIN,
        aud: `${ORIGIN}/mcp`,
        oid: ELLA_OID,
        sub: ELLA_OID,
        exp: now + 3600,
        iat: now,
        nbf: now,
      });
      expect(await verifyMcpAccessToken(testEnv, forged)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Ella May identity binding", () => {
  it("6-7 unknown / unprovisioned Microsoft user is authenticated but denied ALL business tools", async () => {
    const testEnv = env();
    const token = await ellaJwt(testEnv);
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identitySource).toBe("microsoft_oidc");
    expect(actor.identityBound).toBe(false);
    expect(actor.microsoftOid).toBe(ELLA_OID);
    for (const capability of [
      "knowledge.company.read",
      "knowledge.engineer.read",
      "mail.info.read",
      "mail.info.write",
      "mail.finance.read",
      "xero.sales.read",
      "knowledge.restricted.read",
      "admin.portal.access",
      "admin.roles.manage",
      "payment.info.access",
    ]) {
      expectDenied(actor, capability);
    }
  });

  it("8-15 provision Ella as office_staff: allow general/info, deny finance/Xero/admin", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
      microsoftOid: ELLA_OID,
    });
    expect(user.microsoftOid).toBe(ELLA_OID);
    const token = await ellaJwt(testEnv);
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(true);
    expect(actor.role).toBe("office_staff");
    expectAllowed(actor, "knowledge.company.read");
    expectAllowed(actor, "knowledge.engineer.read");
    expectAllowed(actor, "mail.info.read");
    expectAllowed(actor, "mail.info.write");
    expectDenied(actor, "mail.finance.read");
    expectDenied(actor, "mail.finance.write");
    expectDenied(actor, "xero.sales.read");
    expectDenied(actor, "xero.finance.read");
    expectDenied(actor, "xero.draft.write");
    expectDenied(actor, "knowledge.restricted.read");
    expectDenied(actor, "admin.portal.access");
    expectDenied(actor, "admin.roles.manage");
    expectDenied(actor, "payment.info.access");
  });

  it("16-17 same Microsoft identity picks up finance_team after INFRA role change", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
      microsoftOid: ELLA_OID,
    });
    const token = await ellaJwt(testEnv);
    await updateUserRole(testEnv.EL_BUSINESS_DATA, user.id, "finance_team");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.role).toBe("finance_team");
    expectAllowed(actor, "mail.finance.read");
    expectAllowed(actor, "xero.sales.read");
    expectAllowed(actor, "xero.finance.read");
    expectDenied(actor, "xero.draft.write");
    expectDenied(actor, "admin.portal.access");
    expectDenied(actor, "knowledge.restricted.read");
  });

  it("18-19 disable Ella and the same identity is denied ALL", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "finance_team",
      microsoftOid: ELLA_OID,
    });
    const token = await ellaJwt(testEnv);
    await updateUserStatus(testEnv.EL_BUSINESS_DATA, user.id, "disabled");
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(actor.identityBound).toBe(false);
    expectDenied(actor, "knowledge.company.read");
    expectDenied(actor, "mail.info.read");
    expectDenied(actor, "xero.sales.read");
    expectDenied(actor, "admin.portal.access");
  });

  it("20 user-supplied role cannot override the D1 role", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
      microsoftOid: ELLA_OID,
    });
    const token = await ellaJwt(testEnv);
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
  it("27 unauthenticated tool calls fail closed with an OAuth challenge", async () => {
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

  it("28 shared service token cannot impersonate a human admin", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: "admin@elvexpropertyservices.com",
      role: "company_admin",
      microsoftOid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const actor = await resolveActor(
      testEnv,
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: "Bearer shared-service-token" } })
    );
    expect(actor.identitySource).toBe("service_token");
    expect(actor.identityBound).toBe(false);
    expect(actor.role).toBeNull();
    expectDenied(actor, "admin.roles.manage");
    expectDenied(actor, "admin.portal.access");
    expectDenied(actor, "xero.finance.read");
  });

  it("email alone cannot authorize an unknown oid", async () => {
    const testEnv = env();
    await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "company_admin",
    });
    const actor = await resolveMicrosoftOidActor(testEnv, ELLA_OID, { email: ELLA_EMAIL });
    expect(actor.identityBound).toBe(false);
    expectDenied(actor, "admin.roles.manage");
  });

  it("bind API attaches the Entra oid without trusting email", async () => {
    const testEnv = env();
    const user = await upsertCompanyUser(testEnv.EL_BUSINESS_DATA, {
      email: ELLA_EMAIL,
      displayName: "Ella May",
      role: "office_staff",
    });
    const bound = await bindUserMicrosoftOid(testEnv.EL_BUSINESS_DATA, user.id, ELLA_OID);
    expect(bound?.microsoftOid).toBe(ELLA_OID);
    const actor = await resolveMicrosoftOidActor(testEnv, ELLA_OID);
    expect(actor.identityBound).toBe(true);
    expect(actor.role).toBe("office_staff");
  });
});

describe("Company Knowledge and MCP tools", () => {
  it("25-26 search/fetch company-knowledge tools remain registered and discoverable", async () => {
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
    const server = createElBusinessMcpServer(env());
    expect(server).toBeTruthy();
    expect(COMPANY_KNOWLEDGE_TOOLS).toEqual(
      expect.arrayContaining(["search", "fetch", "search_company_knowledge"])
    );
    expect(MCP_VERSION).toBe("1.4.0");
    expect(DEFAULT_PROTECTED_USER_HINTS).toEqual(expect.arrayContaining(["William", "Ella"]));
  });

  it("23 Xero remains locked to Elvex Property Services Ltd", () => {
    expect(organisationMatchesExpected("Elvex Property Services Ltd", "Elvex Property Services Ltd")).toBe(true);
    expect(organisationMatchesExpected("Caddington Holdings Ltd", "Elvex Property Services Ltd")).toBe(false);
  });
});
