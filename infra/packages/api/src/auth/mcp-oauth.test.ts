import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import {
  issueMcpAccessToken,
  looksLikeJwt,
  isInfraServiceToken,
  mcpOauthWwwAuthenticate,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  oauthProtectedResourceMetadataUrl,
  openidConfiguration,
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
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.code_challenge_methods_supported).not.toContain("plain");
    expect(meta.resource_indicators_supported).toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/login\.microsoftonline|entra/i);
    expect(openidConfiguration(ISSUER).issuer).toBe(ISSUER);
  });

  it("advertises RFC 9728 protected resource metadata for the gateway MCP URL", () => {
    const prm = oauthProtectedResourceMetadata(ISSUER, AUD);
    expect(prm.resource).toBe(AUD);
    expect(prm.authorization_servers).toEqual([ISSUER]);
    expect(prm.scopes_supported).toContain("mcp");
    expect(oauthProtectedResourceMetadataUrl(ISSUER, AUD)).toBe(
      `${ISSUER}/.well-known/oauth-protected-resource/api/gateway/v1/mcp`,
    );
  });

  it("issues a ChatGPT-compatible 401 challenge without a service-token hint", () => {
    const header = mcpOauthWwwAuthenticate(ISSUER, AUD);
    expect(header).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/gateway/v1/mcp"`);
    expect(header).toContain('scope="mcp"');
    expect(header).not.toMatch(/invalid_token|service token/i);
  });
});
