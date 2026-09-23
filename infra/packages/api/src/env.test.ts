import { describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./env";

describe("isOriginAllowed", () => {
  const allowed = parseAllowedOrigins(
    "https://app.infrastack.app,https://infrastack.app,https://infra-web.pages.dev,http://localhost:5173",
  );

  it("allows configured production origins", () => {
    expect(isOriginAllowed("https://app.infrastack.app", allowed)).toBe(true);
    expect(isOriginAllowed("https://infrastack.app", allowed)).toBe(true);
    expect(isOriginAllowed("https://infra-web.pages.dev", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
  });

  it("allows company portal subdomains on infra-web.pages.dev", () => {
    expect(isOriginAllowed("https://caddington.infra-web.pages.dev", allowed)).toBe(true);
  });

  it("rejects unlisted infrastack.app hosts and unrelated origins", () => {
    expect(isOriginAllowed("https://evil.infrastack.app", allowed)).toBe(false);
    expect(isOriginAllowed("https://api.infrastack.app", allowed)).toBe(false);
    expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isOriginAllowed("*", allowed)).toBe(false);
  });
});
