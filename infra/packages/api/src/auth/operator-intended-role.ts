import type { CompanyRole } from "@infra/shared";
import { nowIso } from "../db/mappers";

export const WILLIAM_EL_USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
export const WILLIAM_EL_MEMBERSHIP_ID = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
export const WILLIAM_INTENDED_ROLE: CompanyRole = "director";

export async function ensureMembershipOperatorRolesTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS membership_operator_roles (
         membership_id TEXT PRIMARY KEY,
         company_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         intended_role TEXT NOT NULL,
         set_by TEXT NOT NULL,
         set_at TEXT NOT NULL
       )`,
    )
    .run();
}

export async function persistOperatorIntendedRole(
  db: D1Database,
  input: {
    membershipId: string;
    companyId: string;
    userId: string;
    intendedRole: CompanyRole;
    setBy: string;
  },
): Promise<void> {
  await ensureMembershipOperatorRolesTable(db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO membership_operator_roles
        (membership_id, company_id, user_id, intended_role, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.membershipId,
      input.companyId,
      input.userId,
      input.intendedRole,
      input.setBy,
      nowIso(),
    )
    .run();
}

export async function readOperatorIntendedRole(
  db: D1Database,
  membershipId: string,
): Promise<CompanyRole | null> {
  await ensureMembershipOperatorRolesTable(db);
  const row = await db
    .prepare(`SELECT intended_role FROM membership_operator_roles WHERE membership_id = ?`)
    .bind(membershipId)
    .first();
  return row?.intended_role ? (String(row.intended_role) as CompanyRole) : null;
}

export async function restoreOperatorIntendedRole(
  db: D1Database,
  input: { membershipId: string; userId: string; companyId: string; fallback?: CompanyRole },
): Promise<CompanyRole | null> {
  const intended =
    (await readOperatorIntendedRole(db, input.membershipId)) ?? input.fallback ?? null;
  if (!intended) return null;
  await db
    .prepare(
      `UPDATE company_memberships
       SET role = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND company_id = ?`,
    )
    .bind(intended, nowIso(), input.membershipId, input.userId, input.companyId)
    .run();
  return intended;
}
