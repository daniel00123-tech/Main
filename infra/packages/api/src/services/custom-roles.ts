import { newId, nowIso } from "../db/mappers";
import type { ToolAction } from "@infra/shared";
import { resolvePresetPermissions } from "../permissions/service";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export async function listCustomRoles(db: D1Database, companyId: string) {
  const rows = await db
    .prepare(
      `SELECT * FROM company_custom_roles
       WHERE company_id = ? AND status = 'active'
       ORDER BY name ASC`,
    )
    .bind(companyId)
    .all();

  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    clonedFrom: row.cloned_from ? String(row.cloned_from) : null,
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

export async function createCustomRole(
  db: D1Database,
  input: {
    companyId: string;
    name: string;
    description?: string | null;
    cloneFromRole?: string;
    grants?: Array<{ action: ToolAction; effect: "allow" | "deny" }>;
  },
) {
  const baseSlug = slugify(input.name);
  let slug = baseSlug;
  let suffix = 1;
  while (true) {
    const existing = await db
      .prepare(`SELECT id FROM company_custom_roles WHERE company_id = ? AND slug = ?`)
      .bind(input.companyId, slug)
      .first();
    if (!existing) break;
    slug = `${baseSlug}-${suffix++}`;
  }

  const id = newId("crole");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO company_custom_roles (
        id, company_id, name, slug, description, cloned_from, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.name.trim(),
      slug,
      input.description ?? null,
      input.cloneFromRole ?? null,
      now,
      now,
    )
    .run();

  const baseActions = input.cloneFromRole
    ? resolvePresetPermissions(input.cloneFromRole as never)
    : [];
  const grants =
    input.grants ??
    baseActions.map((action) => ({ action, effect: "allow" as const }));

  for (const grant of grants) {
    await db
      .prepare(
        `INSERT INTO company_custom_role_grants (id, custom_role_id, action, effect)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(newId("cgrant"), id, grant.action, grant.effect)
      .run();
  }

  return { id, slug, name: input.name.trim() };
}

export async function listCustomRoleGrants(db: D1Database, customRoleId: string) {
  const rows = await db
    .prepare(`SELECT action, effect FROM company_custom_role_grants WHERE custom_role_id = ?`)
    .bind(customRoleId)
    .all();
  return (rows.results ?? []).map((row) => ({
    action: String(row.action) as ToolAction,
    effect: String(row.effect) as "allow" | "deny",
  }));
}

export async function archiveCustomRole(db: D1Database, companyId: string, roleId: string) {
  const assigned = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM company_memberships
       WHERE company_id = ? AND custom_role_id = ? AND status = 'active'`,
    )
    .bind(companyId, roleId)
    .first();
  if (Number(assigned?.count ?? 0) > 0) {
    throw new Error("ROLE_IN_USE");
  }
  await db
    .prepare(
      `UPDATE company_custom_roles SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(nowIso(), nowIso(), roleId, companyId)
    .run();
}
