import { describe, expect, it } from "vitest";
import {
  consumeOauthAuthorizationState,
  createOauthAuthorizationState,
} from "./connector-oauth";

type Row = Record<string, unknown>;

class MockStatement {
  constructor(
    private db: MemoryD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new MockStatement(this.db, this.sql, args);
  }
  async first() {
    return this.db.query(this.sql, this.binds)[0] ?? null;
  }
  async all() {
    return { results: this.db.query(this.sql, this.binds) };
  }
  async run() {
    this.db.exec(this.sql, this.binds);
    return { success: true };
  }
}

class MemoryD1 {
  tables: Record<string, Row[]> = { oauth_authorization_states: [] };
  prepare(sql: string) {
    return new MockStatement(this, sql);
  }
  query(sql: string, binds: unknown[]): Row[] {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("from oauth_authorization_states where state_hash")) {
      return this.tables.oauth_authorization_states.filter((r) => r.state_hash === binds[0]);
    }
    return [];
  }
  exec(sql: string, binds: unknown[]) {
    const q = sql.toLowerCase().replace(/\s+/g, " ");
    if (q.includes("insert into oauth_authorization_states")) {
      this.tables.oauth_authorization_states.push({
        id: binds[0],
        state_hash: binds[1],
        company_id: binds[2],
        connector_definition_id: binds[3],
        connector_instance_id: binds[4],
        user_id: binds[5],
        code_challenge: binds[6],
        code_challenge_method: "S256",
        redirect_uri: binds[7],
        scopes_json: binds[8],
        expires_at: binds[9],
        consumed_at: null,
        created_at: binds[10],
        code_verifier_nonce_b64: binds[11] ?? null,
        code_verifier_ciphertext_b64: binds[12] ?? null,
        return_path: binds[13] ?? null,
      });
    }
    if (q.includes("update oauth_authorization_states set consumed_at")) {
      const row = this.tables.oauth_authorization_states.find((r) => r.id === binds[1]);
      if (row) row.consumed_at = binds[0];
    }
  }
}

describe("oauth state binding", () => {
  it("rejects a guessed state and a cross-tenant callback", async () => {
    const db = new MemoryD1() as unknown as D1Database;
    const created = await createOauthAuthorizationState(db, {
      companyId: "co_a",
      userId: "user_a",
      definitionId: "conn_xero",
    });
    const guessed = await consumeOauthAuthorizationState(db, { state: "guessed" });
    expect(guessed.ok).toBe(false);
    const wrongCompany = await consumeOauthAuthorizationState(db, {
      state: created.state,
      companyId: "co_b",
    });
    expect(wrongCompany.ok).toBe(false);
    const ok = await consumeOauthAuthorizationState(db, {
      state: created.state,
      companyId: "co_a",
      userId: "user_a",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.companyId).toBe("co_a");
    const replay = await consumeOauthAuthorizationState(db, {
      state: created.state,
      companyId: "co_a",
    });
    expect(replay.ok).toBe(false);
  });

  it("rejects expired OAuth state", async () => {
    const db = new MemoryD1();
    const created = await createOauthAuthorizationState(db as unknown as D1Database, {
      companyId: "co_a",
      userId: "user_a",
      definitionId: "conn_xero",
    });
    const row = db.tables.oauth_authorization_states[0];
    if (row) row.expires_at = "2000-01-01T00:00:00.000Z";
    const expired = await consumeOauthAuthorizationState(db as unknown as D1Database, {
      state: created.state,
      companyId: "co_a",
      userId: "user_a",
    });
    expect(expired.ok).toBe(false);
  });

  it("never persists tokens on the authorization row", async () => {
    const db = new MemoryD1();
    await createOauthAuthorizationState(db as unknown as D1Database, {
      companyId: "co_a",
      userId: "user_a",
      definitionId: "conn_xero",
    });
    const row = db.tables.oauth_authorization_states[0];
    expect(row?.access_token).toBeUndefined();
    expect(row?.refresh_token).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("access_token");
  });
});
