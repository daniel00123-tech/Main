import type { CompanyRole } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { generateSalt, hashPassword } from "./password";
import {
  createPasswordSetupToken,
} from "./password-setup";
import type { SessionMembership, SessionUser } from "./session";

export interface DbUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  isPlatformAdmin: boolean;
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbMembership {
  id: string;
  userId: string;
  companyId: string;
  role: CompanyRole;
  status: "active" | "disabled";
  teamId: string | null;
  customRoleId: string | null;
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
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
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
    teamId: row.team_id ? String(row.team_id) : null,
    customRoleId: row.custom_role_id ? String(row.custom_role_id) : null,
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
    lastLoginAt: string | null;
    memberships: Array<{ companyId: string; role: CompanyRole; status: string }>;
  }>
> {
  const usersResult = await db
    .prepare("SELECT * FROM users ORDER BY email ASC")
    .all();
  const users = (usersResult.results ?? []).map((row) => rowToUser(row));

  const membershipsResult = companyId
    ? await db
        .prepare("SELECT * FROM company_memberships WHERE company_id = ?")
        .bind(companyId)
        .all()
    : await db.prepare("SELECT * FROM company_memberships").all();
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
      lastLoginAt: user.lastLoginAt,
      memberships: (membershipByUser.get(user.id) ?? []).map((membership) => ({
        companyId: membership.companyId,
        role: membership.role,
        status: membership.status,
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
        customRoleId: membership.customRoleId,
        teamId: membership.teamId,
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

export async function setUserStatus(
  db: D1Database,
  userId: string,
  status: "active" | "disabled",
) {
  await db
    .prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, nowIso(), userId)
    .run();
  return getUserById(db, userId);
}

export async function updateMembershipRole(
  db: D1Database,
  userId: string,
  companyId: string,
  role: CompanyRole,
) {
  const updatedAt = nowIso();
  await db
    .prepare(
      `UPDATE company_memberships
       SET role = ?, updated_at = ?
       WHERE user_id = ? AND company_id = ?`,
    )
    .bind(role, updatedAt, userId, companyId)
    .run();

  const row = await db
    .prepare(
      `SELECT * FROM company_memberships WHERE user_id = ? AND company_id = ?`,
    )
    .bind(userId, companyId)
    .first();
  return row ? rowToMembership(row) : null;
}

export async function setMembershipStatus(
  db: D1Database,
  userId: string,
  companyId: string,
  status: "active" | "disabled",
) {
  await db
    .prepare(
      `UPDATE company_memberships
       SET status = ?, updated_at = ?
       WHERE user_id = ? AND company_id = ?`,
    )
    .bind(status, nowIso(), userId, companyId)
    .run();
}

export async function recordUserLogin(db: D1Database, userId: string) {
  await db
    .prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), nowIso(), userId)
    .run();
}

export async function inviteCompanyUser(
  db: D1Database,
  input: {
    email: string;
    displayName: string;
    companyId: string;
    role: CompanyRole;
  },
): Promise<{ user: DbUser; setupToken: string; expiresAt: string; created: boolean }> {
  const existing = await getUserByEmail(db, input.email);
  let user = existing;
  let created = false;

  if (!user) {
    // Temporary random password — user must complete setup token flow
    const tempPassword = `tmp_${crypto.randomUUID()}`;
    user = await createUser(db, {
      email: input.email,
      displayName: input.displayName,
      password: tempPassword,
      isPlatformAdmin: false,
    });
    created = true;
  }

  const membership = await db
    .prepare(
      `SELECT * FROM company_memberships WHERE user_id = ? AND company_id = ?`,
    )
    .bind(user.id, input.companyId)
    .first();

  if (!membership) {
    await createMembership(db, {
      userId: user.id,
      companyId: input.companyId,
      role: input.role,
    });
  } else {
    await updateMembershipRole(db, user.id, input.companyId, input.role);
    await setMembershipStatus(db, user.id, input.companyId, "active");
  }

  const setup = await createPasswordSetupToken(db, user.id, "password_setup");

  return {
    user,
    setupToken: setup.token,
    expiresAt: setup.expiresAt,
    created,
  };
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
