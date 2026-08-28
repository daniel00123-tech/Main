import { describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./env";

describe("isOriginAllowed", () => {
  const allowed = parseAllowedOrigins("https://infra-web.pages.dev,http://localhost:5173");

  it("allows configured origins", () => {
    expect(isOriginAllowed("https://infra-web.pages.dev", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
  });

  it("allows company portal subdomains on infra-web.pages.dev", () => {
    expect(isOriginAllowed("https://caddington.infra-web.pages.dev", allowed)).toBe(true);
  });

  it("rejects unrelated origins", () => {
    expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
  });
});
