/**
 * Resolve a person-name sender against live company directory rows.
 * Never invent an address. 0 or >1 matches stay unresolved.
 */

export type DirectorySender = {
  email: string;
  displayName: string;
};

export async function resolveDirectorySenders(
  db: D1Database,
  companyId: string,
  hint: string,
): Promise<DirectorySender[]> {
  const token = hint.trim();
  if (token.length < 2) return [];
  const like = `%${token.toLowerCase()}%`;
  try {
    const rows = await db
      .prepare(
        `SELECT u.email, u.display_name
         FROM users u
         JOIN company_memberships m ON m.user_id = u.id
         WHERE m.company_id = ?
           AND m.status = 'active'
           AND u.status = 'active'
           AND (
             lower(u.display_name) LIKE ?
             OR lower(u.email) LIKE ?
           )
         ORDER BY u.display_name
         LIMIT 8`,
      )
      .bind(companyId, like, like)
      .all<{ email: string; display_name: string }>();
    return (rows.results ?? [])
      .map((row) => ({
        email: String(row.email ?? "").trim().toLowerCase(),
        displayName: String(row.display_name ?? "").trim(),
      }))
      .filter((row) => row.email.includes("@"));
  } catch {
    return [];
  }
}

export function applyResolvedSender(
  args: Record<string, unknown>,
  matches: DirectorySender[],
): { args: Record<string, unknown>; clarification?: string } {
  if (matches.length > 1) {
    const names = matches.map((row) => `${row.displayName} <${row.email}>`).join(", ");
    return {
      args,
      clarification: `There is more than one matching person (${names}). Which mailbox sender did you mean?`,
    };
  }
  if (matches.length === 1) {
    const email = matches[0]!.email;
    const query = String(args.query ?? "").trim();
    return {
      args: {
        ...args,
        from: email,
        sender: email,
        query: query && !query.toLowerCase().includes(email) ? `${query} ${email}`.trim() : query || email,
      },
    };
  }
  return { args };
}
