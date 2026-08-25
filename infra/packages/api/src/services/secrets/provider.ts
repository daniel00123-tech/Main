/**
 * SecretProvider — application code talks to this interface only.
 *
 * Connector instances hold an opaque reference. Secret values never enter D1,
 * audit events, URLs, or frontend state.
 */

export type SecretPurpose =
  | "connector"
  | "mcp_auth"
  | "oauth_access"
  | "oauth_refresh"
  | "api_key";

export interface SecretStoreInput {
  companyId: string;
  purpose: SecretPurpose;
  value: string;
  connectorInstanceId?: string | null;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredSecretRef {
  reference: string;
  companyId: string;
  purpose: SecretPurpose;
  connectorInstanceId?: string | null;
  createdAt: string;
  rotatedAt?: string | null;
}

export interface SecretAccessContext {
  companyId: string;
  actor: string;
  reason: "mcp_resolve" | "rotation" | "revocation" | "existence_check" | "test";
}

export interface SecretProvider {
  readonly kind: string;
  readonly submissionEnabled: boolean;
  store(input: SecretStoreInput): Promise<StoredSecretRef>;
  resolve(reference: string, context: SecretAccessContext): Promise<string | null>;
  rotate(
    reference: string,
    value: string,
    context: SecretAccessContext,
  ): Promise<StoredSecretRef>;
  revoke(reference: string, context: SecretAccessContext): Promise<void>;
  exists(reference: string, context: SecretAccessContext): Promise<boolean>;
}

export class CredentialSubmissionDisabledError extends Error {
  readonly code = "CREDENTIAL_SUBMISSION_DISABLED";
  constructor(message = "Secure credential storage is not enabled yet") {
    super(message);
    this.name = "CredentialSubmissionDisabledError";
  }
}

export class SecretTenantMismatchError extends Error {
  readonly code = "CREDENTIAL_REF_FORBIDDEN";
  constructor(message = "Credential reference does not belong to this company") {
    super(message);
    this.name = "SecretTenantMismatchError";
  }
}

const SECRET_KEY_PATTERN =
  /(password|secret|token|api[_-]?key|authorization|refresh|bearer|client[_-]?secret)/i;

export function redactSecretFields(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out[key] = redactSecretFields(item as Record<string, unknown>);
    } else {
      out[key] = item;
    }
  }
  return out;
}

export function stripSecretFields<T extends Record<string, unknown>>(
  value: T,
): T {
  const out = { ...value };
  for (const key of Object.keys(out)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      delete out[key];
    }
  }
  return out;
}

export function isOpaqueSecretReference(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^(sec_|cred_|binding:|vault:)/.test(value);
}
