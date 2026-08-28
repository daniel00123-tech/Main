import type { TransactionalEmailType } from "@infra/shared";
import {
  renderUserInvitationEmail as renderSharedInvitationEmail,
  renderPasswordResetEmail as renderSharedPasswordResetEmail,
  renderTestEmail as renderSharedTestEmail,
} from "@infra/shared";
import { sendTransactionalEmail } from "./email/send-transactional";

export type EmailTemplate = "user_invitation" | "password_reset" | "low_balance" | "auto_topup_failure";

const LEGACY_TO_TYPE: Record<EmailTemplate, TransactionalEmailType | null> = {
  user_invitation: "USER_INVITATION",
  password_reset: "PASSWORD_RESET",
  low_balance: null,
  auto_topup_failure: null,
};

/** @deprecated Use sendTransactionalEmail directly. */
export async function queueEmail(
  env: import("../env").Env,
  db: D1Database,
  input: {
    companyId?: string | null;
    toEmail: string;
    templateKey: EmailTemplate;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    actor?: string;
  },
): Promise<{ id: string; sent: boolean; error?: string }> {
  const emailType = LEGACY_TO_TYPE[input.templateKey];
  if (!emailType || !input.companyId) {
    return {
      id: "email_skipped",
      sent: false,
      error: input.companyId ? "Template not supported by transactional email service" : "companyId required",
    };
  }

  const result = await sendTransactionalEmail(env, db, {
    companyId: input.companyId,
    type: emailType,
    recipient: input.toEmail,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml ?? input.bodyText,
    actor: input.actor,
  });

  return { id: result.id, sent: result.sent, error: result.error };
}

export function renderInvitationEmail(input: {
  companyName: string;
  inviterName?: string;
  setupUrl: string;
  expiresAt: string;
}) {
  return renderSharedInvitationEmail({
    companyDisplayName: input.companyName,
    setupUrl: input.setupUrl,
    expiresLabel: input.expiresAt,
  });
}

export function renderPasswordResetEmail(input: {
  companyName: string;
  setupUrl: string;
  expiresAt: string;
}) {
  return renderSharedPasswordResetEmail({
    companyDisplayName: input.companyName,
    resetUrl: input.setupUrl,
    expiresLabel: input.expiresAt,
  });
}

export function renderTestEmail(input: { companyName: string; sentAtLabel: string }) {
  return renderSharedTestEmail({
    companyDisplayName: input.companyName,
    sentAtLabel: input.sentAtLabel,
  });
}
