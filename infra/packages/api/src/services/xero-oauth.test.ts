import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import app from "../index";
import {
  disconnectXero,
  getValidXeroAccessToken,
  handleXeroOAuthCallback,
  publicXeroView,
  resolveXeroPayload,
  selectXeroOrganisation,
  startXeroOAuth,
  testXeroConnection,
  xeroOauthStatus,
} from "./xero";
import { prepareXeroMcpExecution } from "./xero-tools";
import { EncryptedD1SecretProvider } from "./secrets";

const KEY = "cd".repeat(32);
const originalFetch = globalThis.fetch;

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]> = {
    companies: [
      { id: "co_a", slug: "alpha", name: "Alpha", status: "active", created_at: "t", updated_at: "t" },
      { id: "co_b", slug: "beta", name: "Beta", status: "active", created_at: "t", updated_at: "t" },
    ],
    connector_instances: [
      instance("ci_xero_a", "co_a"),
      instance("ci_xero_b", "co_b"),
    ],
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

function instance(id: string, companyId: string): Row {
  return {
    id,
    company_id: companyId,
    connector_definition_id: "conn_xero",
    name: "Xero",
    status: "draft",
    config_json: "{}",
    sync_settings_json: "{}",
    health_status: "unknown",
    created_at: "t",
    updated_at: "t",
  };
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
    if (q.includes("from connector_instances") && q.includes("connector_definition_id = 'conn_xero'")) {
      return this.db.tables.connector_instances.filter(
        (r) => r.company_id === this.binds[0] && r.connector_definition_id === "conn_xero",
      );
    }
    if (q.includes("from connector_instances where company_id")) {
      return this.db.tables.connector_instances.filter((r) => r.company_id === this.binds[0]);
    }
    if (q.includes("from credential_refs where id") && q.includes("company_id")) {
      return this.db.tables.credential_refs.filter(
        (r) => r.id === this.binds[0] && r.company_id === this.binds[1],
      );
    }
    if (q.includes("from credential_refs where id")) {
      return this.db.tables.credential_refs.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from secret_ciphertexts where id")) {
      return this.db.tables.secret_ciphertexts.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from oauth_authorization_states where state_hash")) {
      return this.db.tables.oauth_authorization_states.filter((r) => r.state_hash === this.binds[0]);
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
    if (q.startsWith("insert into credential_refs")) {
      this.db.tables.credential_refs.push({
        id: this.binds[0],
        company_id: this.binds[1],
        connector_instance_id: this.binds[2],
        secret_ref: this.binds[5],
        status: "valid",
        created_at: this.binds[6],
        updated_at: this.binds[7],
      });
    }
    if (q.startsWith("insert into audit_events")) {
      this.db.tables.audit_events.push({
        event_type: this.binds[2],
        company_id: this.binds[1],
        detail_json: this.binds[6],
      });
    }
    if (q.startsWith("update connector_instances")) {
      const id = this.binds[this.binds.length - 2];
      const companyId = this.binds[this.binds.length - 1];
      for (const row of this.db.tables.connector_instances) {
        if (row.id !== id || row.company_id !== companyId) continue;
        if (q.includes("credential_ref_id = ?") && q.includes("external_account_id")) {
          row.credential_ref_id = this.binds[0];
          row.auth_status = this.binds[1];
          row.status = this.binds[2];
          row.external_account_id = this.binds[3];
          row.display_account_name = this.binds[4];
          row.connected_at = this.binds[5];
          row.health_status = this.binds[6];
          row.provider_health = this.binds[7];
          row.health_message = this.binds[8];
          row.last_health_at = this.binds[9];
          row.config_json = this.binds[10];
          row.capabilities_enabled_json = this.binds[11];
        } else if (q.includes("auth_status = 'auth_expired'")) {
          row.auth_status = "auth_expired";
          row.health_message = this.binds[0];
        } else if (q.includes("auth_status = 'revoked'")) {
          row.auth_status = "revoked";
          row.credential_ref_id = null;
        } else if (q.includes("auth_status = 'configuring'")) {
          row.auth_status = "configuring";
          if (q.includes("credential_ref_id = ?")) {
            row.credential_ref_id = this.binds[0];
          }
        } else if (q.includes("auth_status = 'connected'")) {
          row.auth_status = "connected";
          row.display_account_name = this.binds[0];
        }
      }
    }
    if (q.startsWith("update credential_refs") && q.includes("status = 'revoked'")) {
      for (const row of this.db.tables.credential_refs) {
        if (row.id === this.binds[1]) row.status = "revoked";
      }
    }
    if (q.startsWith("update secret_ciphertexts") && q.includes("status = 'active'")) {
      const id = this.binds[this.binds.length - 2];
      const companyId = this.binds[this.binds.length - 1];
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id !== id || row.company_id !== companyId) continue;
        row.algorithm = this.binds[0];
        row.key_version = this.binds[1];
        row.nonce_b64 = this.binds[2];
        row.ciphertext_b64 = this.binds[3];
        row.aad = this.binds[4];
        row.status = "active";
      }
    }
    if (q.startsWith("update secret_ciphertexts") && q.includes("status = 'revoked'")) {
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id === this.binds[2]) {
          row.status = "revoked";
          row.ciphertext_b64 = "";
        }
      }
    }
  }
}

function envFor(db: FakeD1, extras: Record<string, unknown> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "production",
    SESSION_SECRET: "x",
    ALLOWED_ORIGINS: "https://infra-web.pages.dev",
    INFRA_CREDENTIAL_WRAPPING_KEY: KEY,
    XERO_CLIENT_ID: "xero-client-id",
    XERO_CLIENT_SECRET: "xero-client-secret",
    ...extras,
  } as unknown as Env;
}

function mockXeroApis(options?: { refreshFail?: boolean; manyOrgs?: boolean }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/connect/token")) {
      const body = String(init?.body ?? "");
      if (body.includes("refresh_token") && options?.refreshFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: "access-aaa",
          refresh_token: "refresh-aaa",
          expires_in: 1800,
          token_type: "Bearer",
          scope: "offline_access accounting.settings.read",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/connections") && (!init?.method || init.method === "GET")) {
      const orgs = options?.manyOrgs
        ? [
            { id: "conn-1", tenantId: "tenant-a", tenantName: "Org A" },
            { id: "conn-2", tenantId: "tenant-b", tenantName: "Org B" },
          ]
        : [{ id: "conn-1", tenantId: "tenant-a", tenantName: "Org A" }];
      return new Response(JSON.stringify(orgs), { status: 200 });
    }
    if (url.includes("/Organisation")) {
      return new Response(
        JSON.stringify({ Organisations: [{ Name: "Org A" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/connections/") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Xero OAuth", () => {
  it("stays disabled without app credentials or wrapping key", () => {
    const db = new FakeD1();
    expect(
      xeroOauthStatus({
        DB: db as unknown as D1Database,
        ENVIRONMENT: "production",
        SESSION_SECRET: "x",
        ALLOWED_ORIGINS: "*",
      } as Env).readyToConnect,
    ).toBe(false);
    expect(xeroOauthStatus(envFor(db)).readyToConnect).toBe(true);
  });

  it("rejects start when the Xero application secrets are missing", async () => {
    const db = new FakeD1();
    const started = await startXeroOAuth({
      env: {
        DB: db as unknown as D1Database,
        ENVIRONMENT: "production",
        SESSION_SECRET: "x",
        ALLOWED_ORIGINS: "https://infra-web.pages.dev",
        INFRA_CREDENTIAL_WRAPPING_KEY: KEY,
      } as Env,
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.body.code).toBe("OAUTH_APP_NOT_CONFIGURED");
  });

  it("rejects unauthenticated start, test, and disconnect routes", async () => {
    const env = envFor(new FakeD1());
    const start = await app.request(
      "/api/companies/alpha/connectors/conn_xero/oauth/start",
      { method: "POST" },
      env,
    );
    expect(start.status).toBe(401);
    const tested = await app.request(
      "/api/companies/alpha/connectors/ci_xero_a/test",
      { method: "POST" },
      env,
    );
    expect(tested.status).toBe(401);
    const disconnected = await app.request(
      "/api/companies/alpha/connectors/ci_xero_a/disconnect",
      { method: "POST" },
      env,
    );
    expect(disconnected.status).toBe(401);
    const callback = await app.request(
      "/api/connectors/xero/oauth/callback?state=guessed&code=x",
      {},
      env,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location") ?? "").toContain("xero=error");
    expect(callback.headers.get("Location") ?? "").not.toContain("access-aaa");
  });

  it("builds a reusable authorize URL without leaking the client secret", async () => {
    const db = new FakeD1();
    const started = await startXeroOAuth({
      env: envFor(db),
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.authorizationUrl).toContain("login.xero.com");
    expect(started.authorizationUrl).toContain("code_challenge");
    expect(started.authorizationUrl).toContain("accounting.invoices.read");
    expect(started.authorizationUrl).not.toContain("xero-client-secret");
    expect(started.authorizationUrl).not.toContain("accounting.transactions");
    expect(JSON.stringify(db.tables.oauth_authorization_states)).not.toContain("xero-client-secret");
  });

  it("rejects guessed, replayed, and cross-user OAuth state", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const started = await startXeroOAuth({
      env,
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get("state") ?? "";

    const guessed = await handleXeroOAuthCallback({
      env,
      state: "guessed",
      code: "code",
    });
    expect(guessed.redirectTo).toContain("xero=error");

    const wrongUser = await handleXeroOAuthCallback({
      env,
      state,
      code: "code",
      sessionUserId: "user_b",
    });
    expect(wrongUser.redirectTo).toContain("xero=error");

    mockXeroApis();
    const ok = await handleXeroOAuthCallback({
      env,
      state,
      code: "auth-code",
      sessionUserId: "user_a",
    });
    expect(ok.redirectTo).toContain("xero=connected");

    const replay = await handleXeroOAuthCallback({
      env,
      state,
      code: "auth-code",
      sessionUserId: "user_a",
    });
    expect(replay.redirectTo).toContain("xero=error");
    expect(JSON.stringify(db.tables)).not.toContain("access-aaa");
    expect(JSON.stringify(db.tables)).not.toContain("refresh-aaa");
  });

  it("stores encrypted tokens and isolates Company A from Company B", async () => {
    mockXeroApis();
    const db = new FakeD1();
    const env = envFor(db);
    const started = await startXeroOAuth({
      env,
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    await handleXeroOAuthCallback({
      env,
      state,
      code: "auth-code",
      sessionUserId: "user_a",
    });

    const a = await resolveXeroPayload(env, "co_a", "ci_xero_a", "a@example.com");
    expect(a.ok && "payload" in a && a.payload.accessToken).toBe("access-aaa");
    const stolen = await resolveXeroPayload(env, "co_b", "ci_xero_a", "b@example.com");
    expect(stolen.ok).toBe(false);
    const cross = await getValidXeroAccessToken({
      env,
      companyId: "co_b",
      instanceId: "ci_xero_a",
      actor: "b@example.com",
      reason: "test",
    });
    expect(cross.ok).toBe(false);

    const instance = db.tables.connector_instances.find((row) => row.id === "ci_xero_a");
    const view = publicXeroView({
      displayAccountName: instance?.display_account_name as string,
      externalAccountId: instance?.external_account_id as string,
      authStatus: instance?.auth_status as string,
      connectedAt: instance?.connected_at as string,
      capabilitiesEnabled: ["offline_access"],
      config: {},
    });
    expect(JSON.stringify(view)).not.toContain("access-aaa");
    expect(view.organisationName).toBe("Org A");

    const ready = await prepareXeroMcpExecution({
      env,
      companyId: "co_a",
      toolName: "xero_search_invoices",
    });
    expect(ready.ok).toBe(true);
    const write = await prepareXeroMcpExecution({
      env,
      companyId: "co_a",
      toolName: "xero_create_draft_invoice",
    });
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.inventsData).toBe(false);
      expect(write.body.code).toBe("OAUTH_SCOPE_UPGRADE_REQUIRED");
    }

    db.tables.connector_instances[0]!.capabilities_enabled_json = JSON.stringify([
      "offline_access",
      "accounting.settings.read",
      "accounting.contacts.read",
      "accounting.invoices.read",
      "accounting.payments.read",
      "accounting.banktransactions.read",
      "accounting.reports.profitandloss.read",
      "accounting.reports.balancesheet.read",
      "accounting.reports.aged.read",
      "accounting.invoices",
      "accounting.payments",
      "accounting.contacts",
    ]);
    const writeReady = await prepareXeroMcpExecution({
      env,
      companyId: "co_a",
      toolName: "xero_create_draft_invoice",
    });
    expect(writeReady.ok).toBe(true);
    if (writeReady.ok) {
      expect(writeReady.writesEnabled).toBe(true);
    }

    const tested = await testXeroConnection({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      actor: "a@example.com",
    });
    expect(tested.tested).toBe(true);
    expect(tested.organisationName).toBe("Org A");
    expect(JSON.stringify(db.tables.audit_events)).not.toContain("access-aaa");
    expect(JSON.stringify(db.tables.audit_events)).not.toContain("refresh-aaa");
    expect(JSON.stringify(db.tables.audit_events)).not.toContain("xero-client-secret");
  });

  it("stores tokens when several Xero organisations are returned and waits for selection", async () => {
    mockXeroApis({ manyOrgs: true });
    const db = new FakeD1();
    const env = envFor(db);
    const started = await startXeroOAuth({
      env,
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    if (!started.ok) throw new Error("start failed");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const callback = await handleXeroOAuthCallback({
      env,
      state,
      code: "auth-code",
      sessionUserId: "user_a",
    });
    expect(callback.redirectTo).toContain("xero=select_org");
    const selected = await selectXeroOrganisation({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      tenantId: "tenant-b",
      actor: "a@example.com",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.organisationName).toBe("Org B");
    const payload = await resolveXeroPayload(env, "co_a", "ci_xero_a", "a@example.com");
    expect(payload.ok && "payload" in payload && payload.payload.providerTenantId).toBe(
      "tenant-b",
    );
  });

  it("keeps tokens after a failed refresh and does not invent MCP accounting data", async () => {
    mockXeroApis();
    const db = new FakeD1();
    const env = envFor(db);
    const started = await startXeroOAuth({
      env,
      companyId: "co_a",
      companySlug: "alpha",
      userId: "user_a",
      actor: "a@example.com",
    });
    if (!started.ok) throw new Error("start failed");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    await handleXeroOAuthCallback({
      env,
      state,
      code: "auth-code",
      sessionUserId: "user_a",
    });

    const row = db.tables.secret_ciphertexts[0]!;
    const provider = new EncryptedD1SecretProvider(env);
    const expired = JSON.stringify({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2020-01-01T00:00:00.000Z",
      tokenType: "Bearer",
      scopes: [],
      providerTenantId: "tenant-a",
      connectionId: "conn-1",
      organisationName: "Org A",
    });
    await provider.rotate(String(row.id), expired, {
      companyId: "co_a",
      actor: "test",
      reason: "rotation",
    });

    mockXeroApis({ refreshFail: true });
    const refreshed = await getValidXeroAccessToken({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      actor: "a@example.com",
      reason: "token_refresh",
    });
    expect(refreshed.ok).toBe(false);
    expect(db.tables.connector_instances[0]?.auth_status).toBe("auth_expired");
    const still = await resolveXeroPayload(env, "co_a", "ci_xero_a", "a@example.com");
    expect(still.ok && "payload" in still && still.payload.refreshToken).toBe("old-refresh");

    const mcp = await prepareXeroMcpExecution({
      env,
      companyId: "co_b",
      toolName: "xero_search_invoices",
    });
    expect(mcp.ok).toBe(false);
    if (!mcp.ok) expect(mcp.inventsData).toBe(false);

    const failedTest = await testXeroConnection({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      actor: "a@example.com",
    });
    expect(failedTest.tested).toBe(false);
    const kept = await resolveXeroPayload(env, "co_a", "ci_xero_a", "a@example.com");
    expect(kept.ok && "payload" in kept && kept.payload.refreshToken).toBe("old-refresh");

    mockXeroApis();
    const recovered = await testXeroConnection({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      actor: "a@example.com",
    });
    expect(recovered.tested).toBe(true);

    const disconnected = await disconnectXero({
      env,
      companyId: "co_a",
      instanceId: "ci_xero_a",
      actor: "a@example.com",
    });
    expect(disconnected.ok).toBe(true);
    const after = await resolveXeroPayload(env, "co_a", "ci_xero_a", "a@example.com");
    expect(after.ok).toBe(false);
  });
});
