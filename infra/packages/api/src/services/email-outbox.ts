import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";

export type EmailTemplate = "user_invitation" | "password_reset" | "low_balance" | "auto_topup_failure";

export async function queueEmail(
  env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">,
  db: D1Database,
  input: {
    companyId?: string | null;
    toEmail: string;
    templateKey: EmailTemplate;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
  },
): Promise<{ id: string; sent: boolean; error?: string }> {
  const id = newId("email");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO email_outbox (
        id, company_id, to_email, template_key, subject, body_text, body_html, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(
      id,
      input.companyId ?? null,
      input.toEmail,
      input.templateKey,
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      now,
    )
    .run();

  const sendResult = await trySendEmail(env, {
    to: input.toEmail,
    subject: input.subject,
    text: input.bodyText,
    html: input.bodyHtml,
  });

  if (sendResult.sent) {
    await db
      .prepare(
        `UPDATE email_outbox SET status = 'sent', provider = ?, provider_message_id = ?, sent_at = ? WHERE id = ?`,
      )
      .bind(sendResult.provider ?? "none", sendResult.messageId ?? null, nowIso(), id)
      .run();
    return { id, sent: true };
  }

  await db
    .prepare(
      `UPDATE email_outbox SET status = 'queued', error_message = ? WHERE id = ?`,
    )
    .bind(sendResult.error ?? "No email provider configured", id)
    .run();

  return { id, sent: false, error: sendResult.error };
}

export async function trySendEmail(
  env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">,
  input: { to: string; subject: string; text: string; html?: string },
): Promise<{ sent: boolean; provider?: string; messageId?: string; error?: string }> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM ?? "INFRA <noreply@infra.local>";
  if (!apiKey) {
    return { sent: false, error: "RESEND_API_KEY not configured" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html ?? undefined,
    }),
  });

  const body = (await response.json()) as { id?: string; message?: string };
  if (!response.ok) {
    return { sent: false, error: body.message ?? "Email send failed" };
  }
  return { sent: true, provider: "resend", messageId: body.id };
}

export function renderInvitationEmail(input: {
  companyName: string;
  inviterName: string;
  setupUrl: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const subject = `You're invited to ${input.companyName} on INFRA`;
  const text = [
    `Hello,`,
    ``,
    `${input.inviterName} has invited you to join ${input.companyName} on INFRA.`,
    ``,
    `Set up your account (link expires ${input.expiresAt}):`,
    input.setupUrl,
    ``,
    `If you did not expect this invitation, you can ignore this email.`,
  ].join("\n");
  const html = `<p>Hello,</p><p><strong>${input.inviterName}</strong> has invited you to join <strong>${input.companyName}</strong> on INFRA.</p><p><a href="${input.setupUrl}">Set up your account</a></p><p><small>Link expires ${input.expiresAt}. If you did not expect this invitation, ignore this email.</small></p>`;
  return { subject, text, html };
}

export function renderPasswordResetEmail(input: {
  setupUrl: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const subject = "Reset your INFRA password";
  const text = [
    `We received a request to reset your INFRA password.`,
    ``,
    `Reset your password (link expires ${input.expiresAt}):`,
    input.setupUrl,
    ``,
    `If you did not request this, you can ignore this email.`,
  ].join("\n");
  const html = `<p>We received a request to reset your INFRA password.</p><p><a href="${input.setupUrl}">Reset password</a></p><p><small>Link expires ${input.expiresAt}.</small></p>`;
  return { subject, text, html };
}
