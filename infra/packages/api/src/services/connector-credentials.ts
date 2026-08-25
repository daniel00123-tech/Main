import {
  CONNECTOR_ERROR_CODES,
  customerConnectorError,
} from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import {
  CredentialSubmissionDisabledError,
  SecretTenantMismatchError,
  createSecretProvider,
  stripSecretFields,
  type SecretProvider,
} from "./secrets";
import type { Env } from "../env";

export function rejectPlaintextCredentialStore(): {
  status: 409;
  body: ReturnType<typeof customerConnectorError>;
} {
  return {
    status: 409,
    body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_SUBMISSION_DISABLED),
  };
}

export async function storeConnectorCredential(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  label: string;
  provider: string;
  secretValue: string;
  actor: string;
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true; credentialRefId: string; reference: string }
  | { ok: false; status: 403 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    const stored = await provider.store({
      companyId: input.companyId,
      purpose: "connector",
      value: input.secretValue,
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
    await input.env.DB.prepare(
      `UPDATE connector_instances
       SET credential_ref_id = ?, auth_status = 'connected', connected_at = ?,
           configured_by = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(id, now, input.actor, now, input.instanceId, input.companyId)
      .run();
    return { ok: true, credentialRefId: id, reference: stored.reference };
  } catch (error) {
    if (error instanceof CredentialSubmissionDisabledError) {
      return { ok: false, ...rejectPlaintextCredentialStore() };
    }
    if (error instanceof SecretTenantMismatchError) {
      return {
        ok: false,
        status: 403,
        body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
      };
    }
    throw error;
  }
}

export async function rotateConnectorCredential(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  credentialRefId: string;
  secretValue: string;
  actor: string;
  secretProvider?: SecretProvider;
}): Promise<
  | { ok: true; reference: string }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
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

  const provider = input.secretProvider ?? createSecretProvider(input.env);
  try {
    const rotated = await provider.rotate(String(row.secret_ref), input.secretValue, {
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
    return { ok: true, reference: rotated.reference };
  } catch (error) {
    if (error instanceof CredentialSubmissionDisabledError) {
      return { ok: false, ...rejectPlaintextCredentialStore() };
    }
    if (error instanceof SecretTenantMismatchError) {
      return {
        ok: false,
        status: 403,
        body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
      };
    }
    throw error;
  }
}

export function sanitizeConnectorConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return stripSecretFields(config ?? {});
}
