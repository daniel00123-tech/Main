import { newId, nowIso } from "../db/mappers";
import type { CompanyRole } from "@infra/shared";
import { inviteCompanyUser } from "../auth/users";
import { queueEmail, renderInvitationEmail } from "./email-outbox";
import { recordAuditEvent } from "./control-plane";
import type { Env } from "../env";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function findActiveInvitation(
  db: D1Database,
  companyId: string,
  email: string,
) {
  const normalised = email.trim().toLowerCase();
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

  const invited = await inviteCompanyUser(env.DB, {
    email: input.email,
    displayName: input.displayName,
    companyId: input.companyId,
    role: input.role,
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
      input.email.trim().toLowerCase(),
      input.displayName.trim(),
      input.role,
      input.teamId ?? null,
      input.customRoleId ?? null,
      input.invitedBy,
      invited.user.id,
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
    detail: { email: input.email, emailSent: emailResult.sent },
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

export async function listCompanyInvitations(db: D1Database, companyId: string) {
  const rows = await db
    .prepare(
      `SELECT * FROM user_invitations WHERE company_id = ?
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(companyId)
    .all();

  const now = nowIso();
  return (rows.results ?? []).map((row) => {
    const expired = row.status === "pending" && String(row.expires_at) < now;
    return {
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      role: String(row.role),
      status: expired ? "expired" : String(row.status),
      invitedBy: String(row.invited_by),
      sentAt: row.sent_at ? String(row.sent_at) : null,
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
    };
  });
}

export async function cancelInvitation(db: D1Database, companyId: string, invitationId: string) {
  const now = nowIso();
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
    `SELECT * FROM user_invitations WHERE id = ? AND company_id = ? AND status IN ('pending', 'expired')`,
  )
    .bind(input.invitationId, input.companyId)
    .first();
  if (!row) throw new Error("INVITATION_NOT_FOUND");

  const invited = await inviteCompanyUser(env.DB, {
    email: String(row.email),
    displayName: String(row.display_name),
    companyId: input.companyId,
    role: row.role as CompanyRole,
  });

  const now = nowIso();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const setupUrl = `${input.origin}/setup-password?token=${encodeURIComponent(invited.setupToken)}`;

  await env.DB.prepare(
    `UPDATE user_invitations SET status = 'pending', sent_at = ?, expires_at = ?, updated_at = ?, setup_token_id = ?
     WHERE id = ?`,
  )
    .bind(now, expiresAt, now, invited.user.id, input.invitationId)
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
