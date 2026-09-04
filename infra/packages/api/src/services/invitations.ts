import { newId, nowIso } from "../db/mappers";
import type { CompanyRole } from "@infra/shared";
import { getUserByEmail, getUserById, inviteCompanyUser } from "../auth/users";
import { queueEmail, renderInvitationEmail } from "./email-outbox";
import { recordAuditEvent } from "./control-plane";
import type { Env } from "../env";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationStatus = "pending" | "accepted" | "expired" | "cancelled";

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invitationError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export async function findActiveInvitation(
  db: D1Database,
  companyId: string,
  email: string,
) {
  const normalised = normalizeInviteEmail(email);
  const now = nowIso();
  return db
    .prepare(
      `SELECT * FROM user_invitations
       WHERE company_id = ? AND email = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(companyId, normalised, now)
    .first();
}

export async function createCompanyInvitation(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    companySlug: string;
    email: string;
    displayName: string;
    role: CompanyRole;
    invitedBy: string;
    inviterName: string;
    teamId?: string | null;
    customRoleId?: string | null;
    origin: string;
    mobile?: string | null;
  },
) {
  const existingInvite = await findActiveInvitation(env.DB, input.companyId, input.email);
  if (existingInvite) {
    const err = new Error("DUPLICATE_ACTIVE_INVITATION") as Error & {
      code: string;
      invitationId: string;
    };
    err.code = "DUPLICATE_ACTIVE_INVITATION";
    err.invitationId = String(existingInvite.id);
    throw err;
  }

  const existingUser = await getUserByEmail(env.DB, input.email);
  if (existingUser) {
    const membership = await env.DB.prepare(
      `SELECT id FROM company_memberships WHERE user_id = ? AND company_id = ?`,
    )
      .bind(existingUser.id, input.companyId)
      .first();
    if (membership) {
      const err = new Error(
        "This person already has an account in this company. Edit their details instead of sending another invitation email.",
      ) as Error & { code: string };
      err.code = "USER_ALREADY_MEMBER";
      throw err;
    }
  }

  const invited = await inviteCompanyUser(env.DB, {
    email: input.email,
    displayName: input.displayName,
    companyId: input.companyId,
    role: input.role,
    mobile: input.mobile,
  });

  const inviteId = newId("inv");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const setupUrl = `${input.origin}/setup-password?token=${encodeURIComponent(invited.setupToken)}`;

  await env.DB.prepare(
    `INSERT INTO user_invitations (
      id, company_id, email, display_name, role, team_id, custom_role_id,
      status, invited_by, setup_token_id, sent_at, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      inviteId,
      input.companyId,
      normalizeInviteEmail(input.email),
      input.displayName.trim(),
      input.role,
      input.teamId ?? null,
      input.customRoleId ?? null,
      input.invitedBy,
      invited.setupTokenId,
      now,
      expiresAt,
      now,
      now,
    )
    .run();

  const emailContent = renderInvitationEmail({
    companyName: input.companyName,
    inviterName: input.inviterName,
    setupUrl,
    expiresAt: new Date(expiresAt).toLocaleDateString("en-GB"),
  });

  const emailResult = await queueEmail(env, env.DB, {
    companyId: input.companyId,
    toEmail: input.email.trim(),
    templateKey: "user_invitation",
    subject: emailContent.subject,
    bodyText: emailContent.text,
    bodyHtml: emailContent.html,
  });

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: emailResult.sent ? "invitation.sent" : "invitation.queued",
    actor: input.invitedBy,
    resourceType: "user_invitation",
    resourceId: inviteId,
    detail: { email: normalizeInviteEmail(input.email), emailSent: emailResult.sent },
  });

  return {
    invitationId: inviteId,
    user: invited.user,
    setupUrl,
    setupToken: invited.setupToken,
    expiresAt,
    emailSent: emailResult.sent,
    emailError: emailResult.error,
  };
}

function derivedInvitationStatus(row: Record<string, unknown>, now: string): InvitationStatus {
  const status = String(row.status) as InvitationStatus;
  if (status === "pending" && String(row.expires_at) < now) return "expired";
  if (status === "accepted" || status === "cancelled" || status === "expired" || status === "pending") {
    return status;
  }
  return "pending";
}

function mapInvitationRow(row: Record<string, unknown>, now: string) {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role),
    status: derivedInvitationStatus(row, now),
    invitedBy: String(row.invited_by),
    sentAt: row.sent_at ? String(row.sent_at) : null,
    expiresAt: String(row.expires_at),
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    createdAt: String(row.created_at),
  };
}

async function markInvitationAccepted(
  db: D1Database,
  invitationId: string,
  actor: string,
  reason: string,
  eventType: "invitation.accepted" | "invitation.reconciled" = "invitation.accepted",
): Promise<boolean> {
  const now = nowIso();
  const existing = await db
    .prepare(`SELECT * FROM user_invitations WHERE id = ?`)
    .bind(invitationId)
    .first();
  if (!existing || String(existing.status) === "accepted") return false;
  if (String(existing.status) !== "pending" && String(existing.status) !== "expired") {
    return false;
  }

  const result = await db
    .prepare(
      `UPDATE user_invitations
       SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('pending', 'expired')`,
    )
    .bind(now, now, invitationId)
    .run();
  const changed = Number(result.meta?.changes ?? 0) > 0;
  if (changed) {
    await recordAuditEvent(db, {
      companyId: String(existing.company_id),
      eventType,
      actor,
      resourceType: "user_invitation",
      resourceId: invitationId,
      detail: {
        email: String(existing.email),
        reason,
        previousStatus: String(existing.status),
      },
    });
  }
  return changed;
}

/**
 * After the invite-controlled password setup succeeds, mark matching pending
 * invitations accepted. Membership/role already exist from invite send.
 */
export async function acceptPendingInvitationsAfterOnboarding(
  db: D1Database,
  userId: string,
  options?: { actor?: string; reason?: string },
): Promise<string[]> {
  const user = await getUserById(db, userId);
  if (!user) return [];
  const email = normalizeInviteEmail(user.email);
  const rows = await db
    .prepare(
      `SELECT i.id
       FROM user_invitations i
       INNER JOIN company_memberships m
         ON m.company_id = i.company_id AND m.user_id = ?
       WHERE i.email = ? AND i.status IN ('pending', 'expired') AND m.status = 'active'`,
    )
    .bind(userId, email)
    .all();

  const accepted: string[] = [];
  for (const row of rows.results ?? []) {
    const id = String(row.id);
    const changed = await markInvitationAccepted(
      db,
      id,
      options?.actor ?? user.email,
      options?.reason ?? "password_setup_completed",
      "invitation.accepted",
    );
    if (changed) accepted.push(id);
  }
  return accepted;
}

function hasOnboardingEvidence(input: {
  lastLoginAt: string | null;
  usedSetupToken: boolean;
}): boolean {
  return Boolean(input.lastLoginAt) || input.usedSetupToken;
}

/**
 * Repair historical pending invites only when the same email + company has an
 * active user, active membership, and clear onboarding evidence.
 * Does not accept unused invites merely because invite-send created a user row.
 */
export async function reconcileStalePendingInvitations(
  db: D1Database,
  companyId: string,
  actor = "system",
): Promise<string[]> {
  const pending = await db
    .prepare(
      `SELECT * FROM user_invitations
       WHERE company_id = ? AND status = 'pending'`,
    )
    .bind(companyId)
    .all();

  const reconciled: string[] = [];
  for (const row of pending.results ?? []) {
    const email = normalizeInviteEmail(String(row.email));
    const user = await getUserByEmail(db, email);
    if (!user || user.status !== "active") continue;
    if (normalizeInviteEmail(user.email) !== email) continue;

    const membership = await db
      .prepare(
        `SELECT id, status FROM company_memberships
         WHERE user_id = ? AND company_id = ? AND status = 'active'`,
      )
      .bind(user.id, companyId)
      .first();
    if (!membership) continue;

    const usedToken = await db
      .prepare(
        `SELECT id FROM password_setup_tokens
         WHERE user_id = ? AND purpose = 'password_setup' AND used_at IS NOT NULL
         LIMIT 1`,
      )
      .bind(user.id)
      .first();

    if (!hasOnboardingEvidence({ lastLoginAt: user.lastLoginAt, usedSetupToken: Boolean(usedToken) })) {
      continue;
    }

    const changed = await markInvitationAccepted(
      db,
      String(row.id),
      actor,
      "stale_pending_with_completed_onboarding",
      "invitation.reconciled",
    );
    if (changed) reconciled.push(String(row.id));
  }
  return reconciled;
}

export async function listCompanyInvitations(db: D1Database, companyId: string) {
  await reconcileStalePendingInvitations(db, companyId, "invitation.list");

  const rows = await db
    .prepare(
      `SELECT * FROM user_invitations WHERE company_id = ?
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(companyId)
    .all();

  const now = nowIso();
  return (rows.results ?? []).map((row) => mapInvitationRow(row, now));
}

export async function cancelInvitation(db: D1Database, companyId: string, invitationId: string) {
  const row = await db
    .prepare(`SELECT * FROM user_invitations WHERE id = ? AND company_id = ?`)
    .bind(invitationId, companyId)
    .first();
  if (!row) throw invitationError("INVITATION_NOT_FOUND", "Invitation not found");

  const now = nowIso();
  const status = derivedInvitationStatus(row, now);
  if (status === "accepted") {
    throw invitationError(
      "INVITATION_ALREADY_ACCEPTED",
      "This invitation has already been accepted. Use user or membership actions to change access.",
    );
  }
  if (status !== "pending") {
    throw invitationError("INVITATION_NOT_PENDING", "Only pending invitations can be cancelled.");
  }

  await db
    .prepare(
      `UPDATE user_invitations SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ? AND status = 'pending'`,
    )
    .bind(now, now, invitationId, companyId)
    .run();
}

export async function resendInvitation(
  env: Env,
  input: {
    companyId: string;
    companyName: string;
    invitationId: string;
    inviterName: string;
    origin: string;
  },
) {
  const row = await env.DB.prepare(
    `SELECT * FROM user_invitations WHERE id = ? AND company_id = ?`,
  )
    .bind(input.invitationId, input.companyId)
    .first();
  if (!row) throw invitationError("INVITATION_NOT_FOUND", "Invitation not found");

  const now = nowIso();
  const status = derivedInvitationStatus(row, now);
  if (status === "accepted") {
    throw invitationError(
      "INVITATION_ALREADY_ACCEPTED",
      "This invitation has already been accepted and cannot be resent.",
    );
  }
  if (status === "cancelled") {
    throw invitationError("INVITATION_CANCELLED", "A cancelled invitation cannot be resent.");
  }
  if (status !== "pending" && status !== "expired") {
    throw invitationError("INVITATION_NOT_PENDING", "Only pending or expired invitations can be resent.");
  }

  const invited = await inviteCompanyUser(env.DB, {
    email: String(row.email),
    displayName: String(row.display_name),
    companyId: input.companyId,
    role: row.role as CompanyRole,
  });

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const setupUrl = `${input.origin}/setup-password?token=${encodeURIComponent(invited.setupToken)}`;

  await env.DB.prepare(
    `UPDATE user_invitations SET status = 'pending', sent_at = ?, expires_at = ?, updated_at = ?, setup_token_id = ?
     WHERE id = ?`,
  )
    .bind(now, expiresAt, now, invited.setupTokenId, input.invitationId)
    .run();

  const emailContent = renderInvitationEmail({
    companyName: input.companyName,
    inviterName: input.inviterName,
    setupUrl,
    expiresAt: new Date(expiresAt).toLocaleDateString("en-GB"),
  });

  const emailResult = await queueEmail(env, env.DB, {
    companyId: input.companyId,
    toEmail: String(row.email),
    templateKey: "user_invitation",
    subject: emailContent.subject,
    bodyText: emailContent.text,
    bodyHtml: emailContent.html,
  });

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "invitation.resent",
    actor: input.inviterName,
    resourceType: "user_invitation",
    resourceId: input.invitationId,
    detail: { emailSent: emailResult.sent },
  });

  return { setupUrl, expiresAt, emailSent: emailResult.sent, emailError: emailResult.error };
}
