import { describe, expect, it } from "vitest";
import { INFRA_API_ORIGIN } from "@infra/shared";
import { resolveApiBase } from "./config";

describe("web API base config", () => {
  it("uses the canonical API origin for production when VITE_API_BASE is missing", () => {
    expect(resolveApiBase({ PROD: true })).toBe(INFRA_API_ORIGIN);
  });

  it("keeps local dev same-origin unless VITE_API_BASE is configured", () => {
    expect(resolveApiBase({ PROD: false })).toBe("");
    expect(resolveApiBase({ PROD: true, VITE_API_BASE: "https://api.example.com/" })).toBe("https://api.example.com");
  });
});
