import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  readSessionCookie,
  buildSessionCookie,
} from "./session";

describe("session tokens", () => {
  const secret = "test-session-secret-at-least-32-characters";

  it("creates and verifies a session token", async () => {
    const token = await createSessionToken(
      {
        userId: "user_1",
        email: "admin@example.com",
        displayName: "Admin",
        isPlatformAdmin: true,
        memberships: [],
      },
      secret,
    );

    const user = await verifySessionToken(token, secret);
    expect(user?.email).toBe("admin@example.com");
    expect(user?.isPlatformAdmin).toBe(true);
  });

  it("rejects invalid tokens", async () => {
    const user = await verifySessionToken("invalid.token.value", secret);
    expect(user).toBeNull();
  });

  it("reads session cookie values", () => {
    expect(readSessionCookie("infra_session=abc123; other=value")).toBe("abc123");
    expect(readSessionCookie("other=value")).toBeNull();
  });

  it("builds secure session cookies", () => {
    const cookie = buildSessionCookie("abc123", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });
});
