/**
 * Customer-facing error messages. Technical detail stays in audit logs.
 * Never return stack traces, SQL, or Cloudflare error codes to clients.
 */

export type PublicErrorCode =
  | "auth_reconnect"
  | "insufficient_credit"
  | "insufficient_permissions"
  | "permission_denied"
  | "mcp_unavailable"
  | "connector_not_configured"
  | "not_connected"
  | "technical_failure"
  | "retry";

const SAFE_PERMISSION_PREFIXES = [
  "permission denied",
  "insufficient permissions",
  "role does not allow",
  "not allowed",
  "action not permitted",
  "your current permissions",
  "permissions don’t allow",
  "permissions don't allow",
  "doesn’t allow you",
  "doesn't allow you",
  "don’t allow access",
  "don't allow access",
];

export function publicToolErrorMessage(
  httpStatus: number,
  raw?: string | null,
): { code: PublicErrorCode; message: string } {
  const text = (raw ?? "").trim();
  const lower = text.toLowerCase();

  if (
    lower.includes("outlook needs reconnecting") ||
    lower.includes("mail.read") ||
    lower.includes("microsoft 365 is not connected") ||
    lower.includes("outlook_graph_unauthorized") ||
    (lower.includes("outlook") && (httpStatus === 401 || lower.includes("token")))
  ) {
    return {
      code: "auth_reconnect",
      message: "Outlook needs reconnecting",
    };
  }
  if (
    httpStatus === 429 ||
    lower.includes("outlook_rate_limited") ||
    lower.includes("microsoft temporarily rejected") ||
    (lower.includes("outlook") && (httpStatus >= 500 || lower.includes("timeout") || lower.includes("aborted")))
  ) {
    return {
      code: "retry",
      message: "Microsoft temporarily rejected the request",
    };
  }
  if (
    lower.includes("mailbox source not found") ||
    lower.includes("mailbox is not") ||
    lower.includes("outlook_mailbox")
  ) {
    return {
      code: "connector_not_configured",
      message: "Outlook mailbox is not available",
    };
  }

  if (httpStatus === 401 || lower.includes("invalid or revoked") || lower.includes("authentication")) {
    return {
      code: "auth_reconnect",
      message: "Authentication needs reconnecting",
    };
  }
  if (
    httpStatus === 402 ||
    lower.includes("insufficient_credit") ||
    lower.includes("insufficient company credit") ||
    lower.includes("insufficient credit")
  ) {
    return {
      code: "insufficient_credit",
      message: "Insufficient credit",
    };
  }
  if (
    lower.includes("isn’t connected") ||
    lower.includes("isn't connected") ||
    lower.includes("is not connected") ||
    lower.includes("aren’t connected") ||
    lower.includes("aren't connected")
  ) {
    return {
      code: "not_connected",
      message: text && text.length < 200 ? text : "This capability isn’t connected for this company.",
    };
  }
  if (
    lower.includes("couldn’t retrieve") ||
    lower.includes("couldn't retrieve") ||
    lower.includes("just now")
  ) {
    return { code: "technical_failure", message: text };
  }
  if (httpStatus === 403) {
    if (text && SAFE_PERMISSION_PREFIXES.some((p) => lower.startsWith(p) || lower.includes(p))) {
      return { code: "permission_denied", message: text };
    }
    return {
      code: "permission_denied",
      message: "Your current permissions don’t allow this action.",
    };
  }
  if (
    httpStatus === 404 ||
    lower.includes("unreachable") ||
    lower.includes("mcp unavailable") ||
    lower.includes("error 530") ||
    lower.includes("error 1101") ||
    lower.includes("worker threw")
  ) {
    return {
      code: "mcp_unavailable",
      message: "Business MCP unavailable",
    };
  }
  if (lower.includes("not configured") || lower.includes("not provisioned")) {
    return {
      code: "connector_not_configured",
      message: "Connector not configured",
    };
  }
  if (looksTechnical(text)) {
    return { code: "retry", message: "Request failed — retry" };
  }
  if (text && text.length < 160 && !looksTechnical(text)) {
    return { code: "retry", message: text };
  }
  return { code: "retry", message: "Request failed — retry" };
}

function looksTechnical(text: string): boolean {
  if (!text) return false;
  return (
    /stack|sql(ite)?|d1_|wrangler|cloudflare|exception|typeerror|referenceerror|at \S+\s+\(/i.test(
      text,
    ) ||
    text.includes("{") ||
    text.includes("\n")
  );
}
