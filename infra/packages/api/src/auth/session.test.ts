import { describe, expect, it } from "vitest";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  credentialsVersionFromHash,
} from "./session";

describe("session cookies", () => {
  it("uses SameSite=Lax and portal domain for first-party sessions", () => {
    const cookie = buildSessionCookie("token123", true, false, ".infra-web.pages.dev");
    expect(cookie).toContain("infra_session=token123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Domain=.infra-web.pages.dev");
    expect(cookie).toContain("Secure");
  });

  it("omits Domain for host-only app.infrastack.app cookies", () => {
    const cookie = buildSessionCookie("token123", true, false, null);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
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
