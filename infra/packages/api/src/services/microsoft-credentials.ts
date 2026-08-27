/**
 * Per-company Microsoft Graph credential resolution.
 * Supports platform legacy (Caddington), platform multi-tenant SaaS, and BYO Entra apps.
 */

import type { MicrosoftConnectorAuthMode } from "@infra/shared";
import type { Env } from "../env";
import { getConnectorInstance } from "./control-plane";
import {
  parseCredentialPayload,
  resolveConnectorCredentialForExecution,
} from "./connector-credentials";

export type MicrosoftAppCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  authMode: MicrosoftConnectorAuthMode;
  credentialSource: "platform" | "company";
};

export type MicrosoftConnectorBinding = {
  instanceId: string;
  companyId: string;
  authMode: MicrosoftConnectorAuthMode | null;
  tenantId: string | null;
  credentialRefId: string | null;
  authStatus: string | null;
  consentedAt: string | null;
  consentedBy: string | null;
};

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function platformMicrosoftConfigured(env: Env): boolean {
  return Boolean(
    trim(env.MICROSOFT_TENANT_ID) &&
      trim(env.MICROSOFT_CLIENT_ID) &&
      trim(env.MICROSOFT_CLIENT_SECRET),
  );
}

export function platformMultitenantAppEnabled(env: Env): boolean {
  const flag = trim(env.MICROSOFT_MULTITENANT_APP).toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

export function platformMicrosoftCredentials(env: Env): MicrosoftAppCredentials | null {
  const tenantId = trim(env.MICROSOFT_TENANT_ID);
  const clientId = trim(env.MICROSOFT_CLIENT_ID);
  const clientSecret = trim(env.MICROSOFT_CLIENT_SECRET);
  if (!tenantId || !clientId || !clientSecret) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    authMode: "platform_legacy",
    credentialSource: "platform",
  };
}

export async function loadMicrosoftConnectorBinding(
  db: D1Database,
  input: { companyId: string; connectorInstanceId?: string | null },
): Promise<MicrosoftConnectorBinding | null> {
  let row: Record<string, unknown> | null = null;
  if (input.connectorInstanceId) {
    row = await db
      .prepare(
        `SELECT id, company_id, microsoft_auth_mode, microsoft_tenant_id, external_account_id,
                credential_ref_id, auth_status, microsoft_consented_at, microsoft_consented_by
         FROM connector_instances
         WHERE id = ? AND company_id = ? AND connector_definition_id = 'conn_microsoft_365'
         LIMIT 1`,
      )
      .bind(input.connectorInstanceId, input.companyId)
      .first();
  } else {
    row = await db
      .prepare(
        `SELECT id, company_id, microsoft_auth_mode, microsoft_tenant_id, external_account_id,
                credential_ref_id, auth_status, microsoft_consented_at, microsoft_consented_by
         FROM connector_instances
         WHERE company_id = ? AND connector_definition_id = 'conn_microsoft_365'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(input.companyId)
      .first();
  }
  if (!row) return null;
  const tenantId =
    trim(row.microsoft_tenant_id) || trim(row.external_account_id) || null;
  return {
    instanceId: String(row.id),
    companyId: String(row.company_id),
    authMode: row.microsoft_auth_mode
      ? (String(row.microsoft_auth_mode) as MicrosoftConnectorAuthMode)
      : null,
    tenantId,
    credentialRefId: row.credential_ref_id ? String(row.credential_ref_id) : null,
    authStatus: row.auth_status ? String(row.auth_status) : null,
    consentedAt: row.microsoft_consented_at ? String(row.microsoft_consented_at) : null,
    consentedBy: row.microsoft_consented_by ? String(row.microsoft_consented_by) : null,
  };
}

export function inferMicrosoftAuthMode(
  env: Env,
  binding: MicrosoftConnectorBinding | null,
): MicrosoftConnectorAuthMode | null {
  if (binding?.authMode) return binding.authMode;
  if (binding?.credentialRefId) return "company_app";
  if (
    platformMicrosoftConfigured(env) &&
    binding?.tenantId &&
    trim(env.MICROSOFT_TENANT_ID) === binding.tenantId
  ) {
    return "platform_legacy";
  }
  if (binding?.tenantId && binding.authStatus === "connected") {
    return platformMultitenantAppEnabled(env) ? "platform_multitenant" : "company_app";
  }
  return null;
}

export async function loadCompanyMicrosoftAppCredentials(
  env: Env,
  companyId: string,
  instanceId: string,
  actor = "system",
): Promise<
  | { ok: true; credentials: MicrosoftAppCredentials }
  | { ok: false; code: string; message: string }
> {
  const resolved = await resolveConnectorCredentialForExecution({
    env,
    companyId,
    instanceId,
    actor,
    reason: "execution",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: "Microsoft app credentials are not stored for this company.",
    };
  }
  const payload = resolved.payload ?? {};
  const tenantId = trim(payload.tenantId);
  const clientId = trim(payload.clientId);
  const clientSecret = trim(payload.clientSecret);
  if (!tenantId || !clientId || !clientSecret) {
    return {
      ok: false,
      code: "MICROSOFT_COMPANY_APP_INCOMPLETE",
      message: "Stored Microsoft credentials must include tenantId, clientId, and clientSecret.",
    };
  }
  return {
    ok: true,
    credentials: {
      tenantId,
      clientId,
      clientSecret,
      authMode: "company_app",
      credentialSource: "company",
    },
  };
}

export async function resolveMicrosoftAppCredentials(
  env: Env,
  db: D1Database,
  input?: {
    companyId?: string;
    connectorInstanceId?: string;
    actor?: string;
  },
): Promise<
  | { ok: true; credentials: MicrosoftAppCredentials; binding: MicrosoftConnectorBinding | null }
  | { ok: false; code: string; message: string }
> {
  const binding =
    input?.companyId != null
      ? await loadMicrosoftConnectorBinding(db, {
          companyId: input.companyId,
          connectorInstanceId: input.connectorInstanceId,
        })
      : null;

  const authMode = inferMicrosoftAuthMode(env, binding);

  if (authMode === "company_app") {
    if (!binding || !input?.companyId) {
      return {
        ok: false,
        code: "MICROSOFT_COMPANY_APP_MISSING",
        message: "Microsoft 365 is not connected for this company.",
      };
    }
    const companyCreds = await loadCompanyMicrosoftAppCredentials(
      env,
      input.companyId,
      binding.instanceId,
      input.actor,
    );
    if (!companyCreds.ok) return companyCreds;
    const tenantId = binding.tenantId ?? companyCreds.credentials.tenantId;
    return {
      ok: true,
      binding,
      credentials: { ...companyCreds.credentials, tenantId },
    };
  }

  if (authMode === "platform_multitenant") {
    const platform = platformMicrosoftCredentials(env);
    if (!platform) {
      return {
        ok: false,
        code: "MICROSOFT_NOT_CONFIGURED",
        message: "Platform Microsoft 365 application is not configured.",
      };
    }
    const tenantId = binding?.tenantId;
    if (!tenantId) {
      return {
        ok: false,
        code: "MICROSOFT_TENANT_NOT_BOUND",
        message: "Microsoft tenant admin consent is required before sync can run.",
      };
    }
    return {
      ok: true,
      binding,
      credentials: {
        ...platform,
        tenantId,
        authMode: "platform_multitenant",
      },
    };
  }

  if (authMode === "platform_legacy" || (!authMode && platformMicrosoftConfigured(env))) {
    const platform = platformMicrosoftCredentials(env);
    if (!platform) {
      return {
        ok: false,
        code: "MICROSOFT_NOT_CONFIGURED",
        message: "Microsoft 365 app credentials are not configured.",
      };
    }
    const tenantId = binding?.tenantId ?? platform.tenantId;
    return {
      ok: true,
      binding,
      credentials: { ...platform, tenantId, authMode: "platform_legacy" },
    };
  }

  const platform = platformMicrosoftCredentials(env);
  if (platform && !input?.companyId) {
    return {
      ok: true,
      binding,
      credentials: platform,
    };
  }

  return {
    ok: false,
    code: "MICROSOFT_NOT_CONNECTED",
    message: "Microsoft 365 is not connected for this company. Complete onboarding in the portal.",
  };
}

export function maskMicrosoftTenantId(tenantId: string): string {
  if (tenantId.length <= 8) return "****";
  return `${tenantId.slice(0, 4)}…${tenantId.slice(-4)}`;
}

export async function ensureMicrosoftLegacyBinding(
  env: Env,
  db: D1Database,
  input: { companyId: string; connectorInstanceId: string; actor: string },
): Promise<void> {
  if (!platformMicrosoftConfigured(env)) return;
  const platformTenant = trim(env.MICROSOFT_TENANT_ID);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE connector_instances
       SET microsoft_auth_mode = COALESCE(microsoft_auth_mode, 'platform_legacy'),
           microsoft_tenant_id = COALESCE(microsoft_tenant_id, ?, external_account_id),
           external_account_id = COALESCE(external_account_id, ?),
           auth_status = COALESCE(auth_status, 'connected'),
           connected_at = COALESCE(connected_at, ?),
           configured_by = COALESCE(configured_by, ?),
           updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(platformTenant, platformTenant, now, input.actor, now, input.connectorInstanceId, input.companyId)
    .run();
}

export function parseStoredMicrosoftCredentialFields(
  payload: Record<string, unknown> | null,
): { tenantId: string | null; clientId: string | null; hasClientSecret: boolean } {
  if (!payload) {
    return { tenantId: null, clientId: null, hasClientSecret: false };
  }
  return {
    tenantId: trim(payload.tenantId) || null,
    clientId: trim(payload.clientId) || null,
    hasClientSecret: Boolean(trim(payload.clientSecret)),
  };
}

export async function readMicrosoftInstanceConfig(
  env: Env,
  companyId: string,
  instanceId: string,
): Promise<Record<string, unknown>> {
  const instance = await getConnectorInstance(env.DB, instanceId);
  if (!instance || instance.companyId !== companyId) return {};
  return instance.config ?? {};
}

export { parseCredentialPayload };
