import {
  CONNECTOR_ERROR_CODES,
  XERO_AUTH,
  XERO_CLIENT_ID_SECRET,
  XERO_CLIENT_SECRET_SECRET,
  XERO_DEFAULT_REDIRECT_URI,
  XERO_REDIRECT_URI_SECRET,
  XERO_SCOPE_REASONS,
  XERO_WRITE_ACTIVATION,
  customerConnectorError,
  missingScopesForTier,
  scopesForTier,
  tierFromGrantedScopes,
} from "@infra/shared";
import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  getCompanyById,
  getConnectorInstance,
  recordAuditEvent,
} from "./control-plane";
import {
  createSecretProvider,
  wrappingKeyConfigured,
  type SecretProvider,
} from "./secrets";
import {
  parseCredentialPayload,
  revokeConnectorCredential,
  rotateConnectorCredential,
  serializeCredentialPayload,
  storeConnectorCredential,
} from "./connector-credentials";
import {
  createOauthAuthorizationState,
  consumeOauthAuthorizationState,
  oauthAppNotConfigured,
} from "./connector-oauth";
import { syncActiveServiceIdentityScopesForCompany } from "./service-identity-scopes";
import { sanitizeCustomerError } from "./secrets";

const REFRESH_SKEW_MS = 2 * 60 * 1000;
const REFRESH_LOCK_MS = 30 * 1000;

export type XeroOrganisationOption = {
  tenantId: string;
  connectionId: string | null;
  name: string;
};

export type XeroCredentialPayload = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: string;
  scopes: string[];
  providerTenantId: string | null;
  connectionId: string | null;
  organisationName: string | null;
};

export function xeroAppConfigured(env: Env): boolean {
  const id = env[XERO_CLIENT_ID_SECRET];
  const secret = env[XERO_CLIENT_SECRET_SECRET];
  return typeof id === "string" && Boolean(id.trim()) &&
    typeof secret === "string" && Boolean(secret.trim());
}

export function xeroOauthStatus(env: Env): {
  appConfigured: boolean;
  storageEnabled: boolean;
  redirectUri: string;
  scopes: string[];
  writeScopes: string[];
  readyToConnect: boolean;
  writesSupported: boolean;
  writesEnabled: boolean;
} {
  return {
    appConfigured: xeroAppConfigured(env),
    storageEnabled: wrappingKeyConfigured(env as Record<string, unknown>),
    redirectUri: xeroRedirectUri(env),
    scopes: [...XERO_AUTH.requiredScopes],
    writeScopes: [...XERO_AUTH.writeScopes],
    readyToConnect:
      xeroAppConfigured(env) && wrappingKeyConfigured(env as Record<string, unknown>),
    writesSupported: XERO_WRITE_ACTIVATION.writesSupported,
    writesEnabled: XERO_WRITE_ACTIVATION.writesEnabled,
  };
}

export function xeroRedirectUri(env: Env): string {
  const override = env[XERO_REDIRECT_URI_SECRET];
  if (typeof override === "string" && override.trim()) return override.trim();
  return XERO_DEFAULT_REDIRECT_URI;
}

function xeroClientId(env: Env): string {
  const value = env[XERO_CLIENT_ID_SECRET];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("XERO_APP_NOT_CONFIGURED");
  }
  return value.trim();
}

function xeroClientSecret(env: Env): string {
  const value = env[XERO_CLIENT_SECRET_SECRET];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("XERO_APP_NOT_CONFIGURED");
  }
  return value.trim();
}

function portalOrigin(env: Env): string {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("https://"));
  return allowed[0] || "https://infra-web.pages.dev";
}

export function portalXeroReturnUrl(
  env: Env,
  slug: string,
  query: Record<string, string>,
): string {
  const params = new URLSearchParams(query);
  return `${portalOrigin(env)}/portal/${encodeURIComponent(slug)}/connectors?${params}`;
}

function basicAuth(env: Env): string {
  return btoa(`${xeroClientId(env)}:${xeroClientSecret(env)}`);
}

async function parseJsonSafe(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: text };
  } catch {
    return { raw: text };
  }
}

export async function startXeroOAuth(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  userId: string;
  actor: string;
  instanceId?: string | null;
}): Promise<
  | { ok: true; authorizationUrl: string; expiresAt: string; instanceId: string }
  | { ok: false; status: 403 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  if (!wrappingKeyConfigured(input.env as Record<string, unknown>)) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_SUBMISSION_DISABLED),
    };
  }
  if (!xeroAppConfigured(input.env)) {
    return { ok: false, status: 409, body: oauthAppNotConfigured() };
  }

  const company = await getCompanyById(input.env.DB, input.companyId);
  if (!company || ["suspended", "archived", "closed"].includes(company.status)) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(
        company?.status === "suspended"
          ? CONNECTOR_ERROR_CODES.SUSPENDED
          : CONNECTOR_ERROR_CODES.COMPANY_INACTIVE,
      ),
    };
  }

  let instanceId = input.instanceId ?? null;
  if (instanceId) {
    const existing = await getConnectorInstance(input.env.DB, instanceId);
    if (!existing || existing.companyId !== input.companyId) {
      return {
        ok: false,
        status: 403,
        body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
      };
    }
  } else {
    const listed = await input.env.DB.prepare(
      `SELECT id FROM connector_instances
       WHERE company_id = ? AND connector_definition_id = 'conn_xero'
       ORDER BY created_at ASC LIMIT 1`,
    )
      .bind(input.companyId)
      .first();
    if (listed?.id) {
      instanceId = String(listed.id);
    } else {
      instanceId = newId("ci");
      const now = nowIso();
      await input.env.DB.prepare(
        `INSERT INTO connector_instances (
          id, company_id, connector_definition_id, name, status, config_json,
          sync_settings_json, data_environment_id, last_sync_at, last_sync_status,
          last_sync_message, health_status, health_message, auth_status, sync_health,
          provider_health, managed_by, configured_by, created_at, updated_at
        ) VALUES (?, ?, 'conn_xero', ?, 'draft', '{}', ?, NULL, NULL, NULL, NULL,
          'unknown', 'Connecting to Xero', 'configuring', 'not_applicable', 'unknown',
          'infra', ?, ?, ?)`,
      )
        .bind(
          instanceId,
          input.companyId,
          `${company.name} · Xero`,
          JSON.stringify({ enabled: false, mode: "manual", schedule: null }),
          input.actor,
          now,
          now,
        )
        .run();
    }
  }

  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'configuring', health_message = 'Connecting to Xero',
         updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(nowIso(), instanceId, input.companyId)
    .run();

  const redirectUri = xeroRedirectUri(input.env);
  const scopes = [...XERO_AUTH.requiredScopes];
  const state = await createOauthAuthorizationState(
    input.env.DB,
    {
      companyId: input.companyId,
      userId: input.userId,
      definitionId: "conn_xero",
      instanceId,
      redirectUri,
      scopes,
      returnPath: `/portal/${input.companySlug}/connectors`,
    },
    input.env as Record<string, unknown>,
  );

  const url = new URL(XERO_AUTH.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", xeroClientId(input.env));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state.state);
  url.searchParams.set("code_challenge", state.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.setup_started",
    actor: input.actor,
    resourceType: "connector",
    resourceId: instanceId,
    detail: { flow: "oauth", provider: "xero", scopes },
  });

  return {
    ok: true,
    authorizationUrl: url.toString(),
    expiresAt: state.expiresAt,
    instanceId,
  };
}

/** Deliberate admin scope upgrade — adds write tier scopes via OAuth re-consent. */
export async function startXeroScopeUpgrade(input: {
  env: Env;
  companyId: string;
  companySlug: string;
  userId: string;
  actor: string;
  instanceId: string;
}): Promise<
  | { ok: true; authorizationUrl: string; expiresAt: string; instanceId: string; requestedScopes: string[] }
  | { ok: false; status: 403 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  if (!wrappingKeyConfigured(input.env as Record<string, unknown>)) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_SUBMISSION_DISABLED),
    };
  }
  if (!xeroAppConfigured(input.env)) {
    return { ok: false, status: 409, body: oauthAppNotConfigured() };
  }

  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }
  if (instance.connectorDefinitionId !== "conn_xero") {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }

  const granted = Array.isArray(instance.capabilitiesEnabled)
    ? instance.capabilitiesEnabled.map(String)
    : [];
  const missing = missingScopesForTier(granted, "write");
  if (missing.length === 0) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }

  const redirectUri = xeroRedirectUri(input.env);
  const scopes = scopesForTier("write");
  const state = await createOauthAuthorizationState(
    input.env.DB,
    {
      companyId: input.companyId,
      userId: input.userId,
      definitionId: "conn_xero",
      instanceId: input.instanceId,
      redirectUri,
      scopes,
      returnPath: `/portal/${input.companySlug}/connectors`,
    },
    input.env as Record<string, unknown>,
  );

  const url = new URL(XERO_AUTH.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", xeroClientId(input.env));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state.state);
  url.searchParams.set("code_challenge", state.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.scope_upgrade_started",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "xero", requestedScopes: missing },
  });

  return {
    ok: true,
    authorizationUrl: url.toString(),
    expiresAt: state.expiresAt,
    instanceId: input.instanceId,
    requestedScopes: missing,
  };
}

export async function handleXeroOAuthCallback(input: {
  env: Env;
  state: string;
  code?: string | null;
  error?: string | null;
  sessionUserId?: string | null;
}): Promise<{ redirectTo: string }> {
  const failed = async (slug: string, reason: string) => {
    await recordAuditEvent(input.env.DB, {
      eventType: "connector.connection_failed",
      actor: input.sessionUserId ?? "xero-oauth",
      resourceType: "connector",
      resourceId: "conn_xero",
      detail: { reason, tokenPersisted: false, provider: "xero" },
    });
    return {
      redirectTo: portalXeroReturnUrl(input.env, slug || "unknown", {
        xero: "error",
        reason,
      }),
    };
  };

  if (input.error) {
    return failed("unknown", "provider_denied");
  }
  const consumed = await consumeOauthAuthorizationState(
    input.env.DB,
    {
      state: input.state,
      userId: input.sessionUserId ?? undefined,
    },
    input.env as Record<string, unknown>,
  );
  if (!consumed.ok) {
    return failed("unknown", "state_invalid");
  }
  const bound = consumed.value;
  if (bound.definitionId !== "conn_xero") {
    return failed("unknown", "state_invalid");
  }
  const company = await getCompanyById(input.env.DB, bound.companyId);
  const slug = company?.slug ?? "unknown";
  if (!input.code || !bound.codeVerifier || !bound.instanceId) {
    return failed(slug, "missing_code");
  }

  try {
    const tokenResponse = await fetch(XERO_AUTH.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(input.env)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: bound.redirectUri ?? xeroRedirectUri(input.env),
        code_verifier: bound.codeVerifier,
      }),
    });
    const tokenBody = await parseJsonSafe(tokenResponse);
    if (!tokenResponse.ok) {
      await recordAuditEvent(input.env.DB, {
        companyId: bound.companyId,
        eventType: "connector.connection_failed",
        actor: input.sessionUserId ?? "xero-oauth",
        resourceType: "connector",
        resourceId: bound.instanceId,
        detail: {
          reason: "token_exchange_failed",
          status: tokenResponse.status,
          tokenPersisted: false,
        },
      });
      return failed(slug, "token_exchange_failed");
    }

    const accessToken = String(tokenBody.access_token ?? "");
    const refreshToken = String(tokenBody.refresh_token ?? "");
    if (!accessToken || !refreshToken) {
      return failed(slug, "token_exchange_failed");
    }
    const expiresIn = Number(tokenBody.expires_in ?? 1800);
    const expiresAt = new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString();
    const scopes = String(tokenBody.scope ?? bound.scopes.join(" "))
      .split(/\s+/)
      .filter(Boolean);

    const connections = await listXeroConnections(accessToken);
    const organisations = connections.map((item) => ({
      tenantId: item.tenantId,
      connectionId: item.id,
      name: item.tenantName,
    }));

    const payload: XeroCredentialPayload = {
      accessToken,
      refreshToken,
      expiresAt,
      tokenType: String(tokenBody.token_type ?? "Bearer"),
      scopes,
      providerTenantId: organisations.length === 1 ? organisations[0]!.tenantId : null,
      connectionId: organisations.length === 1 ? organisations[0]!.connectionId : null,
      organisationName: organisations.length === 1 ? organisations[0]!.name : null,
    };

    const stored = await persistXeroPayload({
      env: input.env,
      companyId: bound.companyId,
      instanceId: bound.instanceId,
      actor: input.sessionUserId ?? "xero-oauth",
      payload,
      organisations,
      connected: organisations.length === 1,
    });
    if (!stored.ok) {
      return failed(slug, "persist_failed");
    }

    await recordAuditEvent(input.env.DB, {
      companyId: bound.companyId,
      eventType: organisations.length === 1 ? "connector.connected" : "connector.setup_started",
      actor: input.sessionUserId ?? "xero-oauth",
      resourceType: "connector",
      resourceId: bound.instanceId,
      detail: {
        provider: "xero",
        organisationCount: organisations.length,
        organisationName: payload.organisationName,
        tokenPersisted: true,
      },
    });

    if (organisations.length === 1) {
      await syncActiveServiceIdentityScopesForCompany(
        input.env.DB,
        bound.companyId,
      );
    }

    if (organisations.length !== 1) {
      return {
        redirectTo: portalXeroReturnUrl(input.env, slug, {
          xero: "select_org",
          instance: bound.instanceId,
        }),
      };
    }
    return {
      redirectTo: portalXeroReturnUrl(input.env, slug, {
        xero: "connected",
        instance: bound.instanceId,
      }),
    };
  } catch {
    return failed(slug, "callback_failed");
  }
}

async function persistXeroPayload(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  payload: XeroCredentialPayload;
  organisations: XeroOrganisationOption[];
  connected: boolean;
}): Promise<{ ok: boolean }> {
  const instance = await getConnectorInstance(input.env.DB, input.instanceId);
  if (!instance || instance.companyId !== input.companyId) return { ok: false };
  const value = serializeCredentialPayload(input.payload as unknown as Record<string, unknown>);
  const provider = createSecretProvider(input.env);
  let credentialRefId = instance.credentialRefId;
  if (credentialRefId) {
    const rotated = await rotateConnectorCredential({
      env: input.env,
      companyId: input.companyId,
      instanceId: input.instanceId,
      credentialRefId,
      secretValue: value,
      actor: input.actor,
      secretProvider: provider,
    });
    if (!rotated.ok) {
      const stored = await storeConnectorCredential({
        env: input.env,
        companyId: input.companyId,
        instanceId: input.instanceId,
        label: "Xero OAuth",
        provider: "conn_xero",
        secretValue: value,
        actor: input.actor,
        secretProvider: provider,
      });
      if (!stored.ok) return { ok: false };
      credentialRefId = stored.credentialRefId;
    }
  } else {
    const stored = await storeConnectorCredential({
      env: input.env,
      companyId: input.companyId,
      instanceId: input.instanceId,
      label: "Xero OAuth",
      provider: "conn_xero",
      secretValue: value,
      actor: input.actor,
      secretProvider: provider,
    });
    if (!stored.ok) return { ok: false };
    credentialRefId = stored.credentialRefId;
  }

  const now = nowIso();
  const publicConfig = {
    ...(instance.config ?? {}),
    pendingOrganisations: input.connected ? [] : input.organisations,
    grantedScopes: input.payload.scopes,
    scopeReasons: XERO_SCOPE_REASONS,
  };
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET credential_ref_id = ?, auth_status = ?, status = ?,
         external_account_id = ?, display_account_name = ?,
         connected_at = ?, health_status = ?, provider_health = ?,
         health_message = ?, last_health_at = ?, last_error_code = NULL,
         last_error_message = NULL, config_json = ?, capabilities_enabled_json = ?,
         updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      credentialRefId,
      input.connected ? "connected" : "configuring",
      input.connected ? "healthy" : "configured",
      input.payload.providerTenantId,
      input.payload.organisationName,
      input.connected ? now : null,
      input.connected ? "healthy" : "unknown",
      input.connected ? "healthy" : "unknown",
      input.connected
        ? `Connected to ${input.payload.organisationName ?? "Xero"}`
        : "Select the Xero organisation to finish connecting",
      input.connected ? now : null,
      JSON.stringify(publicConfig),
      JSON.stringify(input.payload.scopes),
      now,
      input.instanceId,
      input.companyId,
    )
    .run();
  return { ok: true };
}

type XeroConnection = {
  id: string | null;
  tenantId: string;
  tenantName: string;
};

async function listXeroConnections(accessToken: string): Promise<XeroConnection[]> {
  const response = await fetch(XERO_AUTH.connectionsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        id: row.id ? String(row.id) : null,
        tenantId: String(row.tenantId ?? ""),
        tenantName: String(row.tenantName ?? "Xero organisation"),
      };
    })
    .filter((item) => item.tenantId);
}

export async function selectXeroOrganisation(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  tenantId: string;
  actor: string;
}): Promise<
  | { ok: true; organisationName: string }
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
  const pending = Array.isArray(instance.config?.pendingOrganisations)
    ? (instance.config.pendingOrganisations as XeroOrganisationOption[])
    : [];
  const chosen = pending.find((item) => item.tenantId === input.tenantId);
  if (!chosen) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }
  const resolved = await resolveXeroPayload(input.env, input.companyId, input.instanceId, input.actor);
  if (!resolved.ok) return resolved;
  const next: XeroCredentialPayload = {
    ...resolved.payload,
    providerTenantId: chosen.tenantId,
    connectionId: chosen.connectionId,
    organisationName: chosen.name,
  };
  const persisted = await persistXeroPayload({
    env: input.env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
    payload: next,
    organisations: [],
    connected: true,
  });
  if (!persisted.ok) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_CRYPTO_FAILED),
    };
  }
  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.connected",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "xero", organisationName: chosen.name },
  });
  await syncActiveServiceIdentityScopesForCompany(input.env.DB, input.companyId);
  return { ok: true, organisationName: chosen.name };
}

export async function resolveXeroPayload(
  env: Env,
  companyId: string,
  instanceId: string,
  actor: string,
  secretProvider?: SecretProvider,
): Promise<
  | { ok: true; payload: XeroCredentialPayload; instanceId: string }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const { resolveConnectorCredentialForExecution } = await import("./connector-credentials");
  const resolved = await resolveConnectorCredentialForExecution({
    env,
    companyId,
    instanceId,
    actor,
    reason: "execution",
    secretProvider,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.status,
      body: customerConnectorError(
        resolved.code === CONNECTOR_ERROR_CODES.SUSPENDED
          ? CONNECTOR_ERROR_CODES.SUSPENDED
          : CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN,
      ),
    };
  }
  const payload = parsedXeroPayload(resolved.payload);
  if (!payload) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_CRYPTO_FAILED),
    };
  }
  return { ok: true, payload, instanceId };
}

function parsedXeroPayload(raw: Record<string, unknown>): XeroCredentialPayload | null {
  const accessToken = String(raw.accessToken ?? raw.access_token ?? "");
  const refreshToken = String(raw.refreshToken ?? raw.refresh_token ?? "");
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: String(raw.expiresAt ?? raw.expires_at ?? ""),
    tokenType: String(raw.tokenType ?? "Bearer"),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : [],
    providerTenantId: raw.providerTenantId ? String(raw.providerTenantId) : null,
    connectionId: raw.connectionId ? String(raw.connectionId) : null,
    organisationName: raw.organisationName ? String(raw.organisationName) : null,
  };
}

export async function getValidXeroAccessToken(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  reason: "test" | "token_refresh" | "mcp_resolve" | "action_execute" | "action_verify" | "dry_run";
}): Promise<
  | { ok: true; accessToken: string; tenantId: string; payload: XeroCredentialPayload }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const resolved = await resolveXeroPayload(
    input.env,
    input.companyId,
    input.instanceId,
    input.actor,
  );
  if (!resolved.ok) return resolved;
  let payload = resolved.payload;
  const expiresAt = Date.parse(payload.expiresAt);
  const needsRefresh = !Number.isFinite(expiresAt) || expiresAt <= Date.now() + REFRESH_SKEW_MS;
  if (needsRefresh) {
    const instance = await getConnectorInstance(input.env.DB, input.instanceId);
    const config = (instance?.config ?? {}) as Record<string, unknown>;
    const lockUntil = Date.parse(String(config.refreshLockUntil ?? ""));
    if (Number.isFinite(lockUntil) && lockUntil > Date.now()) {
      const retry = await resolveXeroPayload(
        input.env,
        input.companyId,
        input.instanceId,
        input.actor,
      );
      if (retry.ok) {
        const retryExpires = Date.parse(retry.payload.expiresAt);
        if (Number.isFinite(retryExpires) && retryExpires > Date.now() + REFRESH_SKEW_MS) {
          payload = retry.payload;
        }
      }
    }
    const stillNeeds =
      !Number.isFinite(Date.parse(payload.expiresAt)) ||
      Date.parse(payload.expiresAt) <= Date.now() + REFRESH_SKEW_MS;
    if (stillNeeds) {
      await input.env.DB.prepare(
        `UPDATE connector_instances
         SET config_json = json_set(COALESCE(config_json, '{}'), '$.refreshLockUntil', ?),
             updated_at = ?
         WHERE id = ? AND company_id = ?`,
      )
        .bind(new Date(Date.now() + REFRESH_LOCK_MS).toISOString(), nowIso(), input.instanceId, input.companyId)
        .run();
      const refreshed = await refreshXeroTokens({
        env: input.env,
        companyId: input.companyId,
        instanceId: input.instanceId,
        actor: input.actor,
        payload,
      });
      await input.env.DB.prepare(
        `UPDATE connector_instances
         SET config_json = json_remove(COALESCE(config_json, '{}'), '$.refreshLockUntil'),
             updated_at = ?
         WHERE id = ? AND company_id = ?`,
      )
        .bind(nowIso(), input.instanceId, input.companyId)
        .run();
      if (!refreshed.ok) return refreshed;
      payload = refreshed.payload;
    }
  }
  if (!payload.providerTenantId) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }
  return {
    ok: true,
    accessToken: payload.accessToken,
    tenantId: payload.providerTenantId,
    payload,
  };
}

async function refreshXeroTokens(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  payload: XeroCredentialPayload;
}): Promise<
  | { ok: true; payload: XeroCredentialPayload }
  | { ok: false; status: 409; body: ReturnType<typeof customerConnectorError> }
> {
  try {
    const response = await fetch(XERO_AUTH.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(input.env)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.payload.refreshToken,
      }),
    });
    const body = await parseJsonSafe(response);
    if (!response.ok) {
      await markAuthExpired(input.env, input.companyId, input.instanceId, "refresh_failed");
      await recordAuditEvent(input.env.DB, {
        companyId: input.companyId,
        eventType: "connector.authentication_expired",
        actor: input.actor,
        resourceType: "connector",
        resourceId: input.instanceId,
        detail: { provider: "xero", reason: "refresh_failed", status: response.status },
      });
      return {
        ok: false,
        status: 409,
        body: customerConnectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED),
      };
    }
    const accessToken = String(body.access_token ?? "");
    const refreshToken = String(body.refresh_token ?? input.payload.refreshToken);
    if (!accessToken) {
      await markAuthExpired(input.env, input.companyId, input.instanceId, "refresh_failed");
      return {
        ok: false,
        status: 409,
        body: customerConnectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED),
      };
    }
    const expiresIn = Number(body.expires_in ?? 1800);
    const next: XeroCredentialPayload = {
      ...input.payload,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString(),
      scopes: String(body.scope ?? input.payload.scopes.join(" "))
        .split(/\s+/)
        .filter(Boolean),
    };
    await persistXeroPayload({
      env: input.env,
      companyId: input.companyId,
      instanceId: input.instanceId,
      actor: input.actor,
      payload: next,
      organisations: [],
      connected: Boolean(next.providerTenantId),
    });
    await recordAuditEvent(input.env.DB, {
      companyId: input.companyId,
      eventType: "credential.rotated",
      actor: input.actor,
      resourceType: "connector",
      resourceId: input.instanceId,
      detail: { provider: "xero", reason: "token_refresh", billed: false },
    });
    return { ok: true, payload: next };
  } catch {
    await markAuthExpired(input.env, input.companyId, input.instanceId, "refresh_failed");
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED),
    };
  }
}

async function markAuthExpired(
  env: Env,
  companyId: string,
  instanceId: string,
  reason: string,
) {
  await env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'auth_expired', provider_health = 'degraded',
         health_message = ?, last_error_code = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind("Authentication expired — reconnect Xero", reason, nowIso(), instanceId, companyId)
    .run();
}

export async function testXeroConnection(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
}): Promise<{
  tested: boolean;
  code?: string;
  message: string;
  organisationName?: string | null;
}> {
  const token = await getValidXeroAccessToken({
    env: input.env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
    reason: "test",
  });
  if (!token.ok) {
    await recordAuditEvent(input.env.DB, {
      companyId: input.companyId,
      eventType: "credential.validation_failed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: input.instanceId,
      detail: { provider: "xero", billed: false, code: token.body.code },
    });
    return {
      tested: false,
      code: token.body.code,
      message: token.body.error,
    };
  }
  const response = await fetch(`${XERO_AUTH.apiBaseUrl}/Organisation`, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Xero-tenant-id": token.tenantId,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      await markAuthExpired(input.env, input.companyId, input.instanceId, "test_unauthorized");
    }
    await recordAuditEvent(input.env.DB, {
      companyId: input.companyId,
      eventType: "credential.validation_failed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: input.instanceId,
      detail: { provider: "xero", billed: false, status: response.status },
    });
    return {
      tested: false,
      code: CONNECTOR_ERROR_CODES.PROVIDER_UNAVAILABLE,
      message: sanitizeCustomerError("Xero could not confirm this connection"),
    };
  }
  const body = (await response.json()) as {
    Organisations?: Array<{ Name?: string }>;
  };
  const organisationName =
    body.Organisations?.[0]?.Name ?? token.payload.organisationName ?? "Xero";
  const now = nowIso();
  await input.env.DB.prepare(
    `UPDATE connector_instances
     SET auth_status = 'connected', status = 'healthy', health_status = 'healthy',
         provider_health = 'healthy', display_account_name = ?,
         last_successful_sync_at = ?, last_health_at = ?, health_message = ?,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      organisationName,
      now,
      now,
      `Connected to ${organisationName}`,
      now,
      input.instanceId,
      input.companyId,
    )
    .run();
  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "credential.validation_succeeded",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "xero", billed: false, organisationName },
  });
  return {
    tested: true,
    message: `Connected to ${organisationName}`,
    organisationName,
  };
}

export async function disconnectXero(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const resolved = await resolveXeroPayload(
    input.env,
    input.companyId,
    input.instanceId,
    input.actor,
  );
  if (resolved.ok && resolved.payload.connectionId && resolved.payload.accessToken) {
    try {
      await fetch(`${XERO_AUTH.connectionsUrl}/${resolved.payload.connectionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${resolved.payload.accessToken}` },
      });
    } catch {
      // Local revoke still proceeds.
    }
  }
  const revoked = await revokeConnectorCredential({
    env: input.env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
  });
  if (!revoked.ok) return revoked;
  await recordAuditEvent(input.env.DB, {
    companyId: input.companyId,
    eventType: "connector.disconnected",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.instanceId,
    detail: { provider: "xero" },
  });
  await syncActiveServiceIdentityScopesForCompany(input.env.DB, input.companyId);
  return { ok: true };
}

export function publicXeroView(instance: {
  displayAccountName?: string | null;
  externalAccountId?: string | null;
  authStatus?: string | null;
  connectedAt?: string | null;
  lastHealthAt?: string | null;
  lastSuccessfulSyncAt?: string | null;
  capabilitiesEnabled?: string[] | null;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const pending = Array.isArray(instance.config?.pendingOrganisations)
    ? (instance.config?.pendingOrganisations as XeroOrganisationOption[])
    : [];
  const grantedScopes = Array.isArray(instance.capabilitiesEnabled)
    ? instance.capabilitiesEnabled
    : Array.isArray(instance.config?.grantedScopes)
      ? instance.config?.grantedScopes
      : [];
  const scopeTier = tierFromGrantedScopes(grantedScopes.map(String));
  const missingWriteScopes = missingScopesForTier(grantedScopes.map(String), "write");
  const activation = XERO_WRITE_ACTIVATION;
  return {
    organisationName: instance.displayAccountName ?? null,
    organisationSelected: Boolean(instance.externalAccountId),
    pendingOrganisations: pending.map((item) => ({
      tenantId: item.tenantId,
      name: item.name,
    })),
    authStatus: instance.authStatus ?? null,
    connectedAt: instance.connectedAt ?? null,
    lastCheckedAt: instance.lastHealthAt ?? instance.lastSuccessfulSyncAt ?? null,
    grantedScopes,
    scopeTier,
    scopeTierLabel: scopeTier === "write" ? "Read + Write (OAuth)" : "Read access",
    writeScopesConsented: missingWriteScopes.length === 0,
    writesSupported: activation.writesSupported,
    writesEnabled: activation.writesEnabled,
    writeCapabilityMessage:
      missingWriteScopes.length > 0
        ? "Read access connected — additional approval required to enable financial write capabilities."
        : activation.writesEnabled
          ? "Read + Write OAuth scopes consented. INFRA role permissions still control who may execute writes."
          : "Write OAuth scopes consented — production financial write execution remains disabled pending operator approval.",
    missingWriteScopes,
  };
}

export { parseCredentialPayload };
