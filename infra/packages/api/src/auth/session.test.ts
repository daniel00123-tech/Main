import { describe, expect, it } from "vitest";
import { requestCountsAsUserActivity } from "./middleware";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  credentialsVersionFromHash,
  evaluateSessionTiming,
  sessionPublicMeta,
  shouldTouchSession,
  verifySessionToken,
} from "./session";

const user = {
  userId: "user_1",
  email: "ada@example.com",
  displayName: "Ada",
  isPlatformAdmin: false,
  memberships: [{ companyId: "co_1", role: "company_admin" as const }],
};

describe("session cookies", () => {
  it("uses SameSite=Lax and portal domain for first-party sessions", () => {
    const cookie = buildSessionCookie("token123", true, false, ".infra-web.pages.dev");
    expect(cookie).toContain("infra_session=token123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Domain=.infra-web.pages.dev");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${SESSION_IDLE_SECONDS}`);
  });

  it("uses SameSite=None for legacy cross-origin mode", () => {
    const cookie = buildSessionCookie("token123", true, true);
    expect(cookie).toContain("SameSite=None");
    expect(cookie).not.toContain("Domain=");
  });

  it("clears cookies with matching attributes", () => {
    const cookie = buildClearSessionCookie(true, false, ".infra-web.pages.dev");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Domain=.infra-web.pages.dev");
  });
});

describe("credentialsVersionFromHash", () => {
  it("returns a stable fingerprint prefix", () => {
    expect(credentialsVersionFromHash("abcdef0123456789")).toBe("abcdef0123456789".slice(0, 16));
  });
});

describe("evaluateSessionTiming", () => {
  const now = 1_700_000_000;

  it("accepts a fresh session and treats missing lastActivity as iat", () => {
    const result = evaluateSessionTiming({ iat: now - 60 }, now);
    expect(result).toEqual({ ok: true, authTime: now - 60, lastActivity: now - 60 });
  });

  it("rejects idle sessions after 30 minutes", () => {
    const result = evaluateSessionTiming(
      { authTime: now - 3600, lastActivity: now - SESSION_IDLE_SECONDS - 1 },
      now,
    );
    expect(result).toEqual({ ok: false, reason: "idle" });
  });

  it("rejects sessions older than the 12-hour absolute cap", () => {
    const result = evaluateSessionTiming(
      { authTime: now - SESSION_ABSOLUTE_SECONDS - 1, lastActivity: now },
      now,
    );
    expect(result).toEqual({ ok: false, reason: "absolute" });
  });
});

describe("session tokens", () => {
  const secret = "test-session-secret-at-least-32-characters";

  it("round-trips a valid token", async () => {
    const token = await createSessionToken(user, secret, { now: 1_700_000_000 });
    const verified = await verifySessionToken(token, secret, 1_700_000_010);
    expect(verified?.user.email).toBe("ada@example.com");
    expect(verified?.authTime).toBe(1_700_000_000);
    expect(verified?.lastActivity).toBe(1_700_000_000);
  });

  it("rejects a token whose last activity is older than the idle window", async () => {
    const now = 1_700_000_000;
    const token = await createSessionToken(user, secret, {
      now,
      authTime: now,
      lastActivity: now,
    });
    const verified = await verifySessionToken(
      token,
      secret,
      now + SESSION_IDLE_SECONDS + 5,
    );
    expect(verified).toBeNull();
  });

  it("keeps an active user inside the idle window", async () => {
    const now = 1_700_000_000;
    const token = await createSessionToken(user, secret, {
      now,
      authTime: now,
      lastActivity: now,
    });
    const verified = await verifySessionToken(token, secret, now + SESSION_IDLE_SECONDS - 5);
    expect(verified?.user.userId).toBe("user_1");
  });
});

describe("session helpers", () => {
  it("exposes idle and absolute policy in public metadata", () => {
    const authTime = 1_700_000_000;
    const meta = sessionPublicMeta({ authTime, lastActivity: authTime });
    expect(meta.idleTimeoutSeconds).toBe(30 * 60);
    expect(meta.absoluteTimeoutSeconds).toBe(12 * 60 * 60);
    expect(Date.parse(meta.expiresAt)).toBe((authTime + 12 * 60 * 60) * 1000);
    expect(Date.parse(meta.idleExpiresAt)).toBe((authTime + 30 * 60) * 1000);
  });

  it("throttles cookie rewrites", () => {
    expect(shouldTouchSession(100, 150)).toBe(false);
    expect(shouldTouchSession(100, 160)).toBe(true);
  });

  it("treats only explicit user activity as idle-sliding", () => {
    expect(requestCountsAsUserActivity("/api/companies/acme/actions", undefined)).toBe(false);
    expect(requestCountsAsUserActivity("/api/companies/acme/actions", "1")).toBe(true);
    expect(requestCountsAsUserActivity("/api/auth/me", undefined)).toBe(true);
    expect(requestCountsAsUserActivity("/api/auth/activity", undefined)).toBe(true);
  });
});
