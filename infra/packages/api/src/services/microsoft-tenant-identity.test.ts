import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { resolveMicrosoftAppCredentials } from "./microsoft-credentials";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";
import {
  EL_NATIVE_MICROSOFT_CLIENT_ID,
  EL_NATIVE_MICROSOFT_TENANT_ID,
  SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID,
  auditMicrosoftBindingNames,
} from "./microsoft-tenant-identity";
import { EL_OPTION_B_CUTOVER_SUBJECT } from "./el-option-b-cutover";

function memoryDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

const platformEnv = {
  MICROSOFT_TENANT_ID: "b81e5570-65f5-4583-87f0-1b383d0c4ca2",
  MICROSOFT_CLIENT_ID: SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: "shared-platform-secret",
  MICROSOFT_MULTITENANT_APP: "false",
  DB: memoryDb(),
} as unknown as Env;

describe("Option B tenant-native Microsoft identity", () => {
  it("audits binding names without exposing secrets", () => {
    const audit = auditMicrosoftBindingNames({
      ...platformEnv,
      EL_MS_TENANT_ID: EL_NATIVE_MICROSOFT_TENANT_ID,
      EL_MS_CLIENT_ID: EL_NATIVE_MICROSOFT_CLIENT_ID,
      EL_MS_CLIENT_SECRET: "el-secret-must-not-appear",
    } as Env);
    expect(audit.globalClientBinding).toBe("MICROSOFT_CLIENT_ID");
    expect(audit.globalSecretBinding).toBe("MICROSOFT_CLIENT_SECRET");
    expect(audit.elTenantBinding).toBe("EL_MS_TENANT_ID");
    expect(audit.elClientBinding).toBe("EL_MS_CLIENT_ID");
    expect(audit.elSecretBinding).toBe("EL_MS_CLIENT_SECRET");
    expect(audit.EL_TENANT_PRESENT).toBe("YES");
    expect(audit.EL_CLIENT_PRESENT).toBe("YES");
    expect(audit.EL_SECRET_PRESENT).toBe("YES");
    expect(audit.elClientId).toBe(EL_NATIVE_MICROSOFT_CLIENT_ID);
    expect(JSON.stringify(audit)).not.toContain("el-secret-must-not-appear");
    expect(JSON.stringify(audit)).not.toContain("shared-platform-secret");
  });

  it("keeps Caddington on the platform identity when no tenant-native row exists", async () => {
    const db = memoryDb();
    const resolved = await resolveMicrosoftAppCredentials(platformEnv, db, {
      companyId: "co_caddington",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("MICROSOFT_NOT_CONNECTED");
  });

  it("refuses to fall back to the shared Business Connector for co_el", async () => {
    const access = await resolveOutlookGraphAccess(platformEnv, {
      companyId: "co_el",
      mailboxAddress: "finance@elvexpropertyservices.com",
    });
    expect(access.ok).toBe(false);
    if (!access.ok) {
      expect(access.code).toBe("MICROSOFT_TENANT_SECRET_MISSING");
      expect(access.clientId).toBe(EL_NATIVE_MICROSOFT_CLIENT_ID);
      expect(access.clientId).not.toBe(SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID);
      expect(access.message).toMatch(/Elvex MCP|EL_MS_CLIENT_SECRET|not used/i);
    }
  });

  it("mints co_el tokens with the native client, not the global secret", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "el-token", expires_in: 3600 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { acquireMicrosoftAppToken, clearMicrosoftTokenCache } = await import("./microsoft-auth");
    clearMicrosoftTokenCache();
    const env = {
      ...platformEnv,
      EL_MS_TENANT_ID: EL_NATIVE_MICROSOFT_TENANT_ID,
      EL_MS_CLIENT_ID: EL_NATIVE_MICROSOFT_CLIENT_ID,
      EL_MS_CLIENT_SECRET: "el-native-secret",
      EL_MICROSOFT_CLIENT_ID: "18ec6a91-f043-4f63-8800-64135af48c4e",
    } as Env;
    const token = await acquireMicrosoftAppToken(env, { companyId: "co_el" });
    expect(token.ok).toBe(true);
    if (token.ok) {
      expect(token.clientId).toBe(EL_NATIVE_MICROSOFT_CLIENT_ID);
      expect(token.tenantId).toBe(EL_NATIVE_MICROSOFT_TENANT_ID);
      expect(token.identityKind).toBe("tenant_native");
    }
    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain(EL_NATIVE_MICROSOFT_CLIENT_ID);
    expect(body).toContain("el-native-secret");
    expect(body).not.toContain("shared-platform-secret");
    expect(body).not.toContain(SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID);
    expect(body).not.toContain("18ec6a91-f043-4f63-8800-64135af48c4e");
    vi.unstubAllGlobals();
  });

  it("keeps the Option B cutover subject exact", () => {
    expect(EL_OPTION_B_CUTOVER_SUBJECT).toBe("INFRA — EL Business Knowledge Intake — Sync test");
  });
});
