import type { OperationalErrorCategory } from "./health-model";

/** Map gateway/usage failure labels to operational categories. */
export function mapUsageFailureToOperationalCategory(
  category: string | null | undefined,
): OperationalErrorCategory {
  switch ((category ?? "").toUpperCase()) {
    case "AUTHENTICATION":
      return "AUTHENTICATION";
    case "PERMISSION":
    case "INSUFFICIENT_PERMISSIONS":
      return "AUTHORIZATION";
    case "RATE_LIMIT":
      return "RATE_LIMIT";
    case "TIMEOUT":
      return "TIMEOUT";
    case "UPSTREAM_API":
    case "MCP_UNAVAILABLE":
      return "PROVIDER";
    case "VALIDATION":
    case "USER_INPUT":
      return "DATA";
    case "INFRA_INTERNAL":
      return "INTERNAL";
    case "INSUFFICIENT_CREDIT":
      return "CONFIGURATION";
    default:
      return "UNKNOWN";
  }
}

/** Xero / Action Engine governance denials are security policy, not outages. */
export function isIntentionalGovernanceBlock(input: {
  errorCode?: string | null;
  message?: string | null;
}): boolean {
  const code = (input.errorCode ?? "").toLowerCase();
  const message = (input.message ?? "").toLowerCase();
  return (
    code.includes("governance") ||
    code.includes("write_not_enabled") ||
    code.includes("approval_required") ||
    code.includes("security_policy") ||
    message.includes("governance") ||
    message.includes("not enabled for write") ||
    message.includes("approval required")
  );
}

export function mapConnectorFailureToCategory(input: {
  authStatus?: string | null;
  healthMessage?: string | null;
}): OperationalErrorCategory {
  const auth = (input.authStatus ?? "").toLowerCase();
  if (auth.includes("expired") || auth.includes("revoked")) return "AUTHENTICATION";
  if (auth.includes("rotation")) return "AUTHENTICATION";
  const msg = (input.healthMessage ?? "").toLowerCase();
  if (msg.includes("403") || msg.includes("permission") || msg.includes("denied")) {
    return "AUTHORIZATION";
  }
  if (msg.includes("429") || msg.includes("throttl")) return "RATE_LIMIT";
  if (msg.includes("timeout")) return "TIMEOUT";
  if (msg.includes("config")) return "CONFIGURATION";
  return "PROVIDER";
}
