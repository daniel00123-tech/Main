import type { ToolAction } from "@infra/shared";
import { BASE_AI_SERVICE_SCOPES } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";

export type ServiceIdentityType =
  | "chatgpt"
  | "claude"
  | "whatsapp"
  | "cursor_bridge"
  | "scheduled"
  | "automation"
  | "other";

export interface ServiceIdentityRecord {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  identityType: ServiceIdentityType;
  status: "active" | "disabled";
  tokenPrefix: string | null;
  hasToken: boolean;
  scopes: string[];
  mcpEnvironmentId: string | null;
  boundUserId?: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  createdAt: string;
  updatedAt: string;
}

function rowToIdentity(row: Record<string, unknown>): ServiceIdentityRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    identityType: String(row.identity_type ?? "other") as ServiceIdentityType,
    status: row.status as "active" | "disabled",
    tokenPrefix: row.token_prefix ? String(row.token_prefix) : null,
    hasToken: Boolean(row.token_hash),
    scopes: (() => {
      try {
        const parsed = JSON.parse(String(row.scopes_json ?? "[]"));
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    mcpEnvironmentId: row.mcp_environment_id
      ? String(row.mcp_environment_id)
      : null,
    boundUserId: row.bound_user_id ? String(row.bound_user_id) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    requestCount: Number(row.request_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashServiceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(digest);
}

export async function generateServiceToken(): Promise<{
  token: string;
  prefix: string;
  hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = `infra_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  return {
    token,
    prefix: token.slice(0, 12),
    hash: await hashServiceToken(token),
  };
}

export async function listServiceIdentities(db: D1Database, companyId: string) {
  const result = await db
    .prepare(
      `SELECT * FROM service_identities
       WHERE company_id = ?
       ORDER BY name ASC`,
    )
    .bind(companyId)
    .all();
  return (result.results ?? []).map((row) => rowToIdentity(row));
}

export async function getServiceIdentity(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM service_identities WHERE id = ?")
    .bind(id)
    .first();
  return row ? rowToIdentity(row) : null;
}

export async function createServiceIdentity(
  db: D1Database,
  input: {
    companyId: string;
    name: string;
    description?: string | null;
    identityType: ServiceIdentityType;
    scopes?: string[];
    mcpEnvironmentId?: string | null;
    boundUserId?: string | null;
  },
): Promise<{ identity: ServiceIdentityRecord; token: string }> {
  const id = newId("svc");
  const now = nowIso();
  const { token, prefix, hash } = await generateServiceToken();

  await db
    .prepare(
      `INSERT INTO service_identities (
        id, company_id, name, description, status, secret_ref,
        identity_type, token_hash, token_prefix, last_used_at, request_count,
        scopes_json, mcp_environment_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.name,
      input.description ?? null,
      input.identityType,
      hash,
      prefix,
      JSON.stringify(input.scopes ?? [...BASE_AI_SERVICE_SCOPES]),
      input.mcpEnvironmentId ?? null,
      now,
      now,
    )
    .run();

  const identity = await getServiceIdentity(db, id);
  if (!identity) throw new Error("Failed to create service identity");
  return { identity, token };
}

export async function rotateServiceIdentityToken(db: D1Database, id: string) {
  const existing = await getServiceIdentity(db, id);
  if (!existing) return null;

  const { token, prefix, hash } = await generateServiceToken();
  const now = nowIso();
  await db
    .prepare(
      `UPDATE service_identities
       SET token_hash = ?, token_prefix = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(hash, prefix, now, id)
    .run();

  const identity = await getServiceIdentity(db, id);
  return identity ? { identity, token } : null;
}

export async function setServiceIdentityStatus(
  db: D1Database,
  id: string,
  status: "active" | "disabled",
) {
  await db
    .prepare(
      `UPDATE service_identities SET status = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(status, nowIso(), id)
    .run();
  return getServiceIdentity(db, id);
}

export async function authenticateServiceToken(
  db: D1Database,
  bearerToken: string,
): Promise<ServiceIdentityRecord | null> {
  const token = bearerToken.trim();
  if (!token) return null;
  const hash = await hashServiceToken(token);
  const row = await db
    .prepare(
      `SELECT * FROM service_identities
       WHERE token_hash = ? AND status = 'active'`,
    )
    .bind(hash)
    .first();
  if (!row) return null;

  await db
    .prepare(
      `UPDATE service_identities
       SET last_used_at = ?, request_count = request_count + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(nowIso(), nowIso(), String(row.id))
    .run();

  return rowToIdentity(row);
}

export function serviceHasActionScope(
  identity: ServiceIdentityRecord,
  action: string,
): boolean {
  if (!identity.scopes.length) {
    return (
      action === "knowledge.search" ||
      action === "knowledge.read" ||
      action === "system.health"
    );
  }
  if (identity.scopes.includes("*")) return true;
  return identity.scopes.includes(action);
}

export async function evaluateServiceActionPermission(
  db: D1Database,
  identity: ServiceIdentityRecord,
  action: ToolAction | string,
): Promise<{ allowed: boolean; reason?: string; riskClass: string }> {
  if (identity.status !== "active") {
    return {
      allowed: false,
      reason: "Service identity disabled",
      riskClass: "high_risk",
    };
  }

  if (!serviceHasActionScope(identity, action)) {
    return {
      allowed: false,
      reason: "Action not in service identity scopes",
      riskClass: "high_risk",
    };
  }

  const grant = await db
    .prepare(
      `SELECT actions_json FROM permission_grants
       WHERE company_id = ? AND subject_type = 'service' AND subject_id = ?
         AND resource_type IN ('tool', 'mcp', 'knowledge')`,
    )
    .bind(identity.companyId, identity.id)
    .all();

  if ((grant.results ?? []).length > 0) {
    const allowedActions = new Set<string>();
    for (const row of grant.results ?? []) {
      try {
        const actions = JSON.parse(String(row.actions_json ?? "[]"));
        if (Array.isArray(actions)) {
          for (const a of actions) allowedActions.add(String(a));
        }
      } catch {
        // ignore
      }
    }
    if (allowedActions.has("*") || allowedActions.has(action)) {
      return { allowed: true, riskClass: "low_risk" };
    }
    return {
      allowed: false,
      reason: "Service permission grant does not include action",
      riskClass: "high_risk",
    };
  }

  return { allowed: true, riskClass: "low_risk" };
}
