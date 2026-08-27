import {
  CONNECTOR_ERROR_CODES,
  customerConnectorError,
  getConnectorById,
  type ConnectorDefinition,
} from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { getCompanyById, getConnectorInstance, recordAuditEvent } from "./control-plane";
import {
  CredentialSubmissionDisabledError,
  SecretCryptoError,
  SecretStorageUnavailableError,
  SecretTenantMismatchError,
  createSecretProvider,
  isSecretFieldName,
  isSecretSchemaProperty,
  redactSecretFields,
  sanitizeCustomerError,
  stripSecretFields,
  type SecretProvider,
} from "./secrets";
import type { Env } from "../env";

const INACTIVE_COMPANY = new Set(["suspended", "archived", "closed"]);

export function rejectPlaintextCredentialStore(): {
  status: 409;
  body: ReturnType<typeof customerConnectorError>;
} {
  return {
    status: 409,
    body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_SUBMISSION_DISABLED),
  };
}

export function partitionConnectorInput(
  definition: ConnectorDefinition | null,
  credentials: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined,
): { secretPayload: Record<string, unknown>; publicConfig: Record<string, unknown> } {
  const secretPayload: Record<string, unknown> = {};
  const publicConfig = stripSecretFields({ ...(config ?? {}) });
  const schemaProps =
    definition?.credentialSchema &&
    typeof definition.credentialSchema.properties === "object"
      ? (definition.credentialSchema.properties as Record<string, unknown>)
      : {};

  for (const [key, value] of Object.entries(credentials ?? {})) {
    const schemaSaysSecret = isSecretSchemaProperty(schemaProps[key]);
    if (schemaSaysSecret || isSecretFieldName(key)) {
      if (value != null && value !== "") secretPayload[key] = value;
    } else if (value != null && value !== "") {
      publicConfig[key] = value;
    }
  }
  return { secretPayload, publicConfig: stripSecretFields(publicConfig) };
}

export function serializeCredentialPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function parseCredentialPayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value };
  } catch {
    return { value };
  }
}

async function assertCompanyCanStore(env: Env, companyId: string) {
  const company = await getCompanyById(env.DB, companyId);
  if (!company) {
    return {
      ok: false as const,
      status: 404 as const,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED),
    };
  }
  if (INACTIVE_COMPANY.has(company.status)) {
    return {
      ok: false as const,
      status: 403 as const,
      body: customerConnectorError(
        company.status === "suspended"
          ? CONNECTOR_ERROR_CODES.SUSPENDED
          : CONNECTOR_ERROR_CODES.COMPANY_INACTIVE,
      ),
    };
  }
  return { ok: true as const, company };
}

export async function storeConnectorCredential(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  label: string;
  provider: string;
  secretValue?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  actor: string;
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true; credentialRefId: string; reference: string }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const companyCheck = await assertCompanyCanStore(input.env, input.companyId);
  if (!companyCheck.ok) return companyCheck;

  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return {
      ok: false,
      status: 404,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }

  const definition = getConnectorById(input.provider) ?? getConnectorById(instance.connectorDefinitionId);
  const { secretPayload, publicConfig } = partitionConnectorInput(
    definition ?? null,
    input.credentials,
    input.config,
  );
  const value =
    Object.keys(secretPayload).length > 0
      ? serializeCredentialPayload(secretPayload)
      : input.secretValue?.trim() ?? "";
  if (!value) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }

  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    const stored = await provider.store({
      companyId: input.companyId,
      purpose: definition?.authenticationMethod === "oauth" ? "oauth_access" : "connector",
      value,
      connectorInstanceId: input.instanceId,
      label: input.label,
    });
    const id = newId("cred");
    const now = nowIso();
    await input.env.DB.prepare(
      `INSERT INTO credential_refs (
        id, company_id, connector_instance_id, label, provider, secret_ref,
        status, expires_at, purpose, rotated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'valid', NULL, 'connector', NULL, ?, ?)`,
    )
      .bind(
        id,
        input.companyId,
        input.instanceId,
        input.label,
        input.provider,
        stored.reference,
        now,
        now,
      )
      .run();
    await persistPublicConnectorConfig(
      input.env,
      instance,
      publicConfig,
      now,
    );
    await input.env.DB.prepare(
      `UPDATE connector_instances
       SET credential_ref_id = ?, auth_status = 'configuring', connected_at = NULL,
           configured_by = ?, status = 'configured', health_message = ?,
           updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(
        id,
        input.actor,
        "Credentials stored securely. Connection test is not available for this connector yet.",
        now,
        input.instanceId,
        input.companyId,
      )
      .run();
    await recordAuditEvent(input.env.DB, {
      companyId: input.companyId,
      eventType: "credential.created",
      actor: input.actor,
      resourceType: "credential",
      resourceId: id,
      detail: {
        connectorInstanceId: input.instanceId,
        credentialRefId: id,
        purpose: stored.purpose,
      },
    });
    return { ok: true, credentialRefId: id, reference: stored.reference };
  } catch (error) {
    return mapSecretError(error);
  }
}

export async function rotateConnectorCredential(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  credentialRefId: string;
  secretValue?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  actor: string;
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true; reference: string }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const companyCheck = await assertCompanyCanStore(input.env, input.companyId);
  if (!companyCheck.ok) return companyCheck;

  const row = await input.env.DB.prepare(
    `SELECT * FROM credential_refs WHERE id = ?`,
  )
    .bind(input.credentialRefId)
    .first();
  if (!row) {
    return {
      ok: false,
      status: 404,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  if (String(row.company_id) !== input.companyId) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  if (
    row.connector_instance_id &&
    String(row.connector_instance_id) !== input.instanceId
  ) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }

  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return {
      ok: false,
      status: 404,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  const definition = getConnectorById(instance.connectorDefinitionId);
  const { secretPayload, publicConfig } = partitionConnectorInput(
    definition ?? null,
    input.credentials,
    input.config,
  );
  const value =
    Object.keys(secretPayload).length > 0
      ? serializeCredentialPayload(secretPayload)
      : input.secretValue?.trim() ?? "";
  if (!value) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }

  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    const rotated = await provider.rotate(String(row.secret_ref), value, {
      companyId: input.companyId,
      actor: input.actor,
      reason: "rotation",
    });
    const now = nowIso();
    await input.env.DB.prepare(
      `UPDATE credential_refs
       SET secret_ref = ?, status = 'valid', rotated_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(rotated.reference, now, now, input.credentialRefId, input.companyId)
      .run();
    await persistPublicConnectorConfig(
      input.env,
      instance,
      publicConfig,
      now,
    );
    await input.env.DB.prepare(
      `UPDATE connector_instances
       SET auth_status = 'configuring', health_message = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(
        "Replacement credentials stored securely. Connection test is not available for this connector yet.",
        now,
        input.instanceId,
        input.companyId,
      )
      .run();
    await recordAuditEvent(input.env.DB, {
      companyId: input.companyId,
      eventType: "credential.rotated",
      actor: input.actor,
      resourceType: "credential",
      resourceId: input.credentialRefId,
      detail: { connectorInstanceId: input.instanceId },
    });
    return { ok: true, reference: rotated.reference };
  } catch (error) {
    return mapSecretError(error);
  }
}

export async function revokeConnectorCredential(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return {
      ok: false,
      status: 404,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  const credentialRefId = instance.credentialRefId;
  if (!credentialRefId) {
    return { ok: true };
  }
  const row = await input.env.DB.prepare(
    `SELECT * FROM credential_refs WHERE id = ? AND company_id = ?`,
  )
    .bind(credentialRefId, input.companyId)
    .first();
  if (!row) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }

  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    await provider.revoke(String(row.secret_ref), {
      companyId: input.companyId,
      actor: input.actor,
      reason: "revocation",
    });
  } catch (error) {
    if (error instanceof CredentialSubmissionDisabledError) {
      // Binding-backed refs cannot be revoked here; still mark control-plane state.
    } else {
      return mapSecretError(error);
    }
  }

  const now = nowIso();
  await input.env.DB.prepare(
    `UPDATE credential_refs SET status = 'revoked', updated_at = ? WHERE id = ? AND company_id = ?`,
  )
    .bind(now, credentialRefId, input.companyId)
    .run();
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'revoked', status = 'disabled', credential_ref_id = NULL,
         health_message = 'Disconnected', updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(now, input.instanceId, input.companyId)
    .run();
  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "credential.revoked",
    actor: input.actor,
    resourceType: "credential",
    resourceId: credentialRefId,
    detail: { connectorInstanceId: input.instanceId },
  });
  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.disconnected",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { credentialRefId },
  });
  return { ok: true };
}

/**
 * Internal-only resolve. Never call from a customer-facing GET.
 */
export async function resolveConnectorCredentialForExecution(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  reason: "execution" | "test" | "token_refresh" | "mcp_resolve";
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: 403 | 404; code: string }
> {
  const companyCheck = await assertCompanyCanStore(input.env, input.companyId);
  if (!companyCheck.ok) {
    return { ok: false, status: 403, code: companyCheck.body.code };
  }
  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId || !instance.credentialRefId) {
    return { ok: false, status: 404, code: CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN };
  }
  const row = await input.env.DB.prepare(
    `SELECT * FROM credential_refs WHERE id = ? AND company_id = ?`,
  )
    .bind(instance.credentialRefId, input.companyId)
    .first();
  if (!row || String(row.status) === "revoked") {
    return { ok: false, status: 403, code: CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN };
  }
  if (
    row.connector_instance_id &&
    String(row.connector_instance_id) !== input.instanceId
  ) {
    return { ok: false, status: 403, code: CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN };
  }

  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    const value = await provider.resolve(String(row.secret_ref), {
      companyId: input.companyId,
      actor: input.actor,
      reason: input.reason,
    });
    if (!value) {
      return { ok: false, status: 404, code: CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN };
    }
    return { ok: true, payload: parseCredentialPayload(value) ?? { value } };
  } catch (error) {
    if (error instanceof SecretTenantMismatchError) {
      return { ok: false, status: 403, code: CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN };
    }
    return { ok: false, status: 403, code: CONNECTOR_ERROR_CODES.CREDENTIAL_CRYPTO_FAILED };
  }
}

export async function getConnectorCredentialMetadata(input: {
  env: Env;
  companyId: string;
  instanceId: string;
}): Promise<{
  stored: boolean;
  credentialRefId: string | null;
  status: string | null;
  lastUpdated: string | null;
  fields: Array<{ name: string; masked: true }>;
}> {
  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return {
      stored: false,
      credentialRefId: null,
      status: null,
      lastUpdated: null,
      fields: [],
    };
  }
  const definition = getConnectorById(instance.connectorDefinitionId);
  const fieldNames = Object.keys(
    (definition?.credentialSchema?.properties as Record<string, unknown> | undefined) ?? {},
  ).filter((name) => {
    const props = definition?.credentialSchema?.properties as Record<string, unknown>;
    return isSecretSchemaProperty(props?.[name]) || isSecretFieldName(name);
  });

  if (!instance.credentialRefId) {
    return {
      stored: false,
      credentialRefId: null,
      status: instance.authStatus ?? null,
      lastUpdated: null,
      fields: fieldNames.map((name) => ({ name, masked: true as const })),
    };
  }
  const row = await input.env.DB.prepare(
    `SELECT id, status, updated_at, rotated_at FROM credential_refs
     WHERE id = ? AND company_id = ?`,
  )
    .bind(instance.credentialRefId, input.companyId)
    .first();
  return {
    stored: Boolean(row) && String(row?.status) !== "revoked",
    credentialRefId: row ? String(row.id) : null,
    status: row ? String(row.status) : null,
    lastUpdated: row
      ? String(row.rotated_at ?? row.updated_at)
      : null,
    fields: fieldNames.map((name) => ({ name, masked: true as const })),
  };
}

export function connectorHasProviderTest(definitionId: string): boolean {
  return definitionId === "conn_xero" || definitionId === "conn_microsoft_365";
}

export function sanitizeConnectorConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return stripSecretFields(config ?? {});
}

export function publicCredentialView(detail: Record<string, unknown>): Record<string, unknown> {
  return redactSecretFields(detail);
}

export function safeConnectorErrorMessage(raw: string): string {
  return sanitizeCustomerError(raw);
}

async function persistPublicConnectorConfig(
  env: Env,
  instance: { id: string; companyId: string; config: Record<string, unknown> },
  publicConfig: Record<string, unknown>,
  now: string,
): Promise<void> {
  if (Object.keys(publicConfig).length === 0) return;
  const merged = sanitizeConnectorConfig({
    ...instance.config,
    ...publicConfig,
  });
  await env.DB.prepare(
    `UPDATE connector_instances
     SET config_json = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(JSON.stringify(merged), now, instance.id, instance.companyId)
    .run();
}

function mapSecretError(
  error: unknown,
): {
  ok: false;
  status: 403 | 409;
  body: ReturnType<typeof customerConnectorError>;
} {
  if (
    error instanceof CredentialSubmissionDisabledError ||
    error instanceof SecretStorageUnavailableError
  ) {
    return { ok: false, ...rejectPlaintextCredentialStore() };
  }
  if (error instanceof SecretTenantMismatchError) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  if (error instanceof SecretCryptoError) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_CRYPTO_FAILED),
    };
  }
  throw error;
}
