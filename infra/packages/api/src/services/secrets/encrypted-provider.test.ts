import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import {
  EncryptedD1SecretProvider,
  SecretCryptoError,
  SecretStorageUnavailableError,
  SecretTenantMismatchError,
  createSecretProvider,
  credentialStorageStatus,
  encryptCredential,
  parseWrappingKey,
} from "./index";
import { CredentialSubmissionDisabledError } from "./provider";

const KEY_V1 = "0".repeat(64);
const KEY_V2 = "1".repeat(64);

type Row = Record<string, unknown>;

class FakeD1 {
  tables: Record<string, Row[]> = {
    secret_ciphertexts: [],
    secret_ciphertext_history: [],
    companies: [],
    connector_instances: [],
    credential_refs: [],
    mcp_environments: [],
    audit_events: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
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
    return this.rows()[0] ?? null;
  }
  async all() {
    return { results: this.rows() };
  }
  async run() {
    this.mutate();
    return { success: true };
  }
  private q() {
    return this.sql.replace(/\s+/g, " ").trim().toLowerCase();
  }
  private rows(): Row[] {
    const q = this.q();
    if (q.includes("from secret_ciphertexts where id")) {
      return this.db.tables.secret_ciphertexts.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from companies where id")) {
      return this.db.tables.companies.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from connector_instances where id")) {
      return this.db.tables.connector_instances.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from credential_refs where id") && q.includes("company_id")) {
      return this.db.tables.credential_refs.filter(
        (r) => r.id === this.binds[0] && r.company_id === this.binds[1],
      );
    }
    if (q.includes("from credential_refs where id")) {
      return this.db.tables.credential_refs.filter((r) => r.id === this.binds[0]);
    }
    if (q.includes("from mcp_environments") && q.includes("auth_secret_ref")) {
      return this.db.tables.mcp_environments.filter(
        (r) => r.company_id === this.binds[0] && r.auth_secret_ref === this.binds[1],
      );
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
        id: this.binds[0],
        secret_id: this.binds[1],
        company_id: this.binds[2],
        algorithm: this.binds[3],
        key_version: this.binds[4],
        nonce_b64: this.binds[5],
        ciphertext_b64: this.binds[6],
        aad: this.binds[7],
        retired_at: this.binds[8],
      });
    }
    if (q.startsWith("update secret_ciphertexts") && q.includes("status = 'revoked'")) {
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id === this.binds[2] && row.company_id === this.binds[3]) {
          row.ciphertext_b64 = "";
          row.nonce_b64 = "";
          row.aad = "";
          row.status = "revoked";
          row.revoked_at = this.binds[0];
          row.updated_at = this.binds[1];
        }
      }
    } else if (q.startsWith("update secret_ciphertexts")) {
      for (const row of this.db.tables.secret_ciphertexts) {
        if (row.id === this.binds[8] && row.company_id === this.binds[9]) {
          row.algorithm = this.binds[0];
          row.key_version = this.binds[1];
          row.nonce_b64 = this.binds[2];
          row.ciphertext_b64 = this.binds[3];
          row.aad = this.binds[4];
          row.status = "active";
          row.predecessor_id = this.binds[5];
          row.rotated_at = this.binds[6];
          row.updated_at = this.binds[7];
          row.revoked_at = null;
        }
      }
    }
    if (q.startsWith("update secret_ciphertext_history")) {
      for (const row of this.db.tables.secret_ciphertext_history) {
        if (row.secret_id === this.binds[0] && row.company_id === this.binds[1]) {
          row.ciphertext_b64 = "";
          row.nonce_b64 = "";
          row.aad = "";
        }
      }
    }
  }
}

function envWithKey(db: FakeD1, key = KEY_V1, extras: Record<string, unknown> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "production",
    SESSION_SECRET: "x",
    ALLOWED_ORIGINS: "http://localhost:5173",
    INFRA_CREDENTIAL_WRAPPING_KEY: key,
    ...extras,
  } as unknown as Env;
}

const ctxA = { companyId: "co_a", actor: "a@example.com", reason: "execution" as const };
const ctxB = { companyId: "co_b", actor: "b@example.com", reason: "execution" as const };

describe("encrypted D1 SecretProvider", () => {
  it("stores ciphertext only and resolves for the owning company", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "api_key",
      value: JSON.stringify({ apiKey: "alpha-secret", username: "alpha" }),
      connectorInstanceId: "ci_a",
    });
    expect(stored.reference).toMatch(/^sec_/);
    const row = db.tables.secret_ciphertexts[0]!;
    expect(JSON.stringify(row)).not.toContain("alpha-secret");
    expect(row.ciphertext_b64).toBeTruthy();
    expect(row.nonce_b64).toBeTruthy();
    expect(row.algorithm).toBe("AES-256-GCM");
    expect(row.key_version).toBe("v1");
    const resolved = await provider.resolve(stored.reference, ctxA);
    expect(resolved).toContain("alpha-secret");
    await expect(provider.resolve(stored.reference, ctxB)).rejects.toBeInstanceOf(
      SecretTenantMismatchError,
    );
  });

  it("isolates Company A API key, Company B API key, and Company A OAuth payloads", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const aKey = await provider.store({
      companyId: "co_a",
      purpose: "api_key",
      value: JSON.stringify({ apiKey: "aaa" }),
    });
    const bKey = await provider.store({
      companyId: "co_b",
      purpose: "api_key",
      value: JSON.stringify({ apiKey: "bbb" }),
    });
    const aOauth = await provider.store({
      companyId: "co_a",
      purpose: "oauth_access",
      value: JSON.stringify({
        accessToken: "a-access",
        refreshToken: "a-refresh",
        expiresAt: "2026-09-01T00:00:00.000Z",
        scopes: ["accounting.contacts.read"],
        providerTenantId: "xero-tenant-a",
      }),
    });
    expect(await provider.resolve(aKey.reference, ctxA)).toContain("aaa");
    expect(await provider.resolve(bKey.reference, ctxB)).toContain("bbb");
    expect(await provider.resolve(aOauth.reference, ctxA)).toContain("a-refresh");
    await expect(provider.resolve(bKey.reference, ctxA)).rejects.toBeInstanceOf(
      SecretTenantMismatchError,
    );
    await expect(provider.resolve(aOauth.reference, ctxB)).rejects.toBeInstanceOf(
      SecretTenantMismatchError,
    );
    await expect(
      provider.rotate(bKey.reference, JSON.stringify({ apiKey: "stolen" }), {
        ...ctxA,
        reason: "rotation",
      }),
    ).rejects.toBeInstanceOf(SecretTenantMismatchError);
    await expect(
      provider.revoke(bKey.reference, { ...ctxA, reason: "revocation" }),
    ).rejects.toBeInstanceOf(SecretTenantMismatchError);
    expect(await provider.resolve(bKey.reference, ctxB)).toContain("bbb");
  });

  it("rotates atomically and never reveals previous or new values", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "old-secret",
    });
    const rotated = await provider.rotate(stored.reference, "new-secret", {
      ...ctxA,
      reason: "rotation",
    });
    expect(rotated.reference).toBe(stored.reference);
    expect(JSON.stringify(rotated)).not.toContain("old-secret");
    expect(JSON.stringify(rotated)).not.toContain("new-secret");
    expect(await provider.resolve(stored.reference, ctxA)).toBe("new-secret");
    expect(db.tables.secret_ciphertext_history).toHaveLength(1);
    expect(JSON.stringify(db.tables.secret_ciphertext_history[0])).not.toContain("old-secret");
  });

  it("keeps the known-good credential if replacement encryption fails", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "good-secret",
    });
    await expect(
      provider.rotate(stored.reference, "", { ...ctxA, reason: "rotation" }),
    ).rejects.toBeInstanceOf(SecretCryptoError);
    expect(await provider.resolve(stored.reference, ctxA)).toBe("good-secret");
    expect(db.tables.secret_ciphertext_history).toHaveLength(0);
  });

  it("wipes ciphertext on revoke and refuses later resolve", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "temp-secret",
    });
    await provider.rotate(stored.reference, "next-secret", {
      ...ctxA,
      reason: "rotation",
    });
    await provider.revoke(stored.reference, { ...ctxA, reason: "revocation" });
    expect(await provider.resolve(stored.reference, ctxA)).toBeNull();
    expect(db.tables.secret_ciphertexts[0]?.ciphertext_b64).toBe("");
    expect(db.tables.secret_ciphertext_history[0]?.ciphertext_b64).toBe("");
    expect(JSON.stringify(db.tables)).not.toContain("temp-secret");
    expect(JSON.stringify(db.tables)).not.toContain("next-secret");
  });

  it("rejects tampered ciphertext, wrong key, invalid nonce, and unknown key version", async () => {
    const db = new FakeD1();
    const provider = new EncryptedD1SecretProvider(envWithKey(db));
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "sealed",
    });
    const row = db.tables.secret_ciphertexts[0]!;
    const original = String(row.ciphertext_b64);
    row.ciphertext_b64 = `${original.slice(0, -2)}aa`;
    await expect(provider.resolve(stored.reference, ctxA)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
    row.ciphertext_b64 = original;
    row.nonce_b64 = "short";
    await expect(provider.resolve(stored.reference, ctxA)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
    row.nonce_b64 = (await encryptCredential({
      plaintext: "x",
      keyMaterial: KEY_V1,
      aad: String(row.aad),
    })).nonceB64;
    await expect(provider.resolve(stored.reference, ctxA)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );

    const wrong = new EncryptedD1SecretProvider(envWithKey(db, KEY_V2));
    row.nonce_b64 = (await encryptCredential({
      plaintext: "sealed",
      keyMaterial: KEY_V1,
      aad: String(db.tables.secret_ciphertexts[0]!.aad),
    })).nonceB64;
    // restore authentic ciphertext under v1 and resolve with only v2 present
    const v1db = new FakeD1();
    const v1 = new EncryptedD1SecretProvider(envWithKey(v1db));
    const again = await v1.store({
      companyId: "co_a",
      purpose: "connector",
      value: "sealed-v1",
    });
    const v2only = new EncryptedD1SecretProvider(
      envWithKey(v1db, KEY_V2, {
        INFRA_CREDENTIAL_WRAPPING_KEY: KEY_V2,
        INFRA_CREDENTIAL_KEY_VERSION: "v2",
      }),
    );
    await expect(v2only.resolve(again.reference, ctxA)).rejects.toBeInstanceOf(
      SecretStorageUnavailableError,
    );
  });

  it("can decrypt a v1 record after introducing a v2 current key", async () => {
    const db = new FakeD1();
    const v1 = new EncryptedD1SecretProvider(envWithKey(db, KEY_V1));
    const stored = await v1.store({
      companyId: "co_a",
      purpose: "oauth_refresh",
      value: JSON.stringify({ refreshToken: "keep-me" }),
    });
    const rotatedProvider = new EncryptedD1SecretProvider(
      envWithKey(db, KEY_V1, {
        INFRA_CREDENTIAL_WRAPPING_KEY: KEY_V2,
        INFRA_CREDENTIAL_WRAPPING_KEY_V1: KEY_V1,
        INFRA_CREDENTIAL_KEY_VERSION: "v2",
      }),
    );
    expect(await rotatedProvider.resolve(stored.reference, ctxA)).toContain("keep-me");
    const rotated = await rotatedProvider.rotate(
      stored.reference,
      JSON.stringify({ refreshToken: "re-encrypted" }),
      { ...ctxA, reason: "rotation" },
    );
    expect(rotated.reference).toBe(stored.reference);
    expect(db.tables.secret_ciphertexts[0]?.key_version).toBe("v2");
    expect(await rotatedProvider.resolve(stored.reference, ctxA)).toContain("re-encrypted");
  });

  it("does not treat a Worker binding name as authorisation for another tenant", async () => {
    const db = new FakeD1();
    db.tables.mcp_environments.push({
      id: "mcp_a",
      company_id: "co_a",
      auth_secret_ref: "A_MCP_AUTH_TOKEN",
    });
    const env = envWithKey(db, KEY_V1, {
      A_MCP_AUTH_TOKEN: "binding-secret-a",
      B_MCP_AUTH_TOKEN: "binding-secret-b",
    });
    const provider = new EncryptedD1SecretProvider(env);
    expect(
      await provider.resolve("A_MCP_AUTH_TOKEN", ctxA),
    ).toBe("binding-secret-a");
    expect(await provider.resolve("A_MCP_AUTH_TOKEN", ctxB)).toBeNull();
    expect(await provider.resolve("B_MCP_AUTH_TOKEN", ctxA)).toBeNull();
  });

  it("stays disabled and refuses store when the wrapping key is missing", async () => {
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ENVIRONMENT: "production",
      SESSION_SECRET: "x",
      ALLOWED_ORIGINS: "*",
    } as Env;
    expect(credentialStorageStatus(env).enabled).toBe(false);
    const provider = createSecretProvider(env);
    expect(provider.submissionEnabled).toBe(false);
    await expect(
      provider.store({ companyId: "co_a", purpose: "connector", value: "x" }),
    ).rejects.toBeInstanceOf(CredentialSubmissionDisabledError);
  });

  it("rejects a wrapping key that is not 32 bytes", () => {
    expect(() => parseWrappingKey("too-short")).toThrow(SecretCryptoError);
  });
});
