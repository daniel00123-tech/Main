import {
  PLATFORM_EMAIL_FROM_ADDRESS,
  isTransactionalEmailType,
  type TransactionalEmailType,
} from "@infra/shared";
import type { Env } from "../../env";
import { normaliseSenderAddress } from "./company-config";
import { resolvePlatformEmailIdentity } from "./platform-identity";

export type ResolvedSender = {
  companyId: string;
  provider: "cloudflare";
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

export function resolveApprovedSender(
  env: Pick<Env, "EMAIL_FROM_NAME" | "EMAIL_FROM_ADDRESS" | "EMAIL_FROM"> | undefined,
  input: {
    companyId: string;
    emailType: string;
    requestedFrom?: string | null;
  },
): ResolvedSender {
  if (!isTransactionalEmailType(input.emailType)) {
    throw new EmailSenderError("EMAIL_TYPE_NOT_ALLOWED", "Email type is not allowlisted.");
  }

  const identity = resolvePlatformEmailIdentity(env);
  if (
    input.requestedFrom &&
    normaliseSenderAddress(input.requestedFrom) !== normaliseSenderAddress(identity.address)
  ) {
    throw new EmailSenderError(
      "SENDER_NOT_ALLOWED",
      "Requested sender is not the Infra platform sender.",
    );
  }

  return {
    companyId: input.companyId,
    provider: "cloudflare",
    fromEmail: identity.address,
    fromDisplayName: identity.name,
    allowedTypes: [
      "PASSWORD_RESET",
      "USER_INVITATION",
      "TEST_EMAIL",
      "XERO_SALES_REPORT",
      "DOCUMENT_ACTIVITY_REPORT",
    ],
  };
}

export function platformSenderAddress(
  env?: Pick<Env, "EMAIL_FROM_NAME" | "EMAIL_FROM_ADDRESS" | "EMAIL_FROM">,
): string {
  return resolvePlatformEmailIdentity(env).address || PLATFORM_EMAIL_FROM_ADDRESS;
}
