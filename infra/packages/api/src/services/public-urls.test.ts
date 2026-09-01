import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  infraBrowserPublicBase,
  oauthAuthorizeContinueUrl,
  oauthLoginRedirectUrl,
} from "./public-urls";

const env = {
  INFRA_PUBLIC_API_URL: "https://infra-api.daniel-dwyer123.workers.dev",
} as Env;

describe("oauth login continue URL", () => {
  it("stays on the portal when Pages proxies authorize to the worker", () => {
    const request = new Request(
      "https://infra-api.daniel-dwyer123.workers.dev/oauth/authorize?response_type=code&client_id=chatgpt-mcp&company=el-business",
      {
        headers: {
          "X-Forwarded-Host": "app.infrastack.app",
          "X-Forwarded-Proto": "https",
        },
      },
    );

    expect(infraBrowserPublicBase(env, request.url, request)).toBe("https://app.infrastack.app");
    expect(oauthAuthorizeContinueUrl(env, request)).toBe(
      "https://app.infrastack.app/oauth/authorize?response_type=code&client_id=chatgpt-mcp&company=el-business",
    );

    const login = new URL(oauthLoginRedirectUrl(env, request));
    expect(login.origin).toBe("https://app.infrastack.app");
    expect(login.pathname).toBe("/portal/login");
    expect(login.searchParams.get("next")).toBe(
      "https://app.infrastack.app/oauth/authorize?response_type=code&client_id=chatgpt-mcp&company=el-business",
    );
  });
});
