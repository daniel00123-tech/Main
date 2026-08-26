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
  reason:
    | "mcp_resolve"
    | "rotation"
    | "revocation"
    | "existence_check"
    | "test"
    | "execution"
    | "token_refresh";
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
  constructor(message = "Secure credential storage is not configured") {
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

export const SECRET_KEY_PATTERN =
  /(password|secret|token|api[_-]?key|authorization|refresh|bearer|client[_-]?secret|private[_-]?key|access[_-]?token|id[_-]?token|session)/i;

const SECRET_VALUE_HINT =
  /^(sk-|rk-|xox[baprs]-|ghp_|github_pat_|ya29\.|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;

export function isSecretFieldName(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

export function isSecretSchemaProperty(property: unknown): boolean {
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return false;
  }
  const format = (property as { format?: unknown }).format;
  return format === "secret" || format === "password";
}

export function secretFieldNamesFromSchema(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const names = new Set<string>();
  const props =
    schema && schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const [name, property] of Object.entries(props)) {
    if (isSecretSchemaProperty(property) || isSecretFieldName(name)) {
      names.add(name);
    }
  }
  return names;
}

export function redactSecretFields(
  value: Record<string, unknown> | null | undefined,
  schema?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!value) return {};
  const schemaSecrets = secretFieldNamesFromSchema(schema);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (schemaSecrets.has(key) || isSecretFieldName(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof item === "string" && SECRET_VALUE_HINT.test(item)) {
      out[key] = "[redacted]";
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out[key] = redactSecretFields(item as Record<string, unknown>, schema);
    } else {
      out[key] = item;
    }
  }
  return out;
}

export function sanitizeForLog(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return SECRET_VALUE_HINT.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (typeof value === "object") {
    return redactSecretFields(value as Record<string, unknown>);
  }
  return value;
}

export function sanitizeCustomerError(message: string): string {
  const redacted = message
    .replace(
      /(sk-|rk-|xox[baprs]-|ghp_|github_pat_|ya29\.|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g,
      "[redacted]",
    )
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  if (redacted.length > 180) return "Request failed — retry";
  return redacted;
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
