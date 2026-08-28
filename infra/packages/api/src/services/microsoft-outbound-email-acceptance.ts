/**
 * Outbound transactional email V1 — production acceptance (Mail.Send scope).
 */

import type { Env } from "../env";
import { getCompanyEmailConfig } from "./email/company-config";
import { probeMailboxSendAuthorization } from "./email/probe-mail-send";
import { exchangeMailSendRbacGuide } from "./email/providers/microsoft-graph";

const PILOT_COMPANY_ID = "co_caddington";
const APPROVED_MAILBOX = "admin@CaddingtonHoldings.co.uk";
const DENIED_MAILBOX = "Daniel.Dwyer@CaddingtonHoldings.co.uk";

export async function runOutboundEmailV1Acceptance(env: Env): Promise<Record<string, unknown>> {
  const emailConfig = await getCompanyEmailConfig(env.DB, PILOT_COMPANY_ID);
  const approvedProbe = await probeMailboxSendAuthorization(env, {
    companyId: PILOT_COMPANY_ID,
    senderUpn: APPROVED_MAILBOX,
  });
  const deniedProbe = await probeMailboxSendAuthorization(env, {
    companyId: PILOT_COMPANY_ID,
    senderUpn: DENIED_MAILBOX,
  });

  const approvedPermitted = approvedProbe.authorized === true;
  const deniedRejected =
    deniedProbe.authorized === false &&
    deniedProbe.httpStatus === 403 &&
    deniedProbe.category === "permission";

  const securityPass = approvedPermitted && deniedRejected;

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
    tests: {
      approvedMailboxSendPermitted: approvedPermitted ? "PASS" : "FAIL",
      deniedMailboxSendRejected: deniedRejected ? "PASS" : "FAIL",
      security: securityPass ? "PASS" : "FAIL",
    },
    microsoftSetup: exchangeMailSendRbacGuide({
      approvedMailbox: APPROVED_MAILBOX,
      appClientId:
        typeof env.MICROSOFT_CLIENT_ID === "string" ? env.MICROSOFT_CLIENT_ID : undefined,
    }),
    classification: securityPass
      ? "OUTBOUND EMAIL V1 — MAIL.SEND AUTHORIZATION PASS"
      : approvedPermitted && !deniedRejected
        ? "OUTBOUND EMAIL V1 — APPROVED SEND OK, DENIED MAILBOX NOT BLOCKED"
        : !approvedPermitted && deniedRejected
          ? "OUTBOUND EMAIL V1 — DENIED BLOCK OK, APPROVED SEND FAILING"
          : "OUTBOUND EMAIL V1 — MAIL.SEND AUTHORIZATION FAIL",
    securityPass,
    note: "Authorization probes use a non-deliverable recipient. Forgot-password acceptance proves a genuine send separately.",
  };
}
