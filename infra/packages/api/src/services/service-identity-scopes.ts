import {
  BASE_AI_SERVICE_SCOPES,
  mergeServiceIdentityScopes,
  XERO_READ_SERVICE_SCOPES,
} from "@infra/shared";
import { nowIso } from "../db/mappers";

export async function isXeroConnectedForCompany(
  db: D1Database,
  companyId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM connector_instances
       WHERE company_id = ?
         AND connector_definition_id = 'conn_xero'
         AND auth_status = 'connected'
         AND status NOT IN ('draft', 'disabled')
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  return Boolean(row);
}

export async function resolveServiceIdentityScopesForCompany(
  db: D1Database,
  companyId: string,
): Promise<string[]> {
  const scopes = [...BASE_AI_SERVICE_SCOPES];
  if (await isXeroConnectedForCompany(db, companyId)) {
    scopes.push(...XERO_READ_SERVICE_SCOPES);
  }
  return mergeServiceIdentityScopes(scopes);
}

/** Refresh scopes on all active service identities when connector capabilities change. */
export async function syncActiveServiceIdentityScopesForCompany(
  db: D1Database,
  companyId: string,
): Promise<{ updated: number; scopes: string[] }> {
  const scopes = await resolveServiceIdentityScopesForCompany(db, companyId);
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE service_identities
       SET scopes_json = ?, updated_at = ?
       WHERE company_id = ? AND status = 'active'`,
    )
    .bind(JSON.stringify(scopes), now, companyId)
    .run();
  return {
    updated: Number(result.meta?.changes ?? 0),
    scopes,
  };
}
