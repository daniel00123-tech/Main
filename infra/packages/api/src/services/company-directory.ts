import type { CompanyPerson } from "./intelligence/outlook-args.js";

export async function loadCompanyDirectory(db: D1Database, companyId: string): Promise<CompanyPerson[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT u.display_name AS displayName, u.email AS email
         FROM users u
         JOIN company_memberships m ON m.user_id = u.id
         WHERE m.company_id = ?
           AND COALESCE(m.status, 'active') = 'active'
           AND u.email IS NOT NULL
           AND TRIM(u.email) != ''`,
      )
      .bind(companyId)
      .all<{ displayName: string | null; email: string | null }>();
    return (rows.results ?? [])
      .map((row) => ({
        displayName: String(row.displayName ?? "").trim(),
        email: String(row.email ?? "").trim().toLowerCase(),
      }))
      .filter((row) => row.email.includes("@"));
  } catch {
    return [];
  }
}
