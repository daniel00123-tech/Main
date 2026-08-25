import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  connectorHasProviderTest,
  getConnectorCredentialMetadata,
  partitionConnectorInput,
  resolveConnectorCredentialForExecution,
  revokeConnectorCredential,
  rotateConnectorCredential,
  storeConnectorCredential,
} from "./connector-credentials";
import { EncryptedD1SecretProvider, redactSecretFields, sanitizeCustomerError } from "./secrets";
import { listConnectorOversight } from "./control-plane";
import { getConnectorById } from "@infra/shared";

const KEY = "ab".repeat(32);

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]> = {
    companies: [
      companyRow("co_a", "alpha", "active"),
      companyRow("co_b", "beta", "active"),
      companyRow("co_suspended", "paused", "suspended"),
      companyRow("co_archived", "old", "archived"),
    ],
    connector_instances: [
      instanceRow("ci_a", "co_a", "conn_custom_api"),
      instanceRow("ci_b", "co_b", "conn_custom_api"),
      instanceRow("ci_a_oauth", "co_a", "conn_xero"),
      instanceRow("ci_suspended", "co_suspended", "conn_custom_api"),
      instanceRow("ci_archived", "co_archived", "conn_custom_api"),
    ],
    credential_refs: [],
    secret_ciphertexts: [],
    secret_ciphertext_history: [],
    audit_events: [],
    mcp_environments: [],
  };

  prepare(sql: string) {
    return new Stmt(this, sql);
  }
}

function companyRow(id: string, slug: string, status: string): Row {
  return {
    id,
    slug,
    name: slug,
    status,
    created_at: "t",
    updated_at: "t",
  };
}

function instanceRow(id: string, companyId: string, definitionId: string): Row {
  return {
    id,
    company_id: companyId,
    connector_definition_id: definitionId,
    name: definitionId,
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
    if (q.includes("from connector_instances ci")) {
      return this.db.tables.connector_instances.map((ci) => {
        const company = this.db.tables.companies.find((c) => c.id === ci.company_id);
        return {
          ...ci,
          company_name: company?.name,
          company_slug: company?.slug,
          company_status: company?.status,
        };
      });
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
    return [];
  }
  private mutate() {
    const q = this.q();
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
        predecessor_id: null,
        created_at: this.binds[9],
        updated_at: this.binds[10],
        rotated_at: null,
        revoked_at: null,
      });
    }
    if (q.startsWith("insert into secret_ciphertext_history")) {
      this.db.tables.secret_ciphertext_history.push({
        secret_id: this.binds[1],
        company_id: this.binds[2],
        nonce_b64: this.binds[5],
        ciphertext_b64: this.binds[6],
        aad: this.binds[7],
      });
    }
    if (q.startsWith("insert into credential_refs")) {
      this.db.tables.credential_refs.push({
        id: this.binds[0],
        company_id: this.binds[1],
        connector_instance_id: this.binds[2],
        label: this.binds[3],
        provider: this.binds[4],
        secret_ref: this.binds[5],
        status: "valid",
        created_at: this.binds[6],
        updated_at: this.binds[7],
      });
    }
    if (q.startsWith("insert into audit_events")) {
      this.db.tables.audit_events.push({
        id: this.binds[0],
        company_id: this.binds[1],
        event_type: this.binds[2],
        actor: this.binds[3],
        detail_json: this.binds[6],
      });
    }
    if (q.startsWith("update connector_instances")) {
      const id = this.binds[this.binds.length - 2];
      const companyId = this.binds[this.binds.length - 1];
      for (const row of this.db.tables.connector_instances) {
        if (row.id === id && row.company_id === companyId) {
          if (q.includes("set config_json")) {
            row.config_json = this.binds[0];
          } else if (q.includes("credential_ref_id = ?") && q.includes("auth_status = 'configuring'")) {
            row.credential_ref_id = this.binds[0];
            row.auth_status = "configuring";
            row.configured_by = this.binds[1];
            row.status = "configured";
            row.health_message = this.binds[2];
          } else if (q.includes("auth_status = 'revoked'")) {
            row.auth_status = "revoked";
            row.status = "disabled";
            row.credential_ref_id = null;
          } else if (q.includes("auth_status = 'configuring'")) {
            row.auth_status = "configuring";
            row.health_message = this.binds[0];
          }
        }
      }
    }
    if (q.startsWith("update credential_refs") && q.includes("status = 'revoked'")) {
      for (const row of this.db.tables.credential_refs) {
        if (row.id === this.binds[1] && row.company_id === this.binds[2]) {
          row.status = "revoked";
        }
      }
    } else if (q.startsWith("update credential_refs")) {
      for (const row of this.db.tables.credential_refs) {
        if (row.id === this.binds[3] && row.company_id === this.binds[4]) {
          row.secret_ref = this.binds[0];
          row.status = "valid";
          row.rotated_at = this.binds[1];
        }
      }
    }
    if (q.startsWith("update secret_ciphertexts") && q.includes("status = 'revoked'")) {
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id === this.binds[2] && row.company_id === this.binds[3]) {
          row.status = "revoked";
          row.ciphertext_b64 = "";
        }
      }
    } else if (q.startsWith("update secret_ciphertexts")) {
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id === this.binds[8] && row.company_id === this.binds[9]) {
          row.ciphertext_b64 = this.binds[3];
          row.nonce_b64 = this.binds[2];
          row.aad = this.binds[4];
          row.key_version = this.binds[1];
          row.status = "active";
        }
      }
    }
    if (q.startsWith("update secret_ciphertext_history")) {
      for (const row of this.db.tables.secret_ciphertext_history) {
        if (row.secret_id === this.binds[0]) {
          row.ciphertext_b64 = "";
        }
      }
    }
  }
}

function envFor(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "production",
    SESSION_SECRET: "x",
    ALLOWED_ORIGINS: "*",
    INFRA_CREDENTIAL_WRAPPING_KEY: KEY,
  } as unknown as Env;
}

describe("credential tenant and API security", () => {
  it("stores isolated API-key and OAuth payloads without leaking values", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);

    const a = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "alpha-key", username: "alpha", password: "alpha-pass" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    const b = await storeConnectorCredential({
      env,
      companyId: "co_b",
      instanceId: "ci_b",
      label: "Beta API",
      provider: "conn_custom_api",
      credentials: { apiKey: "beta-key" },
      actor: "b@example.com",
      secretProvider: provider,
    });
    const oauth = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a_oauth",
      label: "Alpha OAuth",
      provider: "conn_xero",
      credentials: {
        clientSecret: "xero-secret",
        refreshToken: "xero-refresh",
        accessToken: "xero-access",
      },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(a.ok && b.ok && oauth.ok).toBe(true);
    expect(JSON.stringify(db.tables.secret_ciphertexts)).not.toContain("alpha-key");
    expect(JSON.stringify(db.tables.audit_events)).not.toContain("alpha-key");
    expect(JSON.stringify(db.tables.audit_events)).not.toContain("xero-refresh");

    const resolvedA = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "infra-internal",
      reason: "execution",
      secretProvider: provider,
    });
    expect(resolvedA.ok && "payload" in resolvedA && resolvedA.payload.apiKey).toBe("alpha-key");

    const cross = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_b",
      actor: "a@example.com",
      reason: "execution",
      secretProvider: provider,
    });
    expect(cross.ok).toBe(false);

    const stolenRotate = await rotateConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      credentialRefId: b.ok ? b.credentialRefId : "cred_missing",
      credentials: { apiKey: "stolen" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(stolenRotate.ok).toBe(false);

    const stolenRevoke = await revokeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_b",
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(stolenRevoke.ok).toBe(false);

    const stillB = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_b",
      instanceId: "ci_b",
      actor: "infra-internal",
      reason: "execution",
      secretProvider: provider,
    });
    expect(stillB.ok && "payload" in stillB && stillB.payload.apiKey).toBe("beta-key");
  });

  it("never returns stored secrets on metadata or admin oversight", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "visible-if-leaked" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    const metadata = await getConnectorCredentialMetadata({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
    });
    expect(metadata.stored).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("visible-if-leaked");
    expect(metadata.fields.every((field) => field.masked)).toBe(true);

    const oversight = await listConnectorOversight(env.DB);
    expect(JSON.stringify(oversight)).not.toContain("visible-if-leaked");
    expect(oversight.every((row) => row.secretValue === undefined)).toBe(true);
  });

  it("blocks suspended and archived companies from storing or resolving", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    const suspended = await storeConnectorCredential({
      env,
      companyId: "co_suspended",
      instanceId: "ci_suspended",
      label: "Nope",
      provider: "conn_custom_api",
      credentials: { apiKey: "nope" },
      actor: "s@example.com",
      secretProvider: provider,
    });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.status).toBe(403);

    const archived = await storeConnectorCredential({
      env,
      companyId: "co_archived",
      instanceId: "ci_archived",
      label: "Nope",
      provider: "conn_custom_api",
      credentials: { apiKey: "nope" },
      actor: "arch@example.com",
      secretProvider: provider,
    });
    expect(archived.ok).toBe(false);
  });

  it("refuses resolve after revoke and redacts secret-shaped keys", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    const stored = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "to-revoke" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(stored.ok).toBe(true);
    const revoked = await revokeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(revoked.ok).toBe(true);
    const resolved = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "infra-internal",
      reason: "execution",
      secretProvider: provider,
    });
    expect(resolved.ok).toBe(false);
    const redacted = redactSecretFields({
      refreshToken: "abc",
      clientSecret: "xyz",
      folderIds: ["1"],
    });
    expect(redacted.refreshToken).toBe("[redacted]");
    expect(redacted.clientSecret).toBe("[redacted]");
    expect(redacted.folderIds).toEqual(["1"]);
  });

  it("encrypts secret fields and keeps non-secret configuration in connector config", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    const definition = getConnectorById("conn_custom_api");
    const partitioned = partitionConnectorInput(
      definition ?? null,
      {
        apiKey: "keep-secret",
        username: "public-user",
        password: "keep-password",
        accountId: "acct-1",
        baseUrl: "https://api.example.test",
      },
      {},
    );
    expect(partitioned.secretPayload).toEqual({
      apiKey: "keep-secret",
      password: "keep-password",
    });
    expect(partitioned.publicConfig).toEqual({
      username: "public-user",
      accountId: "acct-1",
      baseUrl: "https://api.example.test",
    });

    const stored = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: {
        apiKey: "keep-secret",
        username: "public-user",
        password: "keep-password",
        accountId: "acct-1",
        baseUrl: "https://api.example.test",
      },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(stored.ok).toBe(true);
    const config = JSON.parse(String(db.tables.connector_instances[0]?.config_json));
    expect(config.username).toBe("public-user");
    expect(config.accountId).toBe("acct-1");
    expect(JSON.stringify(config)).not.toContain("keep-secret");
    expect(JSON.stringify(db.tables.secret_ciphertexts)).not.toContain("keep-secret");
    expect(db.tables.connector_instances[0]?.auth_status).toBe("configuring");
    expect(connectorHasProviderTest("conn_custom_api")).toBe(false);
  });

  it("rejects a Company A connector that is pointed at a Company B credential", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    const storedB = await storeConnectorCredential({
      env,
      companyId: "co_b",
      instanceId: "ci_b",
      label: "Beta API",
      provider: "conn_custom_api",
      credentials: { apiKey: "beta-only" },
      actor: "b@example.com",
      secretProvider: provider,
    });
    expect(storedB.ok).toBe(true);
    const instanceA = db.tables.connector_instances.find((row) => row.id === "ci_a");
    if (instanceA && storedB.ok) instanceA.credential_ref_id = storedB.credentialRefId;

    const resolved = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "a@example.com",
      reason: "execution",
      secretProvider: provider,
    });
    expect(resolved.ok).toBe(false);
  });

  it("keeps the latest credential after a duplicate rotation and refuses after company suspend", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    const stored = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "first-key" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const first = await rotateConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      credentialRefId: stored.credentialRefId,
      credentials: { apiKey: "second-key" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    const second = await rotateConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      credentialRefId: stored.credentialRefId,
      credentials: { apiKey: "third-key" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    expect(first.ok && second.ok).toBe(true);
    const resolved = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "infra-internal",
      reason: "execution",
      secretProvider: provider,
    });
    expect(resolved.ok && "payload" in resolved && resolved.payload.apiKey).toBe("third-key");

    const company = db.tables.companies.find((row) => row.id === "co_a");
    if (company) company.status = "suspended";
    const blocked = await resolveConnectorCredentialForExecution({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      actor: "infra-internal",
      reason: "execution",
      secretProvider: provider,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(403);
  });

  it("sanitises provider errors and never treats frontend metadata as a secret retrieval", async () => {
    const db = new FakeD1();
    const env = envFor(db);
    const provider = new EncryptedD1SecretProvider(env);
    await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "frontend-must-not-see" },
      actor: "a@example.com",
      secretProvider: provider,
    });
    const metadata = await getConnectorCredentialMetadata({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
    });
    expect(Object.keys(metadata)).not.toContain("secretValue");
    expect(Object.keys(metadata)).not.toContain("value");
    expect(JSON.stringify(metadata)).not.toContain("frontend-must-not-see");
    expect(sanitizeCustomerError("provider said api_key=frontend-must-not-see")).toBe(
      "provider said api_key=[redacted]",
    );
    expect(sanitizeCustomerError("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456")).toContain(
      "[redacted]",
    );
  });

  it("refuses store when the wrapping key is missing and no test provider is injected", async () => {
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ENVIRONMENT: "production",
      SESSION_SECRET: "x",
      ALLOWED_ORIGINS: "*",
    } as Env;
    const stored = await storeConnectorCredential({
      env,
      companyId: "co_a",
      instanceId: "ci_a",
      label: "Alpha API",
      provider: "conn_custom_api",
      credentials: { apiKey: "must-not-persist" },
      actor: "a@example.com",
    });
    expect(stored.ok).toBe(false);
    if (!stored.ok) expect(stored.status).toBe(409);
    expect(db.tables.secret_ciphertexts).toHaveLength(0);
    expect(JSON.stringify(db.tables)).not.toContain("must-not-persist");
  });
});
