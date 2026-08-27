/**
 * Customer-facing error messages. Technical detail stays in audit logs.
 * Never return stack traces, SQL, or Cloudflare error codes to clients.
 */

export type PublicErrorCode =
  | "auth_reconnect"
  | "insufficient_credit"
  | "insufficient_permissions"
  | "mcp_unavailable"
  | "connector_not_configured"
  | "retry";

const SAFE_PERMISSION_PREFIXES = [
  "permission denied",
  "insufficient permissions",
  "role does not allow",
  "not allowed",
  "action not permitted",
];

export function publicToolErrorMessage(
  httpStatus: number,
  raw?: string | null,
): { code: PublicErrorCode; message: string } {
  const text = (raw ?? "").trim();
  const lower = text.toLowerCase();

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
  if (httpStatus === 403) {
    if (text && SAFE_PERMISSION_PREFIXES.some((p) => lower.startsWith(p) || lower.includes(p))) {
      return { code: "insufficient_permissions", message: text };
    }
    return {
      code: "insufficient_permissions",
      message: "Insufficient permissions",
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
