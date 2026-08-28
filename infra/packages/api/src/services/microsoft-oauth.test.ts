import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
  createOauthAuthorizationState,
  consumeOauthAuthorizationState,
} from "./connector-oauth";
import {
  handleMicrosoftAdminConsentCallback,
  startMicrosoftConnect,
  testMicrosoftConnection,
  disconnectMicrosoft,
} from "./microsoft-oauth";
import { clearMicrosoftTokenCache } from "./microsoft-auth";
import { EncryptedD1SecretProvider } from "./secrets";

const KEY = "ef".repeat(32);
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const originalFetch = globalThis.fetch;

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]> = {
    companies: [
      {
        id: "co_a",
        slug: "alpha",
        name: "Alpha",
        status: "active",
        created_at: "t",
        updated_at: "t",
      },
      {
        id: "co_b",
        slug: "beta",
        name: "Beta",
        status: "active",
        created_at: "t",
        updated_at: "t",
      },
    ],
    connector_instances: [],
    credential_refs: [],
    secret_ciphertexts: [],
    secret_ciphertext_history: [],
    audit_events: [],
    oauth_authorization_states: [],
  };

  prepare(sql: string) {
    return new Stmt(this, sql);
  }
}

class Stmt {
  private binds: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.binds = args;
    return this;
  }
  async first() {
    return this.select()[0] ?? null;
  }
  async all() {
    return { results: this.select() };
  }
  async run() {
    this.mutate();
    return { success: true };
  }
  private q() {
    return this.sql.replace(/\s+/g, " ").trim().toLowerCase();
  }
  private select(): Row[] {
    const q = this.q();
    if (q.includes("from companies where id")) {
      return this.db.tables.companies.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from connector_instances where id")) {
      return this.db.tables.connector_instances.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from connector_instances") && q.includes("conn_microsoft_365")) {
      return this.db.tables.connector_instances.filter(
        (r) => r.company_id === this.binds[0] && r.connector_definition_id === "conn_microsoft_365",
      );
    }
    if (q.includes("from oauth_authorization_states where state_hash")) {
      return this.db.tables.oauth_authorization_states.filter((r) => r.state_hash === this.binds[0]);
    }
    if (q.includes("from credential_refs where id")) {
      return this.db.tables.credential_refs.filter(
        (r) => r.id === this.binds[0] && r.company_id === this.binds[1],
      );
    }
    if (q.includes("from secret_ciphertexts where id")) {
      return this.db.tables.secret_ciphertexts.filter((r) => r.id === this.binds[0]);
    }
    return [];
  }
  private mutate() {
    const q = this.q();
    if (q.startsWith("insert into oauth_authorization_states")) {
      this.db.tables.oauth_authorization_states.push({
        id: this.binds[0],
        state_hash: this.binds[1],
        company_id: this.binds[2],
        connector_definition_id: this.binds[3],
        connector_instance_id: this.binds[4],
        user_id: this.binds[5],
        code_challenge: this.binds[6],
        redirect_uri: this.binds[7],
        scopes_json: this.binds[8],
        expires_at: this.binds[9],
        consumed_at: null,
        created_at: this.binds[10],
        code_verifier_nonce_b64: this.binds[11],
        code_verifier_ciphertext_b64: this.binds[12],
        return_path: this.binds[13],
      });
    }
    if (q.startsWith("update oauth_authorization_states")) {
      const row = this.db.tables.oauth_authorization_states.find((r) => r.id === this.binds[1]);
      if (row) row.consumed_at = this.binds[0];
    }
    if (q.startsWith("insert into connector_instances")) {
      this.db.tables.connector_instances.push({
        id: this.binds[0],
        company_id: this.binds[1],
        connector_definition_id: this.binds[2],
        name: this.binds[3],
        status: this.binds[4],
        config_json: this.binds[5],
        sync_settings_json: this.binds[6],
        auth_status: this.binds[7],
        health_status: this.binds[8],
        health_message: this.binds[9],
        managed_by: this.binds[10],
        configured_by: this.binds[11],
        microsoft_auth_mode: this.binds[12],
        credential_ref_id: null,
        external_account_id: null,
        created_at: this.binds[13],
        updated_at: this.binds[14],
      });
    }
    if (q.startsWith("update connector_instances")) {
      const id = this.binds[this.binds.length - 2];
      const companyId = this.binds[this.binds.length - 1];
      const row = this.db.tables.connector_instances.find(
        (r) => r.id === id && r.company_id === companyId,
      );
      if (!row) return;
      if (q.includes("microsoft_tenant_id = ?")) {
        row.microsoft_tenant_id = this.binds[0];
        row.external_account_id = this.binds[1];
        row.display_account_name = this.binds[2];
        row.auth_status = "connected";
        row.status = "configured";
        row.connected_at = this.binds[3];
        row.microsoft_consented_at = this.binds[4];
        row.microsoft_consented_by = this.binds[5];
        row.health_status = "healthy";
        row.health_message = "Microsoft admin consent granted";
        row.last_health_at = this.binds[6];
        row.updated_at = this.binds[7];
      }
      if (q.includes("microsoft_auth_mode = ?") && q.includes("health_message = ?")) {
        row.auth_status = this.binds[0];
        row.microsoft_auth_mode = this.binds[1];
        row.health_message = this.binds[2];
        row.configured_by = this.binds[3];
        row.updated_at = this.binds[4];
      }
      if (q.includes("auth_status = 'revoked'")) {
        row.auth_status = "revoked";
        row.microsoft_tenant_id = null;
        row.external_account_id = null;
      }
    }
    if (q.startsWith("insert into credential_refs")) {
      this.db.tables.credential_refs.push({
        id: this.binds[0],
        company_id: this.binds[1],
        connector_instance_id: this.binds[2],
        label: this.binds[3],
        provider: this.binds[4],
        secret_ref: this.binds[5],
        status: this.binds[6],
        created_at: this.binds[7],
        updated_at: this.binds[8],
      });
    }
    if (q.startsWith("insert into secret_ciphertexts")) {
      this.db.tables.secret_ciphertexts.push({
        id: this.binds[0],
        company_id: this.binds[1],
        connector_instance_id: this.binds[2],
        purpose: this.binds[3],
        algorithm: this.binds[4],
        key_version: this.binds[5],
        nonce_b64: this.binds[6],
        ciphertext_b64: this.binds[7],
        aad: this.binds[8],
        status: "active",
        created_at: this.binds[9],
        updated_at: this.binds[10],
      });
    }
    if (q.startsWith("insert into audit_events")) {
      this.db.tables.audit_events.push({ detail_json: "{}" });
    }
  }
}

function env(db: FakeD1, extra: Record<string, unknown> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "https://portal.example.com",
    INFRA_PUBLIC_API_URL: "https://api.example.com",
    INFRA_CREDENTIAL_WRAPPING_KEY: KEY,
    MICROSOFT_TENANT_ID: TENANT_A,
    MICROSOFT_CLIENT_ID: "platform-client",
    MICROSOFT_CLIENT_SECRET: "platform-secret",
    MICROSOFT_MULTITENANT_APP: "true",
    ...extra,
  } as Env;
}

async function seedCompanyAppInstance(db: FakeD1, companyId: string): Promise<string> {
  const instanceId = "ci_ms_a";
  db.tables.connector_instances.push({
    id: instanceId,
    company_id: companyId,
    connector_definition_id: "conn_microsoft_365",
    name: "Microsoft 365",
    status: "draft",
    config_json: "{}",
    sync_settings_json: "{}",
    auth_status: "configuring",
    microsoft_auth_mode: "company_app",
    credential_ref_id: "cred_ms_a",
    created_at: "t",
    updated_at: "t",
  });
  const provider = new EncryptedD1SecretProvider(env(db));
  const stored = await provider.store({
    companyId,
    purpose: "connector",
    value: JSON.stringify({
      tenantId: TENANT_A,
      clientId: "company-client",
      clientSecret: "company-secret",
    }),
    connectorInstanceId: instanceId,
    label: "Primary credential",
  });
  db.tables.credential_refs.push({
    id: "cred_ms_a",
    company_id: companyId,
    connector_instance_id: instanceId,
    label: "Primary credential",
    provider: "conn_microsoft_365",
    secret_ref: stored.reference,
    status: "valid",
    created_at: "t",
    updated_at: "t",
  });
  return instanceId;
}
describe("Microsoft 365 self-service onboarding", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearMicrosoftTokenCache();
    vi.restoreAllMocks();
  });

  it("starts BYO admin consent with tenant-specific URL", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const started = await startMicrosoftConnect({
      env: env(db),
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "admin@alpha.test",
      instanceId,
      authMode: "company_app",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.authorizationUrl).toContain(encodeURIComponent(TENANT_A));
    expect(started.authorizationUrl).toContain("adminconsent");
    expect(started.authMode).toBe("company_app");
  });

  it("rejects platform multitenant when operator flag disabled", async () => {
    const db = new FakeD1();
    const started = await startMicrosoftConnect({
      env: env(db, { MICROSOFT_MULTITENANT_APP: "false" }),
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "admin@alpha.test",
      authMode: "platform_multitenant",
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.code).toBe("MICROSOFT_MULTITENANT_NOT_ENABLED");
  });

  it("binds tenant on successful admin consent callback", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const oauth = await createOauthAuthorizationState(
      db as unknown as D1Database,
      {
        companyId: "co_a",
        userId: "user_a",
        definitionId: "conn_microsoft_365",
        instanceId,
        redirectUri: "https://api.example.com/api/connectors/microsoft/oauth/callback",
        scopes: ["Files.Read.All"],
        returnPath: "/portal/alpha/microsoft-365",
      },
      { INFRA_CREDENTIAL_WRAPPING_KEY: KEY },
    );

    const result = await handleMicrosoftAdminConsentCallback({
      env: env(db),
      state: oauth.state,
      adminConsent: "True",
      tenant: TENANT_A,
      sessionUserId: "user_a",
    });
    expect(result.redirectTo).toContain("microsoft=connected");
    const instance = db.tables.connector_instances.find((r) => r.id === instanceId);
    expect(instance?.auth_status).toBe("connected");
    expect(instance?.microsoft_tenant_id ?? instance?.external_account_id).toBe(TENANT_A);
  });

  it("blocks tenant substitution for BYO app credentials", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const oauth = await createOauthAuthorizationState(
      db as unknown as D1Database,
      {
        companyId: "co_a",
        userId: "user_a",
        definitionId: "conn_microsoft_365",
        instanceId,
        redirectUri: "https://api.example.com/api/connectors/microsoft/oauth/callback",
        scopes: ["Files.Read.All"],
      },
      { INFRA_CREDENTIAL_WRAPPING_KEY: KEY },
    );

    const result = await handleMicrosoftAdminConsentCallback({
      env: env(db),
      state: oauth.state,
      adminConsent: "True",
      tenant: TENANT_B,
      sessionUserId: "user_a",
    });
    expect(result.redirectTo).toContain("reason=tenant_mismatch");
    const instance = db.tables.connector_instances.find((r) => r.id === instanceId);
    expect(instance?.auth_status).toBe("configuring");
  });

  it("rejects OAuth state replay", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const oauth = await createOauthAuthorizationState(
      db as unknown as D1Database,
      {
        companyId: "co_a",
        userId: "user_a",
        definitionId: "conn_microsoft_365",
        instanceId,
        redirectUri: "https://api.example.com/callback",
        scopes: [],
      },
      { INFRA_CREDENTIAL_WRAPPING_KEY: KEY },
    );

    await handleMicrosoftAdminConsentCallback({
      env: env(db),
      state: oauth.state,
      adminConsent: "True",
      tenant: TENANT_A,
      sessionUserId: "user_a",
    });
    const replay = await handleMicrosoftAdminConsentCallback({
      env: env(db),
      state: oauth.state,
      adminConsent: "True",
      tenant: TENANT_A,
      sessionUserId: "user_a",
    });
    expect(replay.redirectTo).toContain("reason=invalid_state");
  });

  it("rejects tampered OAuth state", async () => {
    const db = new FakeD1();
    const result = await handleMicrosoftAdminConsentCallback({
      env: env(db),
      state: "tampered-state-value",
      adminConsent: "True",
      tenant: TENANT_A,
    });
    expect(result.redirectTo).toContain("reason=invalid_state");
  });

  it("prevents cross-company connector access via state company binding", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const oauth = await createOauthAuthorizationState(
      db as unknown as D1Database,
      {
        companyId: "co_a",
        userId: "user_a",
        definitionId: "conn_microsoft_365",
        instanceId,
        redirectUri: "https://api.example.com/callback",
        scopes: [],
      },
      { INFRA_CREDENTIAL_WRAPPING_KEY: KEY },
    );

    const consumed = await consumeOauthAuthorizationState(
      db as unknown as D1Database,
      { state: oauth.state, companyId: "co_b" },
      { INFRA_CREDENTIAL_WRAPPING_KEY: KEY },
    );
    expect(consumed.ok).toBe(false);
  });

  it("runs connection health test without exposing secrets", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    db.tables.connector_instances.find((r) => r.id === instanceId)!.microsoft_tenant_id = TENANT_A;
    db.tables.connector_instances.find((r) => r.id === instanceId)!.external_account_id = TENANT_A;
    db.tables.connector_instances.find((r) => r.id === instanceId)!.auth_status = "connected";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2/v2.0/token")) {
        return new Response(
          JSON.stringify({ access_token: "token-abc", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("graph.microsoft.com")) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await testMicrosoftConnection({
      env: env(db),
      companyId: "co_a",
      instanceId,
      actor: "admin@alpha.test",
    });
    expect(result.tested).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("company-secret");
    expect(result.tenantIdMasked).toContain("…");
  });

  it("allows disconnect for self-service modes but not platform legacy", async () => {
    const db = new FakeD1();
    const instanceId = await seedCompanyAppInstance(db, "co_a");
    const disconnected = await disconnectMicrosoft({
      env: env(db),
      companyId: "co_a",
      instanceId,
      actor: "admin@alpha.test",
    });
    expect(disconnected.ok).toBe(true);

    db.tables.connector_instances.push({
      id: "ci_legacy",
      company_id: "co_a",
      connector_definition_id: "conn_microsoft_365",
      name: "Legacy",
      status: "configured",
      config_json: "{}",
      sync_settings_json: "{}",
      auth_status: "connected",
      microsoft_auth_mode: "platform_legacy",
      created_at: "t",
      updated_at: "t",
    });
    const legacy = await disconnectMicrosoft({
      env: env(db),
      companyId: "co_a",
      instanceId: "ci_legacy",
      actor: "admin@alpha.test",
    });
    expect(legacy.ok).toBe(false);
  });
});
