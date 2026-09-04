/**
 * Tenant-native Microsoft application identities (Option B).
 *
 * Each company may have its own Entra app registration. Shared INFRA code
 * stays identical; only configuration varies. Raw client secrets never enter D1
 * — only a Cloudflare secret binding name is stored.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";

export const MICROSOFT_PROVIDER = "microsoft";
export const SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID = "e5fd0533-ce51-43b8-999c-152f1e268246";
export const EL_NATIVE_MICROSOFT_DISPLAY_NAME = "INFRA - Elvex MCP";
export const EL_NATIVE_MICROSOFT_TENANT_ID = "af32e619-3647-44a2-85d9-1c45457c0e91";
export const EL_NATIVE_MICROSOFT_CLIENT_ID = "f8ec6a91-f043-4f63-8800-64135af48c4e";
export const EL_NATIVE_MICROSOFT_SECRET_BINDING = "EL_MS_CLIENT_SECRET";
export const EL_NATIVE_MICROSOFT_SECRET_ALIASES = ["EL_MICROSOFT_CLIENT_SECRET"] as const;
export const EL_NATIVE_MICROSOFT_TENANT_BINDINGS = ["EL_MS_TENANT_ID", "EL_MICROSOFT_TENANT_ID"] as const;
export const EL_NATIVE_MICROSOFT_CLIENT_BINDINGS = ["EL_MS_CLIENT_ID", "EL_MICROSOFT_CLIENT_ID"] as const;

export type MicrosoftTenantIdentityRow = {
  id: string;
  company_id: string;
  provider: string;
  display_name: string | null;
  tenant_id: string;
  client_id: string;
  secret_binding: string;
  auth_mode: string;
  active: number;
  configured_at: string;
  last_token_success: string | null;
  last_error: string | null;
};

export type ResolvedMicrosoftTenantIdentity = {
  companyId: string;
  provider: string;
  displayName: string;
  tenantId: string;
  clientId: string;
  secretBinding: string;
  authMode: string;
  active: boolean;
  configuredAt: string;
  lastTokenSuccess: string | null;
  lastError: string | null;
  secretPresent: boolean;
  clientSecret: string | null;
};

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function envString(env: Env, name: string): string {
  return trim((env as Record<string, unknown>)[name]);
}

export function elNativeMicrosoftPublicIds(env?: Env): { tenantId: string; clientId: string; displayName: string } {
  const resolved = env ?? ({} as Env);
  return {
    tenantId:
      envString(resolved, "EL_MS_TENANT_ID") ||
      envString(resolved, "EL_MICROSOFT_TENANT_ID") ||
      EL_NATIVE_MICROSOFT_TENANT_ID,
    clientId:
      envString(resolved, "EL_MS_CLIENT_ID") ||
      envString(resolved, "EL_MICROSOFT_CLIENT_ID") ||
      EL_NATIVE_MICROSOFT_CLIENT_ID,
    displayName:
      envString(resolved, "EL_MICROSOFT_APP_DISPLAY_NAME") || EL_NATIVE_MICROSOFT_DISPLAY_NAME,
  };
}

export function readSecretBinding(env: Env, binding: string, aliases: readonly string[] = []): string | null {
  const names = [binding, ...aliases];
  for (const name of names) {
    const value = envString(env, name);
    if (value) return value;
  }
  return null;
}

export function elNativeSecretPresent(env: Env): boolean {
  return Boolean(readSecretBinding(env, EL_NATIVE_MICROSOFT_SECRET_BINDING, EL_NATIVE_MICROSOFT_SECRET_ALIASES));
}

export function auditMicrosoftBindingNames(env: Env): {
  globalTenantBinding: "MICROSOFT_TENANT_ID";
  globalClientBinding: "MICROSOFT_CLIENT_ID";
  globalSecretBinding: "MICROSOFT_CLIENT_SECRET";
  globalTenantPresent: boolean;
  globalClientPresent: boolean;
  globalSecretPresent: boolean;
  elTenantBinding: "EL_MS_TENANT_ID";
  elClientBinding: "EL_MS_CLIENT_ID";
  elSecretBinding: "EL_MS_CLIENT_SECRET";
  elSecretBindings: string[];
  EL_TENANT_PRESENT: "YES" | "NO";
  EL_CLIENT_PRESENT: "YES" | "NO";
  EL_SECRET_PRESENT: "YES" | "NO";
  globalClientId: string | null;
  globalTenantId: string | null;
  elClientId: string | null;
  elTenantId: string | null;
} {
  const el = elNativeMicrosoftPublicIds(env);
  const elTenantBound = Boolean(envString(env, "EL_MS_TENANT_ID") || envString(env, "EL_MICROSOFT_TENANT_ID"));
  const elClientBound = Boolean(envString(env, "EL_MS_CLIENT_ID") || envString(env, "EL_MICROSOFT_CLIENT_ID"));
  return {
    globalTenantBinding: "MICROSOFT_TENANT_ID",
    globalClientBinding: "MICROSOFT_CLIENT_ID",
    globalSecretBinding: "MICROSOFT_CLIENT_SECRET",
    globalTenantPresent: Boolean(envString(env, "MICROSOFT_TENANT_ID")),
    globalClientPresent: Boolean(envString(env, "MICROSOFT_CLIENT_ID")),
    globalSecretPresent: Boolean(envString(env, "MICROSOFT_CLIENT_SECRET")),
    elTenantBinding: "EL_MS_TENANT_ID",
    elClientBinding: "EL_MS_CLIENT_ID",
    elSecretBinding: "EL_MS_CLIENT_SECRET",
    elSecretBindings: [EL_NATIVE_MICROSOFT_SECRET_BINDING, ...EL_NATIVE_MICROSOFT_SECRET_ALIASES],
    EL_TENANT_PRESENT: elTenantBound ? "YES" : "NO",
    EL_CLIENT_PRESENT: elClientBound ? "YES" : "NO",
    EL_SECRET_PRESENT: elNativeSecretPresent(env) ? "YES" : "NO",
    globalClientId: envString(env, "MICROSOFT_CLIENT_ID") || null,
    globalTenantId: envString(env, "MICROSOFT_TENANT_ID") || null,
    elClientId: el.clientId,
    elTenantId: el.tenantId,
  };
}

export async function ensureMicrosoftTenantIdentitiesSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS microsoft_tenant_identities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'microsoft',
        display_name TEXT,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        secret_binding TEXT NOT NULL,
        auth_mode TEXT NOT NULL DEFAULT 'client_credentials',
        active INTEGER NOT NULL DEFAULT 1,
        configured_at TEXT NOT NULL,
        last_token_success TEXT,
        last_error TEXT,
        UNIQUE(company_id, provider)
      )`,
    )
    .run();
}

export async function seedElNativeMicrosoftIdentity(env: Env, db: D1Database): Promise<MicrosoftTenantIdentityRow> {
  await ensureMicrosoftTenantIdentitiesSchema(db);
  const now = nowIso();
  const el = elNativeMicrosoftPublicIds(env);
  const existing = await db
    .prepare(
      `SELECT * FROM microsoft_tenant_identities
       WHERE company_id = ? AND provider = ? LIMIT 1`,
    )
    .bind("co_el", MICROSOFT_PROVIDER)
    .first<MicrosoftTenantIdentityRow>();

  if (!existing?.id) {
    const id = "mti_co_el_microsoft";
    await db
      .prepare(
        `INSERT INTO microsoft_tenant_identities (
          id, company_id, provider, display_name, tenant_id, client_id, secret_binding,
          auth_mode, active, configured_at, last_token_success, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'client_credentials', 1, ?, NULL, NULL)`,
      )
      .bind(
        id,
        "co_el",
        MICROSOFT_PROVIDER,
        el.displayName,
        el.tenantId,
        el.clientId,
        EL_NATIVE_MICROSOFT_SECRET_BINDING,
        now,
      )
      .run();
    return (await db
      .prepare(`SELECT * FROM microsoft_tenant_identities WHERE id = ?`)
      .bind(id)
      .first<MicrosoftTenantIdentityRow>())!;
  }

  const shouldRepair =
    !existing.active ||
    existing.client_id === SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID ||
    existing.client_id !== el.clientId ||
    existing.tenant_id !== el.tenantId ||
    existing.secret_binding !== EL_NATIVE_MICROSOFT_SECRET_BINDING;
  if (shouldRepair) {
    await db
      .prepare(
        `UPDATE microsoft_tenant_identities
         SET display_name = ?, tenant_id = ?, client_id = ?, secret_binding = ?,
             auth_mode = 'client_credentials', active = 1, configured_at = ?
         WHERE id = ?`,
      )
      .bind(
        el.displayName,
        el.tenantId,
        el.clientId,
        EL_NATIVE_MICROSOFT_SECRET_BINDING,
        existing.configured_at || now,
        existing.id,
      )
      .run();
    return (await db
      .prepare(`SELECT * FROM microsoft_tenant_identities WHERE id = ?`)
      .bind(existing.id)
      .first<MicrosoftTenantIdentityRow>())!;
  }

  return existing;
}

function hydrateIdentity(
  env: Env,
  row: Pick<
    MicrosoftTenantIdentityRow,
    "company_id" | "provider" | "display_name" | "tenant_id" | "client_id" | "secret_binding" | "auth_mode" | "active" | "configured_at" | "last_token_success" | "last_error"
  >,
): ResolvedMicrosoftTenantIdentity {
  const el = row.company_id === "co_el" ? elNativeMicrosoftPublicIds(env) : null;
  const aliases =
    row.company_id === "co_el"
      ? EL_NATIVE_MICROSOFT_SECRET_ALIASES
      : [];
  const secretBinding =
    row.company_id === "co_el" ? EL_NATIVE_MICROSOFT_SECRET_BINDING : row.secret_binding || EL_NATIVE_MICROSOFT_SECRET_BINDING;
  const clientSecret = readSecretBinding(env, secretBinding, aliases);
  return {
    companyId: row.company_id,
    provider: row.provider,
    displayName: row.display_name || el?.displayName || elNativeMicrosoftPublicIds(env).displayName,
    tenantId: el?.tenantId || row.tenant_id,
    clientId: el?.clientId || row.client_id,
    secretBinding,
    authMode: row.auth_mode || "client_credentials",
    active: row.active !== 0,
    configuredAt: row.configured_at,
    lastTokenSuccess: row.last_token_success,
    lastError: row.last_error,
    secretPresent: Boolean(clientSecret),
    clientSecret,
  };
}

function fallbackElIdentity(env: Env): ResolvedMicrosoftTenantIdentity {
  const el = elNativeMicrosoftPublicIds(env);
  return hydrateIdentity(env, {
    company_id: "co_el",
    provider: MICROSOFT_PROVIDER,
    display_name: el.displayName,
    tenant_id: el.tenantId,
    client_id: el.clientId,
    secret_binding: EL_NATIVE_MICROSOFT_SECRET_BINDING,
    auth_mode: "client_credentials",
    active: 1,
    configured_at: "2026-09-04T21:00:00.000Z",
    last_token_success: null,
    last_error: null,
  });
}

export async function loadMicrosoftTenantIdentity(
  env: Env,
  db: D1Database,
  companyId: string,
): Promise<ResolvedMicrosoftTenantIdentity | null> {
  if (!companyId) return null;
  try {
    await ensureMicrosoftTenantIdentitiesSchema(db);
    if (companyId === "co_el") {
      await seedElNativeMicrosoftIdentity(env, db).catch(() => fallbackElIdentity(env));
    }
    const row = await db
      .prepare(
        `SELECT * FROM microsoft_tenant_identities
         WHERE company_id = ? AND provider = ? AND active = 1
         LIMIT 1`,
      )
      .bind(companyId, MICROSOFT_PROVIDER)
      .first<MicrosoftTenantIdentityRow>();
    if (row) return hydrateIdentity(env, row);
  } catch {
    /* incomplete test D1 or missing table — fall through */
  }
  if (companyId === "co_el") return fallbackElIdentity(env);
  return null;
}

export async function recordMicrosoftTenantIdentityTokenResult(
  db: D1Database,
  companyId: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  await ensureMicrosoftTenantIdentitiesSchema(db);
  const now = nowIso();
  if (result.ok) {
    await db
      .prepare(
        `UPDATE microsoft_tenant_identities
         SET last_token_success = ?, last_error = NULL
         WHERE company_id = ? AND provider = ?`,
      )
      .bind(now, companyId, MICROSOFT_PROVIDER)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE microsoft_tenant_identities
       SET last_error = ?
       WHERE company_id = ? AND provider = ?`,
    )
    .bind(result.error.slice(0, 500), companyId, MICROSOFT_PROVIDER)
    .run();
}

export function isSharedBusinessConnectorClientId(clientId: string | null | undefined): boolean {
  return trim(clientId) === SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID;
}

export async function upsertMicrosoftTenantIdentity(
  db: D1Database,
  input: {
    companyId: string;
    tenantId: string;
    clientId: string;
    secretBinding: string;
    displayName?: string | null;
    authMode?: string;
    active?: boolean;
  },
): Promise<MicrosoftTenantIdentityRow> {
  await ensureMicrosoftTenantIdentitiesSchema(db);
  const now = nowIso();
  const existing = await db
    .prepare(
      `SELECT * FROM microsoft_tenant_identities
       WHERE company_id = ? AND provider = ? LIMIT 1`,
    )
    .bind(input.companyId, MICROSOFT_PROVIDER)
    .first<MicrosoftTenantIdentityRow>();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE microsoft_tenant_identities
         SET display_name = ?, tenant_id = ?, client_id = ?, secret_binding = ?,
             auth_mode = ?, active = ?, configured_at = COALESCE(configured_at, ?)
         WHERE id = ?`,
      )
      .bind(
        input.displayName ?? existing.display_name,
        input.tenantId,
        input.clientId,
        input.secretBinding,
        input.authMode ?? existing.auth_mode ?? "client_credentials",
        input.active === false ? 0 : 1,
        now,
        existing.id,
      )
      .run();
    return (await db
      .prepare(`SELECT * FROM microsoft_tenant_identities WHERE id = ?`)
      .bind(existing.id)
      .first<MicrosoftTenantIdentityRow>())!;
  }
  const id = newId("mti");
  await db
    .prepare(
      `INSERT INTO microsoft_tenant_identities (
        id, company_id, provider, display_name, tenant_id, client_id, secret_binding,
        auth_mode, active, configured_at, last_token_success, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      input.companyId,
      MICROSOFT_PROVIDER,
      input.displayName ?? null,
      input.tenantId,
      input.clientId,
      input.secretBinding,
      input.authMode ?? "client_credentials",
      input.active === false ? 0 : 1,
      now,
    )
    .run();
  return (await db
    .prepare(`SELECT * FROM microsoft_tenant_identities WHERE id = ?`)
    .bind(id)
    .first<MicrosoftTenantIdentityRow>())!;
}
