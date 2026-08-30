import type { CompanyRole } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { generateSalt, hashPassword } from "./password";
import {
  createPasswordSetupToken,
} from "./password-setup";
import type { SessionMembership, SessionUser } from "./session";
import { credentialsVersionFromHash } from "./session";
import { MobileCollisionError, MobileValidationError, normalizeE164 } from "../services/phone";

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
  mobileE164: string | null;
  mobileVerified: boolean;
  mobileVerifiedAt: string | null;
  mobileVerificationRequired: boolean;
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
    mobileE164: row.mobile_e164 ? String(row.mobile_e164) : null,
    mobileVerified: Number(row.mobile_verified ?? 0) === 1,
    mobileVerifiedAt: row.mobile_verified_at ? String(row.mobile_verified_at) : null,
    mobileVerificationRequired: Number(row.mobile_verification_required ?? (row.mobile_e164 ? 0 : 1)) === 1,
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
    mobileE164: string | null;
    mobileVerified: boolean;
    mobileVerificationRequired: boolean;
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
      mobileE164: user.mobileE164,
      mobileVerified: user.mobileVerified,
      mobileVerificationRequired: user.mobileVerificationRequired,
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
    credentialsVersion: credentialsVersionFromHash(user.passwordHash),
  };
}

export async function setUserMobileE164(
  db: D1Database,
  userId: string,
  mobile: string,
): Promise<DbUser> {
  const mobileE164 = normalizeE164(mobile);
  const existingMobile = await getUserByMobileE164(db, mobileE164);
  if (existingMobile && existingMobile.id !== userId) {
    throw new MobileCollisionError();
  }
  const now = nowIso();
  await db
    .prepare(
      `UPDATE users
       SET mobile_e164 = ?, mobile_verified = 0, mobile_verified_at = NULL,
           mobile_verification_required = 0, updated_at = ?
       WHERE id = ?`,
    )
    .bind(mobileE164, now, userId)
    .run();
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("User not found");
  }
  return user;
}

export async function getUserByMobileE164(
  db: D1Database,
  mobileE164: string,
): Promise<DbUser | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE mobile_e164 = ?")
    .bind(mobileE164)
    .first();
  return row ? rowToUser(row) : null;
}

export async function createUser(
  db: D1Database,
  input: {
    email: string;
    displayName: string;
    password: string;
    isPlatformAdmin?: boolean;
    mobile?: string | null;
    requireMobile?: boolean;
  },
): Promise<DbUser> {
  const id = newId("user");
  const createdAt = nowIso();
  const salt = generateSalt();
  const passwordHash = await hashPassword(input.password, salt);
  const mobileE164 = input.requireMobile
    ? normalizeE164(input.mobile)
    : input.mobile
      ? normalizeE164(input.mobile)
      : null;

  if (mobileE164) {
    const existingMobile = await getUserByMobileE164(db, mobileE164);
    if (existingMobile) {
      throw new MobileCollisionError();
    }
  }

  await db
    .prepare(
      `INSERT INTO users
        (id, email, display_name, password_hash, password_salt, is_platform_admin, status, created_at, updated_at,
         mobile_e164, mobile_verified, mobile_verified_at, mobile_verification_required)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, NULL, ?)`,
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
      mobileE164,
      mobileE164 ? 0 : 1,
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

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  input: { displayName?: string; email?: string },
): Promise<DbUser> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("User not found");
  }
  let email = user.email;
  if (typeof input.email === "string" && input.email.trim()) {
    email = input.email.trim().toLowerCase();
    if (email !== user.email) {
      const collision = await getUserByEmail(db, email);
      if (collision && collision.id !== userId) {
        throw new Error("That email is already used by another Infra user");
      }
    }
  }
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim()
      : user.displayName;
  await db
    .prepare(`UPDATE users SET email = ?, display_name = ?, updated_at = ? WHERE id = ?`)
    .bind(email, displayName, nowIso(), userId)
    .run();
  const updated = await getUserById(db, userId);
  if (!updated) {
    throw new Error("User not found");
  }
  return updated;
}

export async function countActivePlatformAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM users WHERE is_platform_admin = 1 AND status = 'active'`)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function cancelPendingInvitationsForEmail(
  db: D1Database,
  email: string,
): Promise<number> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE user_invitations
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE email = ? AND status = 'pending'`,
    )
    .bind(now, now, email.trim().toLowerCase())
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function disableUserAccount(
  db: D1Database,
  userId: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?`)
    .bind(now, userId)
    .run();
  await db
    .prepare(
      `UPDATE company_memberships SET status = 'disabled', updated_at = ? WHERE user_id = ?`,
    )
    .bind(now, userId)
    .run();
  await db
    .prepare(
      `UPDATE user_invitations
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE email IN (SELECT email FROM users WHERE id = ?) AND status = 'pending'`,
    )
    .bind(now, now, userId)
    .run();
}

export async function enableUserAccount(
  db: D1Database,
  userId: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE users SET status = 'active', updated_at = ? WHERE id = ?`)
    .bind(now, userId)
    .run();
  await db
    .prepare(
      `UPDATE company_memberships SET status = 'active', updated_at = ? WHERE user_id = ?`,
    )
    .bind(now, userId)
    .run();
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
    mobile?: string | null;
  },
): Promise<{ user: DbUser; setupToken: string; expiresAt: string; created: boolean }> {
  const existing = await getUserByEmail(db, input.email);
  let user = existing;
  let created = false;

  if (!user) {
    if (!input.mobile) {
      throw new MobileValidationError(
        "Mobile number is required when creating a new user. Use international E.164 format, for example +447700900123",
      );
    }
    const tempPassword = `tmp_${crypto.randomUUID()}`;
    user = await createUser(db, {
      email: input.email,
      displayName: input.displayName,
      password: tempPassword,
      isPlatformAdmin: false,
      mobile: input.mobile,
      requireMobile: true,
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
