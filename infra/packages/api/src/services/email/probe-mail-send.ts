import type { Env } from "../../env";
import { acquireMicrosoftAppToken } from "../microsoft-auth";
import type { GraphSendFailureCategory } from "./providers/microsoft-graph";

/** Non-deliverable probe recipient — authorization is evaluated before queueing. */
export const MAIL_SEND_PROBE_RECIPIENT = "infra-mail-send-probe@00000000.invalid";

export type MailboxSendAuthorizationProbe = {
  senderUpn: string;
  authorized: boolean;
  httpStatus: number | null;
  category: GraphSendFailureCategory | "authorized" | "recipient_rejected";
  message: string;
  /** Probes never intentionally deliver mail. */
  mailDelivered: false;
};

/**
 * Probe Exchange Application Mail.Send scope via Graph sendMail without delivering mail.
 * Denied mailboxes return HTTP 403 before send. Approved mailboxes pass authorization and
 * typically fail recipient validation (HTTP 400) for the non-deliverable probe address.
 */
export async function probeMailboxSendAuthorization(
  env: Env,
  input: { companyId: string; senderUpn: string },
): Promise<MailboxSendAuthorizationProbe> {
  const senderUpn = input.senderUpn.trim();
  const token = await acquireMicrosoftAppToken(env, { companyId: input.companyId });
  if (!token.ok) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: 401,
      category: "auth",
      message: token.message,
      mailDelivered: false,
    };
  }

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderUpn)}/sendMail`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: "[INFRA PROBE] Mail.Send authorization check",
          body: {
            contentType: "Text",
            content: "Authorization probe — do not deliver.",
          },
          toRecipients: [{ emailAddress: { address: MAIL_SEND_PROBE_RECIPIENT } }],
        },
        saveToSentItems: false,
      }),
    });
  } catch (err) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: null,
      category: "network",
      message: err instanceof Error ? err.message : "Network error",
      mailDelivered: false,
    };
  }

  if (response.status === 403) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: 403,
      category: "permission",
      message: "Mail.Send denied by Exchange application scope.",
      mailDelivered: false,
    };
  }

  if (response.status === 401) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: 401,
      category: "auth",
      message: "Microsoft authentication failed.",
      mailDelivered: false,
    };
  }

  if (response.status === 202 || response.status === 200) {
    return {
      senderUpn,
      authorized: true,
      httpStatus: response.status,
      category: "authorized",
      message: "Mail.Send authorized (Graph accepted sendMail).",
      mailDelivered: false,
    };
  }

  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return {
      senderUpn,
      authorized: true,
      httpStatus: response.status,
      category: "recipient_rejected",
      message: "Mail.Send authorized; probe recipient rejected before delivery.",
      mailDelivered: false,
    };
  }

  const bodyText = await response.text().catch(() => "");
  return {
    senderUpn,
    authorized: false,
    httpStatus: response.status,
    category: response.status === 429 ? "throttled" : "unknown",
    message: bodyText.slice(0, 180) || `Unexpected Graph response (HTTP ${response.status}).`,
    mailDelivered: false,
  };
}
