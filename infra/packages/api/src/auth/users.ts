import type { CompanyRole } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { generateSalt, hashPassword } from "./password";
import type { SessionMembership, SessionUser } from "./session";

export interface DbUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  isPlatformAdmin: boolean;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface DbMembership {
  id: string;
  userId: string;
  companyId: string;
  role: CompanyRole;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

function rowToUser(row: Record<string, unknown>): DbUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    isPlatformAdmin: Boolean(row.is_platform_admin),
    status: row.status as DbUser["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToMembership(row: Record<string, unknown>): DbMembership {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    companyId: String(row.company_id),
    role: row.role as CompanyRole,
    status: row.status as DbMembership["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM users").first();
  return Number(row?.count ?? 0);
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<DbUser | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
    .bind(email.trim())
    .first();
  return row ? rowToUser(row) : null;
}

export async function getUserById(
  db: D1Database,
  userId: string,
): Promise<DbUser | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return row ? rowToUser(row) : null;
}

export async function listMembershipsForUser(
  db: D1Database,
  userId: string,
): Promise<DbMembership[]> {
  const result = await db
    .prepare(
      "SELECT * FROM company_memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC",
    )
    .bind(userId)
    .all();

  return (result.results ?? []).map((row) => rowToMembership(row));
}

export async function listUsers(
  db: D1Database,
  companyId?: string,
): Promise<
  Array<{
    id: string;
    email: string;
    displayName: string;
    isPlatformAdmin: boolean;
    status: string;
    memberships: Array<{ companyId: string; role: CompanyRole }>;
  }>
> {
  const usersResult = await db
    .prepare("SELECT * FROM users ORDER BY email ASC")
    .all();
  const users = (usersResult.results ?? []).map((row) => rowToUser(row));

  const membershipsResult = await db
    .prepare("SELECT * FROM company_memberships WHERE status = 'active'")
    .all();
  const memberships = (membershipsResult.results ?? []).map((row) =>
    rowToMembership(row),
  );

  const membershipByUser = new Map<string, DbMembership[]>();
  for (const membership of memberships) {
    const existing = membershipByUser.get(membership.userId) ?? [];
    existing.push(membership);
    membershipByUser.set(membership.userId, existing);
  }

  return users
    .map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isPlatformAdmin: user.isPlatformAdmin,
      status: user.status,
      memberships: (membershipByUser.get(user.id) ?? []).map((membership) => ({
        companyId: membership.companyId,
        role: membership.role,
      })),
    }))
    .filter((user) => {
      if (!companyId) return true;
      return user.memberships.some(
        (membership) => membership.companyId === companyId,
      );
    });
}

export async function toSessionUser(
  db: D1Database,
  user: DbUser,
): Promise<SessionUser> {
  const memberships = await listMembershipsForUser(db, user.id);
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    isPlatformAdmin: user.isPlatformAdmin,
    memberships: memberships.map(
      (membership): SessionMembership => ({
        companyId: membership.companyId,
        role: membership.role,
      }),
    ),
  };
}

export async function createUser(
  db: D1Database,
  input: {
    email: string;
    displayName: string;
    password: string;
    isPlatformAdmin?: boolean;
  },
): Promise<DbUser> {
  const id = newId("user");
  const createdAt = nowIso();
  const salt = generateSalt();
  const passwordHash = await hashPassword(input.password, salt);

  await db
    .prepare(
      `INSERT INTO users
        (id, email, display_name, password_hash, password_salt, is_platform_admin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      id,
      input.email.trim().toLowerCase(),
      input.displayName,
      passwordHash,
      salt,
      input.isPlatformAdmin ? 1 : 0,
      createdAt,
      createdAt,
    )
    .run();

  const user = await getUserById(db, id);
  if (!user) {
    throw new Error("Failed to create user");
  }
  return user;
}

export async function createMembership(
  db: D1Database,
  input: {
    userId: string;
    companyId: string;
    role: CompanyRole;
  },
): Promise<DbMembership> {
  const id = newId("membership");
  const createdAt = nowIso();

  await db
    .prepare(
      `INSERT INTO company_memberships
        (id, user_id, company_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(id, input.userId, input.companyId, input.role, createdAt, createdAt)
    .run();

  const row = await db
    .prepare("SELECT * FROM company_memberships WHERE id = ?")
    .bind(id)
    .first();

  if (!row) {
    throw new Error("Failed to create membership");
  }

  return rowToMembership(row);
}

export async function updateUserPassword(
  db: D1Database,
  userId: string,
  password: string,
): Promise<void> {
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const updatedAt = nowIso();

  await db
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(passwordHash, salt, updatedAt, userId)
    .run();
}

export async function bootstrapPlatformAdminIfNeeded(
  db: D1Database,
  email: string | undefined,
  password: string | undefined,
): Promise<boolean> {
  if (!email || !password) return false;

  const existingCount = await countUsers(db);
  if (existingCount > 0) return false;

  await createUser(db, {
    email,
    displayName: "Platform Administrator",
    password,
    isPlatformAdmin: true,
  });

  return true;
}
