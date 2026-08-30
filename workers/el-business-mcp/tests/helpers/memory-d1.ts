type Row = Record<string, unknown>;

function clone(row: Row): Row {
  return { ...row };
}

export function createMemoryD1() {
  const tables: Record<string, Row[]> = {
    company_users: [],
    company_service_principals: [],
    content_classifications: [],
    permission_audit_log: [],
    oauth_clients: [],
    oauth_authorize_states: [],
    oauth_authorization_codes: [],
    oauth_refresh_tokens: [],
  };

  function table(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...args: unknown[]) {
        return {
          async first() {
            return query(normalized, args, "first");
          },
          async all() {
            const results = query(normalized, args, "all");
            return { results: Array.isArray(results) ? results : results ? [results] : [] };
          },
          async run() {
            query(normalized, args, "run");
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }

  function query(sql: string, args: unknown[], mode: "first" | "all" | "run"): Row | Row[] | null {
    if (sql.startsWith("INSERT INTO company_users")) {
      const row: Row = {
        id: args[0],
        company_id: args[1],
        external_id: args[2],
        microsoft_oid: args[3],
        email: args[4],
        display_name: args[5],
        role: args[6],
        status: args[7],
        created_at: args[8],
        updated_at: args[9],
        last_activity_at: null,
      };
      const rows = table("company_users");
      const existing = rows.find((item) => item.id === row.id);
      if (existing) {
        existing.external_id = row.external_id ?? existing.external_id;
        existing.microsoft_oid = row.microsoft_oid ?? existing.microsoft_oid;
        existing.email = row.email;
        existing.display_name = row.display_name;
        existing.role = row.role;
        existing.status = row.status;
        existing.updated_at = row.updated_at;
      } else {
        rows.push(row);
      }
      return null;
    }
    if (sql.startsWith("INSERT INTO oauth_clients")) {
      table("oauth_clients").push({
        client_id: args[0],
        client_name: args[1],
        redirect_uris_json: args[2],
        token_endpoint_auth_method: args[3],
        client_secret_hash: args[4],
        grant_types_json: args[5],
        response_types_json: args[6],
        created_at: args[7],
      });
      return null;
    }
    if (sql.startsWith("INSERT INTO oauth_authorize_states")) {
      table("oauth_authorize_states").push({
        id: args[0],
        client_id: args[1],
        redirect_uri: args[2],
        client_state: args[3],
        code_challenge: args[4],
        code_challenge_method: args[5],
        scope: args[6],
        resource: args[7],
        expires_at: args[8],
        created_at: args[9],
      });
      return null;
    }
    if (sql.startsWith("INSERT INTO oauth_authorization_codes")) {
      table("oauth_authorization_codes").push({
        code_hash: args[0],
        client_id: args[1],
        redirect_uri: args[2],
        code_challenge: args[3],
        code_challenge_method: args[4],
        oid: args[5],
        email: args[6],
        display_name: args[7],
        resource: args[8],
        scope: args[9],
        expires_at: args[10],
        used_at: null,
        created_at: args[11],
      });
      return null;
    }
    if (sql.startsWith("INSERT INTO oauth_refresh_tokens")) {
      table("oauth_refresh_tokens").push({
        token_hash: args[0],
        client_id: args[1],
        oid: args[2],
        email: args[3],
        display_name: args[4],
        resource: args[5],
        scope: args[6],
        expires_at: args[7],
        revoked_at: null,
        created_at: args[8],
      });
      return null;
    }
    if (sql.startsWith("INSERT INTO permission_audit_log") || sql.includes("INTO permission_audit_log")) {
      table("permission_audit_log").push({ sql, args });
      return null;
    }
    if (sql.startsWith("INSERT INTO company_service_principals")) {
      table("company_service_principals").push({
        id: args[0],
        company_id: args[1],
        email: args[2],
        display_name: args[3],
        capabilities_json: args[4],
        status: args[5],
      });
      return null;
    }

    if (sql.startsWith("UPDATE company_users SET role")) {
      const row = table("company_users").find((item) => item.id === args[2]);
      if (row) {
        row.role = args[0];
        row.updated_at = args[1];
      }
      return null;
    }
    if (sql.startsWith("UPDATE company_users SET status")) {
      const row = table("company_users").find((item) => item.id === args[2]);
      if (row) {
        row.status = args[0];
        row.updated_at = args[1];
      }
      return null;
    }
    if (sql.startsWith("UPDATE company_users") && sql.includes("microsoft_oid")) {
      const row = table("company_users").find((item) => item.id === args[2]);
      if (row) {
        row.microsoft_oid = args[0];
        row.updated_at = args[1];
      }
      return null;
    }
    if (sql.startsWith("UPDATE oauth_authorization_codes SET used_at")) {
      const row = table("oauth_authorization_codes").find((item) => item.code_hash === args[1]);
      if (row) row.used_at = args[0];
      return null;
    }
    if (sql.startsWith("UPDATE oauth_refresh_tokens SET revoked_at")) {
      const row = table("oauth_refresh_tokens").find((item) => item.token_hash === args[1]);
      if (row) row.revoked_at = args[0];
      return null;
    }
    if (sql.startsWith("DELETE FROM oauth_authorize_states")) {
      tables.oauth_authorize_states = table("oauth_authorize_states").filter((item) => item.id !== args[0]);
      return null;
    }

    if (sql.includes("FROM company_users WHERE company_id = ? AND microsoft_oid = ?")) {
      return table("company_users").find((item) => item.company_id === args[0] && item.microsoft_oid === args[1]) ?? null;
    }
    if (sql.includes("FROM company_users WHERE company_id = ? AND external_id = ?")) {
      return table("company_users").find((item) => item.company_id === args[0] && item.external_id === args[1]) ?? null;
    }
    if (sql.includes("FROM company_users WHERE company_id = ? AND lower(email)")) {
      return (
        table("company_users").find(
          (item) => item.company_id === args[0] && String(item.email).toLowerCase() === String(args[1]).toLowerCase()
        ) ?? null
      );
    }
    if (sql.includes("FROM company_users WHERE id = ? AND company_id = ?")) {
      return table("company_users").find((item) => item.id === args[0] && item.company_id === args[1]) ?? null;
    }
    if (sql.includes("FROM company_users WHERE id = ?")) {
      return table("company_users").find((item) => item.id === args[0]) ?? null;
    }
    if (sql.includes("FROM company_users WHERE company_id = ? ORDER BY")) {
      return table("company_users").filter((item) => item.company_id === args[0]).map(clone);
    }
    if (sql.includes("FROM oauth_clients WHERE client_id = ?")) {
      return table("oauth_clients").find((item) => item.client_id === args[0]) ?? null;
    }
    if (sql.includes("FROM oauth_authorize_states WHERE id = ?")) {
      return table("oauth_authorize_states").find((item) => item.id === args[0]) ?? null;
    }
    if (sql.includes("FROM oauth_authorization_codes WHERE code_hash = ?")) {
      return table("oauth_authorization_codes").find((item) => item.code_hash === args[0]) ?? null;
    }
    if (sql.includes("FROM oauth_refresh_tokens WHERE token_hash = ?")) {
      return table("oauth_refresh_tokens").find((item) => item.token_hash === args[0]) ?? null;
    }
    if (sql.includes("FROM company_service_principals WHERE id = ?")) {
      return table("company_service_principals").find((item) => item.id === args[0] && item.company_id === args[1]) ?? null;
    }
    if (sql.includes("FROM content_classifications")) {
      return mode === "all" ? [] : null;
    }
    if (mode === "all") return [];
    return null;
  }

  return {
    prepare,
    dump: tables,
  } as unknown as D1Database & { dump: typeof tables };
}
