/**
 * Outlook draft/send exposure policy.
 *
 * READ tools stay on the existing Outlook read path.
 * SEND must stay behind Action Engine confirmation — and Action Engine is
 * currently Xero-scoped, so raw send_elvex_email must not be advertised.
 * DRAFT is only allowed when it creates a real Outlook Draft item.
 * Elvex has no INFRA Graph mailbox sources and company-MCP write tools are
 * blocked on the read path; there is no safe draft executor today.
 */

export const OUTLOOK_DRAFT_TOOL_NAME = "outlook_create_draft";
export const OUTLOOK_SEND_TOOL_NAME = "outlook_send_message";

export const TOOL_NOT_EXPOSED_COPY =
  "This capability isn’t available through this connection yet.";
export const PERMISSION_DENIED_COPY = "Your current permissions don’t allow access.";
export const UPSTREAM_FAILURE_COPY = "I couldn’t reach that mailbox just now.";
export const NO_RESULTS_COPY = "No matching emails were found.";

export type OutlookWriteExposure = {
  draft: "TOOL_NOT_EXPOSED";
  send: "TOOL_NOT_EXPOSED";
  draftReason: string;
  sendReason: string;
  actionEngineEmailSupport: false;
};

export function outlookWriteExposure(): OutlookWriteExposure {
  return {
    draft: "TOOL_NOT_EXPOSED",
    send: "TOOL_NOT_EXPOSED",
    draftReason:
      "No INFRA or company-MCP executor creates a real Outlook Draft item. Do not fake a draft, and do not expose send_elvex_email as a draft.",
    sendReason:
      "Sending must stay behind Action Engine confirmation. The Action Engine is Xero-scoped; email-write needs a separate Action Engine capability.",
    actionEngineEmailSupport: false,
  };
}

export function isOutlookWriteLikeToolName(name: string): boolean {
  return /send_elvex_email|send_.*email|outlook_send|mail_send|outlook_.*draft|draft_.*email|create_.*email|manage_elvex_email/i.test(
    name,
  );
}
