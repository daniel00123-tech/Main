import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { EL_GRAPH_APP_ID, EL_GRAPH_TENANT_ID, verifyElMicrosoftServicePrincipal } from "./el-microsoft-sp-verify";

describe("EL Microsoft service principal verify", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("reports AADSTS7000229 as missing SP without printing a secret", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("openid-configuration")) {
        return {
          ok: true,
          json: async () => ({ issuer: `https://login.microsoftonline.com/${EL_GRAPH_TENANT_ID}/v2.0` }),
        };
      }
      return {
        ok: false,
        status: 401,
        json: async () => ({
          error: "unauthorized_client",
          error_description: `AADSTS7000229: The client application ${EL_GRAPH_APP_ID} is missing service principal in the tenant ${EL_GRAPH_TENANT_ID}`,
        }),
      };
    });

    const result = await verifyElMicrosoftServicePrincipal({
      MICROSOFT_CLIENT_ID: EL_GRAPH_APP_ID,
      MICROSOFT_CLIENT_SECRET: "not-a-real-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
      MICROSOFT_MULTITENANT_APP: "true",
    } as never);

    expect(result.tokenMintSucceeded).toBe(false);
    expect((result.servicePrincipal as { exists: string }).exists).toBe("NO");
    expect(String(result.blocker)).toContain("AADSTS7000229");
    expect(JSON.stringify(result)).not.toContain("not-a-real-secret");
    expect((result.bindingAudit as { clientIdMatchesExpected: boolean }).clientIdMatchesExpected).toBe(true);
    expect((result.bindingAudit as { homeTenantIsElTenant: boolean }).homeTenantIsElTenant).toBe(false);
  });

  it("queries the tenant SP directory when token mint succeeds", async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes("openid-configuration")) {
        return {
          ok: true,
          json: async () => ({ issuer: `https://login.microsoftonline.com/${EL_GRAPH_TENANT_ID}/v2.0` }),
        };
      }
      if (String(url).includes("/oauth2/v2.0/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "token", expires_in: 3600 }) };
      }
      if (String(url).includes("/servicePrincipals")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: "sp-el-1",
                appId: EL_GRAPH_APP_ID,
                displayName: "INFRA",
                accountEnabled: true,
                appOwnerOrganizationId: "home-tenant",
              },
            ],
          }),
        };
      }
      if (String(url).includes("/organization")) {
        return { ok: true, status: 200, json: async () => ({ value: [{ id: EL_GRAPH_TENANT_ID, displayName: "EL" }] }) };
      }
      if (String(url).includes("/applications")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: [{ id: "app-1", appId: EL_GRAPH_APP_ID, signInAudience: "AzureADMultipleOrgs" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const result = await verifyElMicrosoftServicePrincipal({
      MICROSOFT_CLIENT_ID: EL_GRAPH_APP_ID,
      MICROSOFT_CLIENT_SECRET: "not-a-real-secret",
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    } as never);

    expect(result.tokenMintSucceeded).toBe(true);
    expect(result.servicePrincipal).toMatchObject({
      exists: "YES",
      objectId: "sp-el-1",
      accountEnabled: true,
      appId: EL_GRAPH_APP_ID,
      tenantId: EL_GRAPH_TENANT_ID,
    });
    expect(JSON.stringify(result)).not.toContain("not-a-real-secret");
    expect(initCallsIncludePost(fetchMock)).toBe(true);
  });
});

function initCallsIncludePost(fn: ReturnType<typeof vi.fn>): boolean {
  return fn.mock.calls.some((call) => {
    const init = call[1] as { method?: string } | undefined;
    return init?.method === "POST";
  });
}
