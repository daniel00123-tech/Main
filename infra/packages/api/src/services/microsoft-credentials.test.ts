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
});
