/**
 * Microsoft 365 connector onboarding — admin consent + BYO Entra app credentials.
 * OneDrive/SharePoint use app-only Graph tokens. Outlook remains out of scope.
 */

import {
  CONNECTOR_ERROR_CODES,
  MICROSOFT_APP_PERMISSIONS,
  MICROSOFT_GRAPH_SCOPES,
  MICROSOFT_OAUTH_CALLBACK_PATH,
  customerConnectorError,
  type MicrosoftConnectorAuthMode,
} from "@infra/shared";
import type { Env } from "../env";
import { infraPublicApiBase, portalOrigin as canonicalPortalOrigin } from "./public-urls";
import { newId, nowIso } from "../db/mappers";
import {
  createOauthAuthorizationState,
  consumeOauthAuthorizationState,
} from "./connector-oauth";
import {
  microsoftAppConfigured,
  microsoftCredentialStatus,
  acquireMicrosoftAppToken,
  type MicrosoftAuthMode,
} from "./microsoft-auth";
import {
  inferMicrosoftAuthMode,
  loadMicrosoftConnectorBinding,
  maskMicrosoftTenantId,
  platformMultitenantAppEnabled,
  platformMicrosoftConfigured,
} from "./microsoft-credentials";
import {
  getCompanyById,
  getConnectorInstance,
  recordAuditEvent,
} from "./control-plane";
import { revokeConnectorCredential } from "./connector-credentials";
import { wrappingKeyConfigured } from "./secrets";

const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com";

export type MicrosoftOAuthComponent = "onedrive" | "sharepoint" | "outlook_shared" | "microsoft_365";

export function microsoftRedirectUri(env: Env): string {
  const override =
    typeof env.MICROSOFT_REDIRECT_URI === "string" ? env.MICROSOFT_REDIRECT_URI.trim() : "";
  if (override) return override;
  return `${infraPublicApiBase(env)}${MICROSOFT_OAUTH_CALLBACK_PATH}`;
}

export function portalMicrosoftReturnUrl(
  env: Env,
  slug: string,
  query: Record<string, string>,
): string {
  const params = new URLSearchParams(query);
  return `${canonicalPortalOrigin(env)}/portal/${encodeURIComponent(slug)}/microsoft-365?${params.toString()}`;
}

export function microsoftOAuthStatus(env: Env): {
  appConfigured: boolean;
  readyForConsent: boolean;
  authMode: MicrosoftAuthMode;
  tenantIdMasked: string | null;
  authorizationBaseUrl: string | null;
  multitenantAppEnabled: boolean;
  onboardingModes: MicrosoftConnectorAuthMode[];
  appPermissions: readonly string[];
  components: Array<{ id: MicrosoftOAuthComponent; scopes: string[]; status: string }>;
  outlookStatus: string;
} {
  const creds = microsoftCredentialStatus(env);
  const configured = creds.configured;
  const onboardingModes: MicrosoftConnectorAuthMode[] = ["company_app"];
  if (configured && creds.multitenantAppEnabled) onboardingModes.unshift("platform_multitenant");
  if (configured) onboardingModes.unshift("platform_legacy");

  return {
    appConfigured: configured,
    readyForConsent: configured && wrappingKeyConfigured(env as Record<string, unknown>),
    authMode: creds.authMode,
    tenantIdMasked: creds.tenantIdMasked,
    authorizationBaseUrl: configured
      ? `${MICROSOFT_AUTH_BASE}/common/v2.0/adminconsent`
      : null,
    multitenantAppEnabled: creds.multitenantAppEnabled,
    onboardingModes,
    appPermissions: MICROSOFT_APP_PERMISSIONS,
    components: [
      {
        id: "onedrive",
        scopes: [...MICROSOFT_APP_PERMISSIONS.filter((s) => s.includes("Files"))],
        status: configured ? "connected" : "requires_authentication",
      },
      {
        id: "sharepoint",
        scopes: [...MICROSOFT_APP_PERMISSIONS.filter((s) => s.includes("Sites") || s.includes("Files"))],
        status: configured ? "connected" : "requires_authentication",
      },
      {
        id: "outlook_shared",
        scopes: ["Mail.Read (out of scope for Sprint 2)"],
        status: "requires_additional_permission",
      },
    ],
    outlookStatus: "requires_mail_read_application_permission",
  };
}

export { microsoftAppConfigured, microsoftCredentialStatus };

export function scopesForMicrosoftComponent(component: MicrosoftOAuthComponent): string[] {
  switch (component) {
    case "onedrive":
      return [...MICROSOFT_GRAPH_SCOPES.onedrive];
    case "sharepoint":
      return [...MICROSOFT_GRAPH_SCOPES.sharepoint];
    case "outlook_shared":
      return [...MICROSOFT_GRAPH_SCOPES.outlook_shared];
    case "microsoft_365":
      return [
        ...new Set([
          ...MICROSOFT_GRAPH_SCOPES.onedrive,
          ...MICROSOFT_GRAPH_SCOPES.sharepoint,
        ]),
      ];
  }
}

function isValidTenantId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function ensureMicrosoftConnectorInstance(input: {
  env: Env;
  companyId: string;
  companyName: string;
  instanceId?: string | null;
  actor: string;
  authMode: MicrosoftConnectorAuthMode;
}): Promise<
  | { ok: true; instanceId: string }
  | { ok: false; code: string; message: string; status: 403 | 404 | 409 }
> {
  const company = await getCompanyById(input.env.DB, input.companyId);
  if (!company || ["suspended", "archived", "closed"].includes(company.status)) {
    return {
      ok: false,
      status: 403,
      code: "COMPANY_INACTIVE",
      message: "Company cannot connect Microsoft 365 in its current state.",
    };
  }

  if (input.instanceId) {
    const existing = await getConnectorInstance(input.env.DB, input.instanceId);
    if (!existing || existing.companyId !== input.companyId) {
      return {
        ok: false,
        status: 403,
        code: "CONNECTOR_FORBIDDEN",
        message: "Connector instance does not belong to this company.",
      };
    }
    return { ok: true, instanceId: existing.id };
  }

  const listed = await input.env.DB.prepare(
    `SELECT id FROM connector_instances
     WHERE company_id = ? AND connector_definition_id = 'conn_microsoft_365'
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(input.companyId)
    .first();
  if (listed?.id) {
    return { ok: true, instanceId: String(listed.id) };
  }

  const instanceId = newId("ci");
  const now = nowIso();
  await input.env.DB.prepare(
    `INSERT INTO connector_instances (
      id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
      auth_status, health_status, health_message, managed_by, configured_by, microsoft_auth_mode,
      created_at, updated_at
    ) VALUES (?, ?, 'conn_microsoft_365', ?, 'draft', '{}', ?, 'configuring', 'unknown',
      'Awaiting Microsoft admin consent', 'infra', ?, ?, ?, ?)`,
  )
    .bind(
      instanceId,
      input.companyId,
      `${company.name} · Microsoft 365`,
      JSON.stringify({ enabled: false, mode: "scheduled", schedule: null }),
      input.actor,
      input.authMode,
      now,
      now,
    )
    .run();
  return { ok: true, instanceId };
}

function adminConsentTenantForMode(
  env: Env,
  authMode: MicrosoftConnectorAuthMode,
  storedTenantId?: string | null,
): string {
  if (authMode === "company_app" && storedTenantId) return storedTenantId;
  if (authMode === "platform_multitenant") return "organizations";
  return String(env.MICROSOFT_TENANT_ID ?? "organizations").trim() || "organizations";
}

function resolveOAuthClientId(
  env: Env,
  authMode: MicrosoftConnectorAuthMode,
  companyClientId?: string | null,
): string | null {
  if (authMode === "company_app") return companyClientId?.trim() || null;
  return typeof env.MICROSOFT_CLIENT_ID === "string" ? env.MICROSOFT_CLIENT_ID.trim() : null;
}

/** Start Microsoft 365 admin consent onboarding (OneDrive + SharePoint). */
export async function startMicrosoftConnect(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  userId: string;
  actor: string;
  instanceId?: string | null;
  authMode?: MicrosoftConnectorAuthMode;
  returnPath?: string | null;
}): Promise<
  | {
      ok: true;
      authorizationUrl: string;
      state: string;
      instanceId: string;
      authMode: MicrosoftConnectorAuthMode;
      expiresAt: string;
    }
  | { ok: false; code: string; message: string; status?: number }
> {
  if (!wrappingKeyConfigured(input.env as Record<string, unknown>)) {
    return {
      ok: false,
      code: "CREDENTIAL_STORAGE_DISABLED",
      message: "Encrypted credential storage is required for Microsoft 365 onboarding.",
      status: 409,
    };
  }

  const requestedMode = input.authMode ?? "platform_multitenant";
  if (requestedMode === "platform_legacy") {
    return {
      ok: false,
      code: "MICROSOFT_LEGACY_OPERATOR_ONLY",
      message: "Platform legacy mode is reserved for the existing production tenant.",
    };
  }
  if (requestedMode === "platform_multitenant") {
    if (!platformMicrosoftConfigured(input.env)) {
      return {
        ok: false,
        code: "MICROSOFT_APP_NOT_CONFIGURED",
        message: "Platform Microsoft application secrets are not configured.",
        status: 409,
      };
    }
    if (!platformMultitenantAppEnabled(input.env)) {
      return {
        ok: false,
        code: "MICROSOFT_MULTITENANT_NOT_ENABLED",
        message:
          "Platform multi-tenant onboarding requires Entra app configuration by the operator (MICROSOFT_MULTITENANT_APP).",
        status: 409,
      };
    }
  }

  const company = await getCompanyById(input.env.DB, input.companyId);
  if (!company) {
    return { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found.", status: 404 };
  }

  const ensured = await ensureMicrosoftConnectorInstance({
    env: input.env,
    companyId: input.companyId,
    companyName: company.name,
    instanceId: input.instanceId,
    actor: input.actor,
    authMode: requestedMode,
  });
  if (!ensured.ok) {
    return { ok: false, code: ensured.code, message: ensured.message, status: ensured.status };
  }

  let storedTenantId: string | null = null;
  let storedClientId: string | null = null;
  if (requestedMode === "company_app") {
    const binding = await loadMicrosoftConnectorBinding(input.env.DB, {
      companyId: input.companyId,
      connectorInstanceId: ensured.instanceId,
    });
    if (!binding?.credentialRefId) {
      return {
        ok: false,
        code: "MICROSOFT_COMPANY_APP_REQUIRED",
        message: "Save your Entra tenant ID, client ID, and client secret before connecting.",
        status: 409,
      };
    }
    const { loadCompanyMicrosoftAppCredentials } = await import("./microsoft-credentials");
    const creds = await loadCompanyMicrosoftAppCredentials(
      input.env,
      input.companyId,
      ensured.instanceId,
      input.actor,
    );
    if (!creds.ok) {
      return { ok: false, code: creds.code, message: creds.message, status: 409 };
    }
    storedTenantId = creds.credentials.tenantId;
    storedClientId = creds.credentials.clientId;
  }

  const clientId = resolveOAuthClientId(input.env, requestedMode, storedClientId);
  if (!clientId) {
    return {
      ok: false,
      code: "MICROSOFT_CLIENT_ID_MISSING",
      message: "Microsoft client ID is not available for this onboarding mode.",
      status: 409,
    };
  }

  const redirectUri = microsoftRedirectUri(input.env);
  const consentTenant = adminConsentTenantForMode(input.env, requestedMode, storedTenantId);
  const oauthState = await createOauthAuthorizationState(
    input.env.DB,
    {
      companyId: input.companyId,
      userId: input.userId,
      definitionId: "conn_microsoft_365",
      instanceId: ensured.instanceId,
      redirectUri,
      scopes: [...MICROSOFT_APP_PERMISSIONS],
      returnPath: input.returnPath ?? `/portal/${input.companySlug}/microsoft-365`,
    },
    input.env as Record<string, unknown>,
  );

  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'configuring', microsoft_auth_mode = ?, health_message = ?,
         configured_by = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      requestedMode,
      "Awaiting Microsoft admin consent",
      input.actor,
      nowIso(),
      ensured.instanceId,
      input.companyId,
    )
    .run();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: oauthState.state,
  });

  return {
    ok: true,
    authorizationUrl: `${MICROSOFT_AUTH_BASE}/${encodeURIComponent(consentTenant)}/v2.0/adminconsent?${params.toString()}`,
    state: oauthState.state,
    instanceId: ensured.instanceId,
    authMode: requestedMode,
    expiresAt: oauthState.expiresAt,
  };
}

/** @deprecated Use startMicrosoftConnect — retained for route compatibility. */
export async function startMicrosoftOAuth(
  db: D1Database,
  env: Env,
  input: {
    companyId: string;
    userId: string;
    definitionId: string;
    instanceId?: string | null;
    component?: MicrosoftOAuthComponent;
    returnPath?: string | null;
    authMode?: MicrosoftConnectorAuthMode;
    companySlug?: string;
    actor?: string;
  },
): Promise<
  | { ok: true; authorizationUrl: string; state: string; instanceId?: string }
  | { ok: false; code: string; message: string }
> {
  if (input.component === "outlook_shared" || input.component === "microsoft_365") {
    return {
      ok: false,
      code: "MICROSOFT_OUTLOOK_NOT_READY",
      message:
        "Outlook shared mailboxes require additional Mail.Read application permission and remain out of scope.",
    };
  }

  const company = await getCompanyById(env.DB, input.companyId);
  const slug =
    input.companySlug ??
    (company?.slug ? String(company.slug) : "company");

  const started = await startMicrosoftConnect({
    env,
    companyId: input.companyId,
    companySlug: slug,
    userId: input.userId,
    actor: input.actor ?? input.userId,
    instanceId: input.instanceId,
    authMode: input.authMode ?? "platform_multitenant",
    returnPath: input.returnPath,
  });
  if (!started.ok) {
    return { ok: false, code: started.code, message: started.message };
  }
  return {
    ok: true,
    authorizationUrl: started.authorizationUrl,
    state: started.state,
    instanceId: started.instanceId,
  };
}

export async function handleMicrosoftAdminConsentCallback(input: {
  env: Env;
  state: string;
  adminConsent?: string | null;
  tenant?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  sessionUserId?: string | null;
}): Promise<{ redirectTo: string }> {
  const consumed = await consumeOauthAuthorizationState(
    input.env.DB,
    { state: input.state, userId: input.sessionUserId ?? undefined },
    input.env as Record<string, unknown>,
  );

  const company = consumed.ok
    ? await getCompanyById(input.env.DB, consumed.value.companyId)
    : null;
  const slug = company?.slug ? String(company.slug) : "company";
  const returnPath = consumed.ok
    ? consumed.value.returnPath ?? `/portal/${slug}/microsoft-365`
    : `/portal/${slug}/microsoft-365`;

  if (!consumed.ok) {
    return {
      redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
        microsoft: "error",
        reason: "invalid_state",
      }),
    };
  }

  if (input.error) {
    await recordAuditEvent(input.env.DB, {
      companyId: consumed.value.companyId,
      eventType: "connector.connection_failed",
      actor: consumed.value.userId,
      resourceType: "connector",
      resourceId: consumed.value.instanceId ?? "conn_microsoft_365",
      detail: {
        provider: "microsoft_365",
        error: input.error,
        errorDescription: input.errorDescription ?? null,
      },
    });
    return {
      redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
        microsoft: "error",
        reason: input.error,
      }),
    };
  }

  const tenantId = String(input.tenant ?? "").trim();
  if (input.adminConsent !== "True" || !isValidTenantId(tenantId)) {
    await recordAuditEvent(input.env.DB, {
      companyId: consumed.value.companyId,
      eventType: "connector.connection_failed",
      actor: consumed.value.userId,
      resourceType: "connector",
      resourceId: consumed.value.instanceId ?? "conn_microsoft_365",
      detail: { provider: "microsoft_365", reason: "invalid_admin_consent_response" },
    });
    return {
      redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
        microsoft: "error",
        reason: "invalid_tenant",
      }),
    };
  }

  const instanceId = consumed.value.instanceId;
  if (!instanceId) {
    return {
      redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
        microsoft: "error",
        reason: "missing_instance",
      }),
    };
  }

  const instance = await getConnectorInstance(input.env.DB, instanceId);
  if (!instance || instance.companyId !== consumed.value.companyId) {
    return {
      redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
        microsoft: "error",
        reason: "connector_forbidden",
      }),
    };
  }

  const authModeRow = await input.env.DB.prepare(
    `SELECT microsoft_auth_mode FROM connector_instances WHERE id = ? LIMIT 1`,
  )
    .bind(instanceId)
    .first<{ microsoft_auth_mode: string | null }>();
  const authMode =
    (authModeRow?.microsoft_auth_mode as MicrosoftConnectorAuthMode | undefined) ??
    "platform_multitenant";

  if (authMode === "company_app") {
    const { loadCompanyMicrosoftAppCredentials } = await import("./microsoft-credentials");
    const creds = await loadCompanyMicrosoftAppCredentials(
      input.env,
      consumed.value.companyId,
      instanceId,
      consumed.value.userId,
    );
    if (creds.ok && creds.credentials.tenantId !== tenantId) {
      await recordAuditEvent(input.env.DB, {
        companyId: consumed.value.companyId,
        eventType: "connector.connection_failed",
        actor: consumed.value.userId,
        resourceType: "connector",
        resourceId: instanceId,
        detail: {
          provider: "microsoft_365",
          reason: "tenant_substitution_blocked",
          expectedTenant: maskMicrosoftTenantId(creds.credentials.tenantId),
          receivedTenant: maskMicrosoftTenantId(tenantId),
        },
      });
      return {
        redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
          microsoft: "error",
          reason: "tenant_mismatch",
        }),
      };
    }
  }

  const now = nowIso();
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET microsoft_tenant_id = ?, external_account_id = ?, display_account_name = ?,
         auth_status = 'connected', status = 'configured', connected_at = ?,
         microsoft_consented_at = ?, microsoft_consented_by = ?,
         health_status = 'healthy', health_message = 'Microsoft admin consent granted',
         last_health_at = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      tenantId,
      tenantId,
      `Microsoft tenant ${maskMicrosoftTenantId(tenantId)}`,
      now,
      now,
      consumed.value.userId,
      now,
      now,
      instanceId,
      consumed.value.companyId,
    )
    .run();

  await recordAuditEvent(input.env.DB, {
    companyId: consumed.value.companyId,
    eventType: "connector.connected",
    actor: consumed.value.userId,
    resourceType: "connector",
    resourceId: instanceId,
    detail: {
      provider: "microsoft_365",
      authMode,
      tenantId: maskMicrosoftTenantId(tenantId),
      adminConsent: true,
    },
  });

  return {
    redirectTo: portalMicrosoftReturnUrl(input.env, slug, {
      microsoft: "connected",
      tenant: maskMicrosoftTenantId(tenantId),
    }),
  };
}

export async function testMicrosoftConnection(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
}): Promise<{ tested: boolean; ok: boolean; message: string; tenantIdMasked?: string | null }> {
  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return { tested: true, ok: false, message: "Connector not found." };
  }

  const token = await acquireMicrosoftAppToken(input.env, {
    companyId: input.companyId,
    connectorInstanceId: input.instanceId,
    actor: input.actor,
  });

  const now = nowIso();
  if (!token.ok) {
    await input.env.DB.prepare(
      `UPDATE connector_instances
       SET health_status = 'unhealthy', health_message = ?, last_health_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(token.message, now, now, input.instanceId, input.companyId)
      .run();
    return { tested: true, ok: false, message: token.message };
  }

  const { probeMicrosoftGraph } = await import("./microsoft-graph");
  const graph = await probeMicrosoftGraph({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  });

  const healthy = graph.ok;
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET health_status = ?, health_message = ?, provider_health = ?, last_health_at = ?,
         auth_status = CASE WHEN auth_status = 'configuring' THEN 'connected' ELSE auth_status END,
         updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      healthy ? "healthy" : "unhealthy",
      graph.ok ? "Microsoft Graph reachable" : graph.message,
      healthy ? "healthy" : "unhealthy",
      now,
      now,
      input.instanceId,
      input.companyId,
    )
    .run();

  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.health_checked",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "microsoft_365", graphOk: graph.ok },
  });

  return {
    tested: true,
    ok: healthy,
    message: graph.ok ? "Microsoft Graph connection healthy." : graph.message,
    tenantIdMasked: maskMicrosoftTenantId(token.tenantId),
  };
}

export async function disconnectMicrosoft(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
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

  const authMode = inferMicrosoftAuthMode(
    input.env,
    await loadMicrosoftConnectorBinding(input.env.DB, {
      companyId: input.companyId,
      connectorInstanceId: input.instanceId,
    }),
  );

  if (authMode === "platform_legacy") {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED),
    };
  }

  if (instance.credentialRefId) {
    const revoked = await revokeConnectorCredential({
      env: input.env,
      companyId: input.companyId,
      instanceId: input.instanceId,
      actor: input.actor,
    });
    if (!revoked.ok) return revoked;
  }

  const now = nowIso();
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'revoked', status = 'draft', connected_at = NULL,
         microsoft_tenant_id = NULL, external_account_id = NULL, display_account_name = NULL,
         microsoft_consented_at = NULL, microsoft_consented_by = NULL,
         health_status = 'unknown', health_message = 'Disconnected',
         updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(now, input.instanceId, input.companyId)
    .run();

  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.disconnected",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "microsoft_365" },
  });

  return { ok: true };
}

export function publicMicrosoftView(input: {
  instance: {
    authStatus?: string | null;
    externalAccountId?: string | null;
    displayAccountName?: string | null;
    connectedAt?: string | null;
    lastHealthAt?: string | null;
    healthStatus?: string | null;
    healthMessage?: string | null;
    credentialRefId?: string | null;
    config?: Record<string, unknown>;
  };
  binding: Awaited<ReturnType<typeof loadMicrosoftConnectorBinding>>;
  authMode: MicrosoftConnectorAuthMode | null;
}): Record<string, unknown> {
  const tenantId = input.binding?.tenantId ?? input.instance.externalAccountId ?? null;
  return {
    authMode: input.authMode,
    tenantIdMasked: tenantId ? maskMicrosoftTenantId(tenantId) : null,
    tenantBound: Boolean(tenantId),
    connected: input.instance.authStatus === "connected",
    connectedAt: input.instance.connectedAt ?? null,
    lastHealthAt: input.instance.lastHealthAt ?? null,
    healthStatus: input.instance.healthStatus ?? null,
    healthMessage: input.instance.healthMessage ?? null,
    companyAppConfigured: Boolean(input.instance.credentialRefId),
    consentedAt: input.binding?.consentedAt ?? null,
    outlookSelfService: false,
  };
}

export async function getMicrosoftConnectorPublicView(
  env: Env,
  companyId: string,
  instanceId: string,
): Promise<Record<string, unknown>> {
  const instance = await getConnectorInstance(env.DB, instanceId);
  if (!instance || instance.companyId !== companyId) return {};
  const binding = await loadMicrosoftConnectorBinding(env.DB, {
    companyId,
    connectorInstanceId: instanceId,
  });
  const authMode = inferMicrosoftAuthMode(env, binding);
  return publicMicrosoftView({ instance, binding, authMode });
}

export async function exchangeMicrosoftAuthorizationCode(
  _env: Env,
  _input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<{ ok: false; code: string; message: string }> {
  return {
    ok: false,
    code: "MICROSOFT_DELEGATED_NOT_REQUIRED",
    message: "OneDrive and SharePoint use admin consent + app-only tokens. Delegated OAuth is reserved for future Outlook flows.",
  };
}

export async function listMicrosoftConnectorSources(
  db: D1Database,
  companyId: string,
  connectorInstanceId?: string | null,
) {
  const { listMicrosoftSources } = await import("./microsoft-sync");
  return listMicrosoftSources(db, companyId, connectorInstanceId);
}

export async function upsertMicrosoftConnectorSource(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceType: string;
    externalId: string;
    displayName: string;
    pathOrUrl?: string | null;
    mailboxAddress?: string | null;
    inclusionStatus?: string;
    syncStatus?: string;
  },
) {
  const id = newId("mss");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO microsoft_connector_sources (
        id, company_id, connector_instance_id, source_type, external_id, display_name,
        path_or_url, mailbox_address, inclusion_status, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        inclusion_status = excluded.inclusion_status,
        sync_status = excluded.sync_status,
        updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      input.sourceType,
      input.externalId,
      input.displayName,
      input.pathOrUrl ?? null,
      input.mailboxAddress ?? null,
      input.inclusionStatus ?? "available",
      input.syncStatus ?? "pending",
      now,
      now,
    )
    .run();
  return id;
}
