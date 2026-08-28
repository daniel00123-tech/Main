import type { TransactionalEmailType } from "@infra/shared";
import { newId, nowIso } from "../../db/mappers";
import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { updateCompanyEmailHealth } from "./company-config";
import { EmailSenderError, resolveApprovedSender } from "./sender-resolver";
import { sendMicrosoftGraphMail } from "./providers/microsoft-graph";
import { sendResendEmail } from "./providers/resend";

export type SendTransactionalEmailInput = {
  companyId: string;
  type: TransactionalEmailType;
  recipient: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  actor?: string;
  /** Must never be supplied by external callers — resolver ignores arbitrary from values. */
  requestedFrom?: never;
};

export type SendTransactionalEmailResult = {
  id: string;
  sent: boolean;
  provider?: string;
  providerMessageId?: string | null;
  failureCategory?: string;
  error?: string;
};

function templateKeyForType(type: TransactionalEmailType): string {
  switch (type) {
    case "PASSWORD_RESET":
      return "password_reset";
    case "USER_INVITATION":
      return "user_invitation";
    case "TEST_EMAIL":
      return "test_email";
    case "XERO_SALES_REPORT":
      return "xero_sales_report";
  }
}

export async function sendTransactionalEmail(
  env: Env,
  db: D1Database,
  input: SendTransactionalEmailInput,
): Promise<SendTransactionalEmailResult> {
  const id = newId("email");
  const now = nowIso();
  const recipient = input.recipient.trim().toLowerCase();

  let sender;
  try {
    sender = await resolveApprovedSender(db, {
      companyId: input.companyId,
      emailType: input.type,
    });
  } catch (err) {
    const code = err instanceof EmailSenderError ? err.code : "EMAIL_REJECTED";
    return { id, sent: false, failureCategory: code, error: err instanceof Error ? err.message : "Rejected" };
  }

  await db
    .prepare(
      `INSERT INTO email_outbox (
        id, company_id, to_email, template_key, email_type, from_email, subject, body_text, body_html,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
    )
    .bind(
      id,
      input.companyId,
      recipient,
      templateKeyForType(input.type),
      input.type,
      sender.fromEmail,
      input.subject,
      input.bodyText,
      input.bodyHtml,
      now,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "email.send_started",
    actor: input.actor ?? "system:email",
    resourceType: "email_outbox",
    resourceId: id,
    detail: {
      emailType: input.type,
      recipientDomain: recipient.split("@")[1] ?? "unknown",
      provider: sender.provider,
    },
  });

  const delivery =
    sender.provider === "microsoft365"
      ? await sendMicrosoftGraphMail(env, {
          companyId: input.companyId,
          fromEmail: sender.fromEmail,
          fromDisplayName: sender.fromDisplayName,
          toEmail: recipient,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
        })
      : await sendResendEmail(env, {
          fromDisplayName: sender.fromDisplayName,
          fromEmail: sender.fromEmail,
          toEmail: recipient,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
        });

  if (delivery.ok) {
    const sentAt = nowIso();
    await db
      .prepare(
        `UPDATE email_outbox
         SET status = 'sent', provider = ?, provider_message_id = ?, sent_at = ?, failure_category = NULL, error_message = NULL
         WHERE id = ?`,
      )
      .bind(sender.provider, delivery.providerMessageId ?? null, sentAt, id)
      .run();

    await updateCompanyEmailHealth(db, input.companyId, {
      healthStatus: "healthy",
      lastSentAt: sentAt,
      lastErrorCategory: null,
    });

    await recordAuditEvent(db, {
      companyId: input.companyId,
      eventType: "email.sent",
      actor: input.actor ?? "system:email",
      resourceType: "email_outbox",
      resourceId: id,
      detail: {
        emailType: input.type,
        provider: sender.provider,
      },
    });

    return {
      id,
      sent: true,
      provider: sender.provider,
      providerMessageId: delivery.providerMessageId,
    };
  }

  const failureCategory = "category" in delivery ? delivery.category : "unknown";
  await db
    .prepare(
      `UPDATE email_outbox
       SET status = 'failed', provider = ?, failure_category = ?, error_message = ?, retry_count = retry_count + 1
       WHERE id = ?`,
    )
    .bind(sender.provider, failureCategory, delivery.message, id)
    .run();

  await updateCompanyEmailHealth(db, input.companyId, {
    healthStatus: failureCategory === "permission" ? "permission_required" : "error",
    lastErrorCategory: failureCategory,
  });

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "email.failed",
    actor: input.actor ?? "system:email",
    resourceType: "email_outbox",
    resourceId: id,
    detail: {
      emailType: input.type,
      provider: sender.provider,
      failureCategory,
    },
  });

  return {
    id,
    sent: false,
    provider: sender.provider,
    failureCategory,
    error: delivery.message,
  };
}

export { EmailSenderError, resolveApprovedSender };
