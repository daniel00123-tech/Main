import { describe, expect, it } from "vitest";
import {
  platformMicrosoftConfigured,
  platformMultitenantAppEnabled,
  resolveMicrosoftAppCredentials,
} from "./microsoft-credentials";
import type { Env } from "../env";

const multitenantEnv = {
  MICROSOFT_CLIENT_ID: "client-id",
  MICROSOFT_CLIENT_SECRET: "client-secret",
  MICROSOFT_MULTITENANT_APP: "true",
} as unknown as Env;

const legacyEnv = {
  ...multitenantEnv,
  MICROSOFT_TENANT_ID: "caddington-tenant",
  MICROSOFT_MULTITENANT_APP: "false",
} as unknown as Env;

describe("platformMicrosoftConfigured", () => {
  it("allows SaaS app without global tenant when multitenant flag is enabled", () => {
    expect(platformMultitenantAppEnabled(multitenantEnv)).toBe(true);
    expect(platformMicrosoftConfigured(multitenantEnv)).toBe(true);
  });

  it("requires global tenant for legacy single-tenant mode", () => {
    expect(platformMicrosoftConfigured({ ...multitenantEnv, MICROSOFT_MULTITENANT_APP: "false" })).toBe(
      false,
    );
    expect(platformMicrosoftConfigured(legacyEnv)).toBe(true);
  });
});

describe("resolveMicrosoftAppCredentials", () => {
  it("uses connector-bound tenant for platform_multitenant without global fallback", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("connector_instances") && args[0] === "ci_b") {
              return {
                id: "ci_b",
                company_id: "co_b",
                microsoft_auth_mode: "platform_multitenant",
                microsoft_tenant_id: "tenant-b",
                external_account_id: null,
                credential_ref_id: null,
                auth_status: "connected",
                microsoft_consented_at: "2026-01-01T00:00:00Z",
                microsoft_consented_by: "admin",
              };
            }
            return null;
          },
        }),
      }),
    } as unknown as D1Database;

    const resolved = await resolveMicrosoftAppCredentials(multitenantEnv, db, {
      companyId: "co_b",
      connectorInstanceId: "ci_b",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.credentials.authMode).toBe("platform_multitenant");
      expect(resolved.credentials.tenantId).toBe("tenant-b");
      expect(resolved.credentials.clientId).toBe("client-id");
    }
  });

  it("does not fall back to Caddington tenant for unrelated multitenant company", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "ci_new",
            company_id: "co_new",
            microsoft_auth_mode: "platform_multitenant",
            microsoft_tenant_id: null,
            external_account_id: null,
            credential_ref_id: null,
            auth_status: "configuring",
            microsoft_consented_at: null,
            microsoft_consented_by: null,
          }),
        }),
      }),
    } as unknown as D1Database;

    const resolved = await resolveMicrosoftAppCredentials(multitenantEnv, db, {
      companyId: "co_new",
      connectorInstanceId: "ci_new",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("MICROSOFT_TENANT_NOT_BOUND");
    }
  });

  it("does not use platform credentials when a company has no Microsoft 365 binding", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const resolved = await resolveMicrosoftAppCredentials(legacyEnv, db, {
      companyId: "co_new",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("MICROSOFT_NOT_CONNECTED");
    }
  });

  it("resolves co_el to the tenant-native Elvex MCP app and never the shared connector", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const missing = await resolveMicrosoftAppCredentials(legacyEnv, db, { companyId: "co_el" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("MICROSOFT_TENANT_SECRET_MISSING");
    }

    const resolved = await resolveMicrosoftAppCredentials(
      {
        ...legacyEnv,
        EL_MICROSOFT_CLIENT_SECRET: "el-native-secret",
      } as unknown as Env,
      db,
      { companyId: "co_el" },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.credentials.clientId).toBe("18ec6a91-f043-4f63-8800-64135af48c4e");
      expect(resolved.credentials.tenantId).toBe("af32e619-3647-44a2-85d9-1c45457c0e91");
      expect(resolved.credentials.clientSecret).toBe("el-native-secret");
      expect(resolved.credentials.identityKind).toBe("tenant_native");
      expect(resolved.credentials.clientId).not.toBe("e5fd0533-ce51-43b8-999c-152f1e268246");
      expect(resolved.credentials.clientSecret).not.toBe("client-secret");
    }

    const caddington = await resolveMicrosoftAppCredentials(legacyEnv, db, {
      companyId: "co_caddington",
    });
    expect(caddington.ok).toBe(false);
    if (!caddington.ok) {
      expect(caddington.code).toBe("MICROSOFT_NOT_CONNECTED");
    }
  });
});
