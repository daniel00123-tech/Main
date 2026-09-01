import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import {
  issueMcpAccessToken,
  looksLikeJwt,
  isInfraServiceToken,
  oauthAuthorizationServerMetadata,
  revokeHumanOauthGrant,
  verifyMcpAccessToken,
} from "./mcp-oauth";

const SECRET = "test-session-secret-for-mcp-oauth";
const ISSUER = "https://app.infrastack.app";
const AUD = "https://app.infrastack.app/api/gateway/v1/mcp";

describe("INFRA MCP OAuth tokens", () => {
  it("issues a short-lived user-bound JWT without a role claim", async () => {
    const issued = await issueMcpAccessToken(SECRET, ISSUER, AUD, {
      userId: "user_william",
      email: "william@elvexpropertyservices.com",
      companyId: "co_el",
      membershipId: "mem_william",
      clientId: "chatgpt-mcp",
      channel: "chatgpt",
    });
    expect(looksLikeJwt(issued.token)).toBe(true);
    expect(isInfraServiceToken(issued.token)).toBe(false);
    expect(issued.expiresIn).toBe(15 * 60);

    const claims = await verifyMcpAccessToken(issued.token, SECRET, ISSUER);
    expect(claims?.sub).toBe("user_william");
    expect(claims?.company_id).toBe("co_el");
    expect(claims?.membership_id).toBe("mem_william");
    expect(claims?.typ).toBe("mcp_access");
    expect(claims?.channel).toBe("chatgpt");

    const raw = decodeJwt(issued.token);
    expect(raw.role).toBeUndefined();
  });

  it("rejects session-shaped JWTs and wrong signatures", async () => {
    const { SignJWT } = await import("jose");
    const sessionLike = await new SignJWT({
      userId: "user_william",
      email: "william@elvexpropertyservices.com",
      displayName: "William",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_el", role: "director" }],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("12h")
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifyMcpAccessToken(sessionLike, SECRET, ISSUER)).toBeNull();
    const issued = await issueMcpAccessToken(SECRET, ISSUER, AUD, {
      userId: "user_william",
      email: "w@example.com",
      companyId: "co_el",
      membershipId: "mem_1",
      clientId: "chatgpt-mcp",
      channel: "chatgpt",
    });
    expect(await verifyMcpAccessToken(issued.token, "other-secret", ISSUER)).toBeNull();
  });

  it("advertises INFRA as the authorization server, not Microsoft", () => {
    const meta = oauthAuthorizationServerMetadata(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(JSON.stringify(meta)).not.toMatch(/login\.microsoftonline|entra/i);
  });

  it("revokes refresh tokens, access JTIs, and the user ChatGPT connection", async () => {
    const updates: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          run: async () => {
            updates.push(sql.replace(/\s+/g, " ").trim());
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database;

    await revokeHumanOauthGrant(db, "user_william", "co_el");
    expect(updates.some((sql) => sql.includes("oauth_refresh_tokens"))).toBe(true);
    expect(updates.some((sql) => sql.includes("oauth_access_jti"))).toBe(true);
    expect(updates.some((sql) => sql.includes("ai_user_connections"))).toBe(true);
  });
});
