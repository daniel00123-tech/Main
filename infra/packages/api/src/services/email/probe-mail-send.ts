import type { Env } from "../../env";
import { acquireMicrosoftAppToken } from "../microsoft-auth";
import type { GraphSendFailureCategory } from "./providers/microsoft-graph";

export const MAIL_SEND_APPROVED_PROBE_RECIPIENT = "infra-mail-send-probe@00000000.invalid";
export const MAIL_SEND_DENIED_PROBE_RECIPIENT = "admin@CaddingtonHoldings.co.uk";

export type MailboxSendAuthorizationProbe = {
  senderUpn: string;
  authorized: boolean;
  httpStatus: number | null;
  category: GraphSendFailureCategory | "authorized" | "recipient_rejected";
  message: string;
  mailDelivered: boolean;
  probeRecipient: string;
};

async function postSendMailProbe(
  env: Env,
  input: { companyId: string; senderUpn: string; probeRecipient: string },
): Promise<
  | { ok: true; response: Response }
  | { ok: false; probe: MailboxSendAuthorizationProbe }
> {
  const senderUpn = input.senderUpn.trim();
  const probeRecipient = input.probeRecipient.trim();
  const token = await acquireMicrosoftAppToken(env, { companyId: input.companyId });
  if (!token.ok) {
    return {
      ok: false,
      probe: {
        senderUpn,
        authorized: false,
        httpStatus: 401,
        category: "auth",
        message: token.message,
        mailDelivered: false,
        probeRecipient,
      },
    };
  }

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderUpn)}/sendMail`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: "[INFRA PROBE] Mail.Send authorization check — safe to delete",
          body: {
            contentType: "Text",
            content:
              "Internal INFRA authorization probe only. No action required.",
          },
          toRecipients: [{ emailAddress: { address: probeRecipient } }],
        },
        saveToSentItems: false,
      }),
    });
    return { ok: true, response };
  } catch (err) {
    return {
      ok: false,
      probe: {
        senderUpn,
        authorized: false,
        httpStatus: null,
        category: "network",
        message: err instanceof Error ? err.message : "Network error",
        mailDelivered: false,
        probeRecipient,
      },
    };
  }
}

/** Approved sender: must not receive 403; invalid recipient avoids delivery when possible. */
export async function probeApprovedMailboxSendAuthorization(
  env: Env,
  input: { companyId: string; senderUpn: string },
): Promise<MailboxSendAuthorizationProbe> {
  const senderUpn = input.senderUpn.trim();
  const probeRecipient = MAIL_SEND_APPROVED_PROBE_RECIPIENT;
  const posted = await postSendMailProbe(env, {
    companyId: input.companyId,
    senderUpn,
    probeRecipient,
  });
  if (!posted.ok) return posted.probe;

  const { response } = posted;
  if (response.status === 403) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: 403,
      category: "permission",
      message: "Mail.Send denied by Exchange application scope.",
      mailDelivered: false,
      probeRecipient,
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
      probeRecipient,
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
      probeRecipient,
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
      probeRecipient,
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
    probeRecipient,
  };
}

/** Denied sender: must receive HTTP 403 before delivery to an in-scope recipient. */
export async function probeDeniedMailboxSendAuthorization(
  env: Env,
  input: { companyId: string; senderUpn: string },
): Promise<MailboxSendAuthorizationProbe> {
  const senderUpn = input.senderUpn.trim();
  const probeRecipient = MAIL_SEND_DENIED_PROBE_RECIPIENT;
  const posted = await postSendMailProbe(env, {
    companyId: input.companyId,
    senderUpn,
    probeRecipient,
  });
  if (!posted.ok) return posted.probe;

  const { response } = posted;
  if (response.status === 403) {
    return {
      senderUpn,
      authorized: false,
      httpStatus: 403,
      category: "permission",
      message: "Mail.Send denied by Exchange application scope.",
      mailDelivered: false,
      probeRecipient,
    };
  }

  if (response.status === 202 || response.status === 200) {
    return {
      senderUpn,
      authorized: true,
      httpStatus: response.status,
      category: "authorized",
      message: "Mail.Send unexpectedly authorized for out-of-scope mailbox.",
      mailDelivered: true,
      probeRecipient,
    };
  }

  const bodyText = await response.text().catch(() => "");
  return {
    senderUpn,
    authorized: true,
    httpStatus: response.status,
    category: "unknown",
    message: bodyText.slice(0, 180) || `Unexpected Graph response (HTTP ${response.status}).`,
    mailDelivered: false,
    probeRecipient,
  };
}

/** @deprecated Use probeApprovedMailboxSendAuthorization / probeDeniedMailboxSendAuthorization. */
export async function probeMailboxSendAuthorization(
  env: Env,
  input: { companyId: string; senderUpn: string; probeRecipient?: string },
): Promise<MailboxSendAuthorizationProbe> {
  if (input.probeRecipient) {
    const posted = await postSendMailProbe(env, {
      companyId: input.companyId,
      senderUpn: input.senderUpn,
      probeRecipient: input.probeRecipient,
    });
    if (!posted.ok) return posted.probe;
    const status = posted.response.status;
    return {
      senderUpn: input.senderUpn.trim(),
      authorized: status !== 403,
      httpStatus: status,
      category: status === 403 ? "permission" : status === 202 || status === 200 ? "authorized" : "unknown",
      message: `Graph sendMail returned HTTP ${status}.`,
      mailDelivered: status === 202 || status === 200,
      probeRecipient: input.probeRecipient,
    };
  }
  return probeApprovedMailboxSendAuthorization(env, input);
}
