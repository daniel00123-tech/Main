import type { CompanyEmailConfig, TransactionalEmailType } from "@infra/shared";
import { isTransactionalEmailType } from "@infra/shared";
import {
  getCompanyEmailConfig,
  normaliseSenderAddress,
  senderMatchesAllowlist,
} from "./company-config";

export type ResolvedSender = {
  companyId: string;
  provider: CompanyEmailConfig["provider"];
  fromEmail: string;
  fromDisplayName: string;
  allowedTypes: TransactionalEmailType[];
};

export class EmailSenderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailSenderError";
    this.code = code;
  }
}

export async function resolveApprovedSender(
  db: D1Database,
  input: {
    companyId: string;
    emailType: string;
    requestedFrom?: string | null;
  },
): Promise<ResolvedSender> {
  if (!isTransactionalEmailType(input.emailType)) {
    throw new EmailSenderError("EMAIL_TYPE_NOT_ALLOWED", "Email type is not allowlisted.");
  }

  const config = await getCompanyEmailConfig(db, input.companyId);
  if (!config) {
    throw new EmailSenderError(
      "EMAIL_NOT_CONFIGURED",
      "Transactional email is not configured for this company.",
    );
  }
  if (!config.enabled) {
    throw new EmailSenderError("EMAIL_DISABLED", "Transactional email is disabled for this company.");
  }
  if (!config.allowedTypes.includes(input.emailType)) {
    throw new EmailSenderError(
      "EMAIL_TYPE_NOT_ALLOWED",
      "This email type is not enabled for the company sender.",
    );
  }
  if (!senderMatchesAllowlist(config, input.requestedFrom)) {
    throw new EmailSenderError(
      "SENDER_NOT_ALLOWED",
      "Requested sender is not approved for this company.",
    );
  }

  return {
    companyId: config.companyId,
    provider: config.provider,
    fromEmail: config.senderAddress.trim(),
    fromDisplayName: config.senderDisplayName.trim(),
    allowedTypes: config.allowedTypes,
  };
}
