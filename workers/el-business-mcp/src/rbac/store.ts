import { ELVEX_COMPANY_ID } from "./actor";
import { isElvexRole, type ElvexRole } from "./roles";
import { isDataClassification, type DataClassification } from "./classify";

export type CompanyUserRow = {
  id: string;
  companyId: string;
  externalId: string | null;
  microsoftOid: string | null;
  email: string;
  displayName: string | null;
  role: ElvexRole;
  status: "active" | "disabled";
  lastActivityAt: string | null;
};

export type ServicePrincipalRow = {
  id: string;
  companyId: string;
  email: string | null;
  displayName: string | null;
  capabilities: string[];
  status: "active" | "disabled";
};

export type ClassificationRow = {
  id: string;
  companyId: string;
  itemKey: string;
  classification: DataClassification;
  source: "explicit" | "directory";
  pathPattern: string | null;
  flaggedTerms: string | null;
  updatedBy: string | null;
};

export async function listCompanyUsers(db: D1Database): Promise<CompanyUserRow[]> {
  const result = await db
    .prepare(
      `SELECT id, company_id, external_id, microsoft_oid, email, display_name, role, status, last_activity_at
       FROM company_users WHERE company_id = ? ORDER BY display_name, email`
    )
    .bind(ELVEX_COMPANY_ID)
    .all();
  return (result.results ?? []).map(mapUser);
}

export async function getUserByExternalId(db: D1Database, externalId: string): Promise<CompanyUserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, external_id, microsoft_oid, email, display_name, role, status, last_activity_at
       FROM company_users WHERE company_id = ? AND external_id = ?`
    )
    .bind(ELVEX_COMPANY_ID, externalId)
    .first();
  return row ? mapUser(row) : null;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<CompanyUserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, external_id, microsoft_oid, email, display_name, role, status, last_activity_at
       FROM company_users WHERE company_id = ? AND lower(email) = lower(?)`
    )
    .bind(ELVEX_COMPANY_ID, email.trim())
    .first();
  return row ? mapUser(row) : null;
}

export async function getUserById(db: D1Database, userId: string): Promise<CompanyUserRow | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, external_id, microsoft_oid, email, display_name, role, status, last_activity_at
       FROM company_users WHERE id = ? AND company_id = ?`
    )
    .bind(userId, ELVEX_COMPANY_ID)
    .first();
  return row ? mapUser(row) : null;
}

export async function getUserByMicrosoftOid(db: D1Database, microsoftOid: string): Promise<CompanyUserRow | null> {
  const oid = microsoftOid.trim();
  const byOid = await db
    .prepare(
      `SELECT id, company_id, external_id, microsoft_oid, email, display_name, role, status, last_activity_at
       FROM company_users WHERE company_id = ? AND microsoft_oid = ?`
    )
    .bind(ELVEX_COMPANY_ID, oid)
    .first();
  if (byOid) return mapUser(byOid);
  return getUserByExternalId(db, oid);
}

export async function upsertCompanyUser(
  db: D1Database,
  input: {
    id?: string;
    externalId?: string | null;
    microsoftOid?: string | null;
    email: string;
    displayName?: string | null;
    role: ElvexRole;
    status?: "active" | "disabled";
  }
): Promise<CompanyUserRow> {
  const existing = input.microsoftOid
    ? await getUserByMicrosoftOid(db, input.microsoftOid)
    : input.externalId
      ? await getUserByExternalId(db, input.externalId)
      : await getUserByEmail(db, input.email);
  const id = existing?.id ?? input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO company_users (
         id, company_id, external_id, microsoft_oid, email, display_name, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         external_id = COALESCE(excluded.external_id, company_users.external_id),
         microsoft_oid = COALESCE(excluded.microsoft_oid, company_users.microsoft_oid),
         email = excluded.email,
         display_name = excluded.display_name,
         role = excluded.role,
         status = excluded.status,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      ELVEX_COMPANY_ID,
      input.externalId ?? existing?.externalId ?? null,
      input.microsoftOid ?? existing?.microsoftOid ?? null,
      input.email.trim().toLowerCase(),
      input.displayName ?? existing?.displayName ?? null,
      input.role,
      input.status ?? existing?.status ?? "active",
      now,
      now
    )
    .run();
  const saved = await getUserByEmail(db, input.email);
  if (!saved) throw new Error("Failed to persist company user");
  return saved;
}

export async function updateUserRole(
  db: D1Database,
  userId: string,
  role: ElvexRole
): Promise<CompanyUserRow | null> {
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE company_users SET role = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .bind(role, now, userId, ELVEX_COMPANY_ID)
    .run();
  return getUserById(db, userId);
}

export async function updateUserStatus(
  db: D1Database,
  userId: string,
  status: "active" | "disabled"
): Promise<CompanyUserRow | null> {
  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE company_users SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .bind(status, now, userId, ELVEX_COMPANY_ID)
    .run();
  return getUserById(db, userId);
}

export async function bindUserMicrosoftOid(
  db: D1Database,
  userId: string,
  microsoftOid: string
): Promise<CompanyUserRow | null> {
  const existing = await getUserByMicrosoftOid(db, microsoftOid);
  if (existing && existing.id !== userId) {
    throw new Error("This Microsoft identity is already bound to another EL user.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE company_users
       SET microsoft_oid = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`
    )
    .bind(microsoftOid, now, userId, ELVEX_COMPANY_ID)
    .run();
  return getUserById(db, userId);
}

export async function getServicePrincipal(db: D1Database, id: string): Promise<ServicePrincipalRow | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, email, display_name, capabilities_json, status
       FROM company_service_principals WHERE id = ? AND company_id = ?`
    )
    .bind(id, ELVEX_COMPANY_ID)
    .first();
  if (!row) return null;
  let capabilities: string[] = [];
  try {
    capabilities = JSON.parse(String(row.capabilities_json ?? "[]")) as string[];
  } catch {
    capabilities = [];
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    email: row.email ? String(row.email) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    capabilities,
    status: String(row.status) === "disabled" ? "disabled" : "active",
  };
}

export async function listClassifications(db: D1Database): Promise<ClassificationRow[]> {
  const result = await db
    .prepare(
      `SELECT id, company_id, item_key, classification, source, path_pattern, flagged_terms, updated_by
       FROM content_classifications WHERE company_id = ? ORDER BY updated_at DESC`
    )
    .bind(ELVEX_COMPANY_ID)
    .all();
  return (result.results ?? []).map(mapClassification);
}

export async function getClassification(
  db: D1Database,
  itemKey: string
): Promise<ClassificationRow | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, item_key, classification, source, path_pattern, flagged_terms, updated_by
       FROM content_classifications WHERE company_id = ? AND item_key = ?`
    )
    .bind(ELVEX_COMPANY_ID, itemKey)
    .first();
  return row ? mapClassification(row) : null;
}

export async function listDirectoryClassifications(db: D1Database): Promise<ClassificationRow[]> {
  const result = await db
    .prepare(
      `SELECT id, company_id, item_key, classification, source, path_pattern, flagged_terms, updated_by
       FROM content_classifications
       WHERE company_id = ? AND source = 'directory' AND path_pattern IS NOT NULL`
    )
    .bind(ELVEX_COMPANY_ID)
    .all();
  return (result.results ?? []).map(mapClassification);
}

export async function upsertClassification(
  db: D1Database,
  input: {
    itemKey: string;
    classification: DataClassification;
    source: "explicit" | "directory";
    pathPattern?: string | null;
    flaggedTerms?: string | null;
    updatedBy?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO content_classifications (
         id, company_id, item_key, classification, source, path_pattern, flagged_terms, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, item_key) DO UPDATE SET
         classification = excluded.classification,
         source = excluded.source,
         path_pattern = excluded.path_pattern,
         flagged_terms = excluded.flagged_terms,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      ELVEX_COMPANY_ID,
      input.itemKey,
      input.classification,
      input.source,
      input.pathPattern ?? null,
      input.flaggedTerms ?? null,
      input.updatedBy ?? null,
      now,
      now
    )
    .run();
}

function mapUser(row: Record<string, unknown>): CompanyUserRow {
  const role = String(row.role);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    externalId: row.external_id ? String(row.external_id) : null,
    microsoftOid: row.microsoft_oid ? String(row.microsoft_oid) : null,
    email: String(row.email),
    displayName: row.display_name ? String(row.display_name) : null,
    role: isElvexRole(role) ? role : "engineer",
    status: String(row.status) === "disabled" ? "disabled" : "active",
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
  };
}

function mapClassification(row: Record<string, unknown>): ClassificationRow {
  const classification = String(row.classification);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    itemKey: String(row.item_key),
    classification: isDataClassification(classification) ? classification : "company_general",
    source: String(row.source) === "directory" ? "directory" : "explicit",
    pathPattern: row.path_pattern ? String(row.path_pattern) : null,
    flaggedTerms: row.flagged_terms ? String(row.flagged_terms) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}
