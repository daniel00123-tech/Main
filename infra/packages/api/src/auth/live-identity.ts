import type { CompanyRole } from "@infra/shared";
import type { SessionUser } from "./session";

export type LiveCompanyActor = {
  userId: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  companyId: string;
  membershipId: string;
  role: CompanyRole;
  customRoleId: string | null;
  teamId: string | null;
  userStatus: "active" | "disabled";
  membershipStatus: "active" | "disabled";
  active: boolean;
  denyReason: string | null;
};

export async function loadLiveCompanyActor(
  db: D1Database,
  userId: string,
  companyId: string,
): Promise<LiveCompanyActor | null> {
  const row = await db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.email,
         u.display_name,
         u.is_platform_admin,
         u.status AS user_status,
         m.id AS membership_id,
         m.company_id,
         m.role,
         m.status AS membership_status,
         m.custom_role_id,
         m.team_id
       FROM company_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? AND m.company_id = ?`,
    )
    .bind(userId, companyId)
    .first();

  if (!row) return null;

  const userStatus = String(row.user_status) === "disabled" ? "disabled" : "active";
  const membershipStatus =
    String(row.membership_status) === "disabled" ? "disabled" : "active";
  let denyReason: string | null = null;
  if (userStatus !== "active") denyReason = "User is disabled";
  else if (membershipStatus !== "active") denyReason = "Company membership is disabled";

  return {
    userId: String(row.user_id),
    email: String(row.email),
    displayName: String(row.display_name),
    isPlatformAdmin: Boolean(row.is_platform_admin),
    companyId: String(row.company_id),
    membershipId: String(row.membership_id),
    role: String(row.role) as CompanyRole,
    customRoleId: row.custom_role_id ? String(row.custom_role_id) : null,
    teamId: row.team_id ? String(row.team_id) : null,
    userStatus,
    membershipStatus,
    active: denyReason == null,
    denyReason,
  };
}

export function liveActorToSessionUser(actor: LiveCompanyActor): SessionUser {
  return {
    userId: actor.userId,
    email: actor.email,
    displayName: actor.displayName,
    isPlatformAdmin: actor.isPlatformAdmin,
    memberships: [
      {
        companyId: actor.companyId,
        role: actor.role,
        customRoleId: actor.customRoleId,
        teamId: actor.teamId,
        membershipId: actor.membershipId,
      },
    ],
  };
}
