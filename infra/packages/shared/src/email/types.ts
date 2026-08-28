/** Allowlisted transactional email types — unknown types must be rejected server-side. */
export const TRANSACTIONAL_EMAIL_TYPES = [
  "PASSWORD_RESET",
  "USER_INVITATION",
  "TEST_EMAIL",
  "XERO_SALES_REPORT",
] as const;

export type TransactionalEmailType = (typeof TRANSACTIONAL_EMAIL_TYPES)[number];

/** Reserved for future activation — not sendable in V1. */
export const FUTURE_TRANSACTIONAL_EMAIL_TYPES = [
  "AUTOMATION_ALERT",
  "CONNECTOR_ALERT",
  "APPROVAL_REQUEST",
  "BILLING_ALERT",
  "SECURITY_ALERT",
  "REPORT_READY",
] as const;

export type EmailProviderKind = "microsoft365" | "resend";

export type EmailDeliveryStatus = "queued" | "sending" | "sent" | "failed";

export type EmailHealthStatus =
  | "healthy"
  | "configuration_required"
  | "permission_required"
  | "error"
  | "disabled";

export type CompanyEmailConfig = {
  id: string;
  companyId: string;
  provider: EmailProviderKind;
  senderAddress: string;
  senderDisplayName: string;
  enabled: boolean;
  allowedTypes: TransactionalEmailType[];
  healthStatus: EmailHealthStatus;
  lastSentAt: string | null;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export function isTransactionalEmailType(value: string): value is TransactionalEmailType {
  return (TRANSACTIONAL_EMAIL_TYPES as readonly string[]).includes(value);
}
