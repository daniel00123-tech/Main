import { newId, nowIso } from "../db/mappers";
import type { CompanyRole } from "@infra/shared";

export async function listCompanyTeams(db: D1Database, companyId: string) {
  const rows = await db
    .prepare(
      `SELECT t.*, (
         SELECT COUNT(*) FROM company_team_members m WHERE m.team_id = t.id
       ) AS member_count
       FROM company_teams t
       WHERE t.company_id = ? AND t.status = 'active'
       ORDER BY t.name ASC`,
    )
    .bind(companyId)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    defaultRole: String(row.default_role) as CompanyRole,
    status: String(row.status),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function createCompanyTeam(
  db: D1Database,
  input: {
    companyId: string;
    name: string;
    description?: string | null;
    defaultRole?: CompanyRole;
  },
) {
  const id = newId("team");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO company_teams (
        id, company_id, name, description, default_role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.name.trim(),
      input.description ?? null,
      input.defaultRole ?? "office_staff",
      now,
      now,
    )
    .run();
  return { id, name: input.name.trim() };
}

export async function addTeamMember(
  db: D1Database,
  input: { teamId: string; userId: string; role?: CompanyRole | null },
) {
  const id = newId("teammember");
  await db
    .prepare(
      `INSERT INTO company_team_members (id, team_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(id, input.teamId, input.userId, input.role ?? null, nowIso())
    .run();

  const team = await db
    .prepare(`SELECT company_id FROM company_teams WHERE id = ?`)
    .bind(input.teamId)
    .first();
  if (team) {
    await db
      .prepare(`UPDATE company_memberships SET team_id = ? WHERE user_id = ? AND company_id = ?`)
      .bind(input.teamId, input.userId, team.company_id)
      .run();
  }
}

export async function removeTeamMember(db: D1Database, teamId: string, userId: string) {
  await db
    .prepare(`DELETE FROM company_team_members WHERE team_id = ? AND user_id = ?`)
    .bind(teamId, userId)
    .run();
}

export async function archiveCompanyTeam(db: D1Database, teamId: string, companyId: string) {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE company_teams SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(now, now, teamId, companyId)
    .run();
}
