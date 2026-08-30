import { describe, expect, it } from "vitest";
import { safeOauthContinueUrl } from "./oauth-continue";

describe("safeOauthContinueUrl", () => {
  it("allows INFRA authorize URLs only", () => {
    expect(safeOauthContinueUrl("/oauth/authorize?client_id=chatgpt-mcp")).toBe(
      "/oauth/authorize?client_id=chatgpt-mcp",
    );
    expect(
      safeOauthContinueUrl("https://app.infrastack.app/oauth/authorize?client_id=x"),
    ).toContain("/oauth/authorize");
    expect(safeOauthContinueUrl("https://evil.example/oauth/authorize")).toBeNull();
    expect(safeOauthContinueUrl("https://app.infrastack.app/portal")).toBeNull();
    expect(
      safeOauthContinueUrl(
        "https://infra-api.daniel-dwyer123.workers.dev/oauth/authorize?client_id=chatgpt-mcp",
      ),
    ).toBe("/oauth/authorize?client_id=chatgpt-mcp");
  });
});
