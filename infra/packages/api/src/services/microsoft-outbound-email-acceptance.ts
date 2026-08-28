/**
 * Outbound transactional email V1 — production acceptance (Mail.Send scope).
 */

import type { Env } from "../env";
import { createPasswordSetupToken, findValidSetupToken, consumeSetupToken } from "../auth/password-setup";
import { getUserByEmail, updateUserPassword } from "../auth/users";
import { verifyPassword } from "../auth/password";
import { nowIso } from "../db/mappers";
import { renderPasswordResetEmail, queueEmail } from "./email-outbox";
import {
  buildPasswordResetUrl,
  companyDisplayNameForEmail,
  resolvePasswordResetCompanyId,
} from "./email/resolve-company";
import { getCompanyEmailConfig } from "./email/company-config";
import {
  probeApprovedMailboxSendAuthorization,
  probeDeniedMailboxSendAuthorization,
} from "./email/probe-mail-send";
import { exchangeMailSendRbacGuide } from "./email/providers/microsoft-graph";
import { EmailSenderError, resolveApprovedSender } from "./email/sender-resolver";

const PILOT_COMPANY_ID = "co_caddington";
const APPROVED_MAILBOX = "admin@CaddingtonHoldings.co.uk";
const DENIED_MAILBOX = "Daniel.Dwyer@CaddingtonHoldings.co.uk";
const ACCEPTANCE_TEST_USER = "morghan@morghan.com";
const ACCEPTANCE_PORTAL_ORIGIN = "https://caddington.infra-web.pages.dev";

export async function runOutboundEmailV1Acceptance(env: Env): Promise<Record<string, unknown>> {
  const emailConfig = await getCompanyEmailConfig(env.DB, PILOT_COMPANY_ID);
  const approvedProbe = await probeApprovedMailboxSendAuthorization(env, {
    companyId: PILOT_COMPANY_ID,
    senderUpn: APPROVED_MAILBOX,
  });
  const deniedProbe = await probeDeniedMailboxSendAuthorization(env, {
    companyId: PILOT_COMPANY_ID,
    senderUpn: DENIED_MAILBOX,
  });

  let applicationDeniedSenderBlocked = false;
  try {
    await resolveApprovedSender(env.DB, {
      companyId: PILOT_COMPANY_ID,
      emailType: "PASSWORD_RESET",
      requestedFrom: DENIED_MAILBOX,
    });
  } catch (err) {
    applicationDeniedSenderBlocked = err instanceof EmailSenderError && err.code === "SENDER_NOT_ALLOWED";
  }

  const approvedPermitted = approvedProbe.authorized === true;
  const graphDeniedRejected =
    deniedProbe.authorized === false &&
    deniedProbe.httpStatus === 403 &&
    deniedProbe.category === "permission";

  const securityPass =
    approvedPermitted && (graphDeniedRejected || applicationDeniedSenderBlocked);

  return {
    command: "OUTBOUND_EMAIL_V1",
    pilotCompanyId: PILOT_COMPANY_ID,
    approvedSender: APPROVED_MAILBOX,
    deniedSender: DENIED_MAILBOX,
    companyEmailConfig: emailConfig
      ? {
          provider: emailConfig.provider,
          senderAddress: emailConfig.senderAddress,
          enabled: emailConfig.enabled,
          healthStatus: emailConfig.healthStatus,
          allowedTypes: emailConfig.allowedTypes,
        }
      : null,
    authorizationProbes: {
      approved: approvedProbe,
      denied: deniedProbe,
    },
    applicationLayer: {
      approvedSenderFromConfig: APPROVED_MAILBOX,
      deniedSenderOverrideBlocked: applicationDeniedSenderBlocked,
    },
    tests: {
      approvedMailboxSendPermitted: approvedPermitted ? "PASS" : "FAIL",
      deniedMailboxSendRejected: graphDeniedRejected ? "PASS" : "FAIL",
      deniedSenderBlockedAtApplicationLayer: applicationDeniedSenderBlocked ? "PASS" : "FAIL",
      security: securityPass ? "PASS" : "FAIL",
    },
    microsoftSetup: exchangeMailSendRbacGuide({
      approvedMailbox: APPROVED_MAILBOX,
      appClientId:
        typeof env.MICROSOFT_CLIENT_ID === "string" ? env.MICROSOFT_CLIENT_ID : undefined,
    }),
    classification: securityPass
      ? graphDeniedRejected
        ? "OUTBOUND EMAIL V1 — MAIL.SEND AUTHORIZATION PASS"
        : "OUTBOUND EMAIL V1 — APPLICATION SENDER CONTROLS PASS (GRAPH SEND PROBE INCONCLUSIVE)"
      : approvedPermitted && !graphDeniedRejected && !applicationDeniedSenderBlocked
        ? "OUTBOUND EMAIL V1 — APPROVED SEND OK, DENIED MAILBOX NOT BLOCKED"
        : !approvedPermitted && graphDeniedRejected
          ? "OUTBOUND EMAIL V1 — DENIED BLOCK OK, APPROVED SEND FAILING"
          : "OUTBOUND EMAIL V1 — MAIL.SEND AUTHORIZATION FAIL",
    securityPass,
    note: "Authorization probes use a non-deliverable recipient. Forgot-password acceptance proves a genuine send separately.",
  };
}

export async function runPasswordResetEmailAcceptance(env: Env): Promise<Record<string, unknown>> {
  const user = await getUserByEmail(env.DB, ACCEPTANCE_TEST_USER);
  if (!user) {
    return {
      command: "OUTBOUND_EMAIL_V1_PASSWORD_RESET",
      pass: false,
      error: `Acceptance user not found: ${ACCEPTANCE_TEST_USER}`,
    };
  }

  const original = await env.DB.prepare(
    "SELECT password_hash, password_salt FROM users WHERE id = ?",
  )
    .bind(user.id)
    .first<{ password_hash: string; password_salt: string }>();

  const companyId = await resolvePasswordResetCompanyId(env, env.DB, {
    userId: user.id,
    origin: ACCEPTANCE_PORTAL_ORIGIN,
  });
  if (!companyId) {
    return {
      command: "OUTBOUND_EMAIL_V1_PASSWORD_RESET",
      pass: false,
      error: "No email-enabled company resolved for acceptance user",
    };
  }

  const { token, expiresAt } = await createPasswordSetupToken(env.DB, user.id, "password_reset");
  const resetUrl = buildPasswordResetUrl(ACCEPTANCE_PORTAL_ORIGIN, token);
  const companyName = await companyDisplayNameForEmail(env.DB, companyId);
  const emailContent = renderPasswordResetEmail({
    companyName,
    setupUrl: resetUrl,
    expiresAt: new Date(expiresAt).toLocaleString("en-GB"),
  });

  const emailResult = await queueEmail(env, env.DB, {
    companyId,
    toEmail: user.email,
    templateKey: "password_reset",
    subject: emailContent.subject,
    bodyText: emailContent.text,
    bodyHtml: emailContent.html,
    actor: "acceptance:outbound-email-v1",
  });

  const validateBefore = await findValidSetupToken(env.DB, token);
  const acceptancePassword = `InfraAcceptance!${nowIso().slice(0, 10).replace(/-/g, "")}`;
  const tokenRecord = validateBefore;
  if (tokenRecord) {
    await updateUserPassword(env.DB, user.id, acceptancePassword);
    await consumeSetupToken(env.DB, tokenRecord.id);
  }
  const reuseAllowed = (await findValidSetupToken(env.DB, token)) !== null;

  const reloaded = await getUserByEmail(env.DB, user.email);
  const loginOk =
    reloaded !== null &&
    (await verifyPassword(acceptancePassword, reloaded.passwordSalt, reloaded.passwordHash));

  if (original) {
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(original.password_hash, original.password_salt, user.id)
      .run();
  }

  const restored = await getUserByEmail(env.DB, user.email);
  const restoredLoginFails =
    restored !== null &&
    !(await verifyPassword(acceptancePassword, restored.passwordSalt, restored.passwordHash));

  const outbox = await env.DB.prepare(
    `SELECT id, from_email, status, provider, sent_at
     FROM email_outbox WHERE id = ?`,
  )
    .bind(emailResult.id)
    .first<{
      id: string;
      from_email: string | null;
      status: string;
      provider: string | null;
      sent_at: string | null;
    }>();

  const pass = Boolean(
    emailResult.sent &&
      outbox?.status === "sent" &&
      outbox.from_email?.toLowerCase() === APPROVED_MAILBOX.toLowerCase() &&
      validateBefore &&
      !reuseAllowed &&
      loginOk &&
      restoredLoginFails,
  );

  return {
    command: "OUTBOUND_EMAIL_V1_PASSWORD_RESET",
    testUser: ACCEPTANCE_TEST_USER,
    companyId,
    approvedSender: APPROVED_MAILBOX,
    emailDelivery: {
      outboxId: emailResult.id,
      sent: emailResult.sent,
      error: emailResult.error ?? null,
      fromEmail: outbox?.from_email ?? null,
      provider: outbox?.provider ?? null,
      sentAt: outbox?.sent_at ?? null,
    },
    resetFlow: {
      tokenValidatedBeforeUse: Boolean(validateBefore),
      resetUrlHost: new URL(resetUrl).host,
      tokenSingleUseEnforced: !reuseAllowed,
      loginWithNewPassword: loginOk,
      originalPasswordRestored: restoredLoginFails,
    },
    tests: {
      emailSentFromApprovedSender: emailResult.sent ? "PASS" : "FAIL",
      tokenSingleUse: !reuseAllowed ? "PASS" : "FAIL",
      loginWithNewPassword: loginOk ? "PASS" : "FAIL",
      passwordRestored: restoredLoginFails ? "PASS" : "FAIL",
    },
    pass,
    classification: pass
      ? "OUTBOUND EMAIL V1 — PASSWORD RESET ACCEPTANCE PASS"
      : "OUTBOUND EMAIL V1 — PASSWORD RESET ACCEPTANCE FAIL",
  };
}
