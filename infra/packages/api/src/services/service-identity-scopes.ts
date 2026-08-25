import {
  BASE_AI_SERVICE_SCOPES,
  serviceIdentityScopesWithXeroRead,
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
  if (await isXeroConnectedForCompany(db, companyId)) {
    return serviceIdentityScopesWithXeroRead();
  }
  return [...BASE_AI_SERVICE_SCOPES];
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
