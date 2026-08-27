/**
 * Microsoft 365 OAuth foundation — tenant-scoped, PKCE, state validation.
 * Interactive admin consent required before live token exchange.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  createOauthAuthorizationState,
  pkceS256Challenge,
} from "./connector-oauth";
import { MICROSOFT_GRAPH_SCOPES } from "@infra/shared";

const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com";

export type MicrosoftOAuthComponent = "onedrive" | "sharepoint" | "outlook_shared" | "microsoft_365";

export function microsoftAppConfigured(env: Env): boolean {
  const clientId = env.MICROSOFT_CLIENT_ID;
  return typeof clientId === "string" && Boolean(clientId.trim());
}

export function microsoftOAuthStatus(env: Env): {
  appConfigured: boolean;
  readyForConsent: boolean;
  authorizationBaseUrl: string | null;
  components: Array<{ id: MicrosoftOAuthComponent; scopes: string[]; status: string }>;
} {
  const configured = microsoftAppConfigured(env);
  return {
    appConfigured: configured,
    readyForConsent: configured && Boolean(env.INFRA_CREDENTIAL_WRAPPING_KEY),
    authorizationBaseUrl: configured ? `${MICROSOFT_AUTH_BASE}/common/oauth2/v2.0/authorize` : null,
    components: [
      { id: "onedrive", scopes: [...MICROSOFT_GRAPH_SCOPES.onedrive], status: configured ? "requires_authentication" : "not_configured" },
      { id: "sharepoint", scopes: [...MICROSOFT_GRAPH_SCOPES.sharepoint], status: configured ? "requires_authentication" : "not_configured" },
      { id: "outlook_shared", scopes: [...MICROSOFT_GRAPH_SCOPES.outlook_shared], status: configured ? "requires_authentication" : "not_configured" },
    ],
  };
}

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
          ...MICROSOFT_GRAPH_SCOPES.outlook_shared,
        ]),
      ];
  }
}

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
  },
): Promise<
  | { ok: true; authorizationUrl: string; state: string }
  | { ok: false; code: string; message: string }
> {
  if (!microsoftAppConfigured(env)) {
    return {
      ok: false,
      code: "MICROSOFT_APP_NOT_CONFIGURED",
      message: "Microsoft 365 app registration is not configured. Daniel must supply tenant app credentials.",
    };
  }

  const clientId = String(env.MICROSOFT_CLIENT_ID);
  const redirectUri =
    typeof env.MICROSOFT_REDIRECT_URI === "string" && env.MICROSOFT_REDIRECT_URI.trim()
      ? env.MICROSOFT_REDIRECT_URI.trim()
      : `${String(env.INFRA_PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/connectors/microsoft/oauth/callback`;

  const component = input.component ?? "microsoft_365";
  const scopes = scopesForMicrosoftComponent(component);
  const oauthState = await createOauthAuthorizationState(
    db,
    {
      companyId: input.companyId,
      userId: input.userId,
      definitionId: input.definitionId,
      instanceId: input.instanceId ?? null,
      redirectUri,
      scopes,
      returnPath: input.returnPath ?? null,
    },
    env as Record<string, unknown>,
  );

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes.join(" "),
    state: oauthState.state,
    code_challenge: oauthState.codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });

  return {
    ok: true,
    authorizationUrl: `${MICROSOFT_AUTH_BASE}/common/oauth2/v2.0/authorize?${params.toString()}`,
    state: oauthState.state,
  };
}

/** Placeholder for token exchange — requires Daniel's app secret and live consent. */
export async function exchangeMicrosoftAuthorizationCode(
  _env: Env,
  _input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<{ ok: false; code: string; message: string }> {
  return {
    ok: false,
    code: "MICROSOFT_CONSENT_REQUIRED",
    message: "Microsoft token exchange requires operator-supplied app credentials and completed admin consent.",
  };
}

export async function listMicrosoftConnectorSources(
  db: D1Database,
  companyId: string,
  connectorInstanceId?: string | null,
) {
  const query = connectorInstanceId
    ? `SELECT * FROM microsoft_connector_sources WHERE company_id = ? AND connector_instance_id = ? ORDER BY display_name`
    : `SELECT * FROM microsoft_connector_sources WHERE company_id = ? ORDER BY source_type, display_name`;
  const binds = connectorInstanceId ? [companyId, connectorInstanceId] : [companyId];
  const result = await db.prepare(query).bind(...binds).all();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    connectorInstanceId: String(row.connector_instance_id),
    sourceType: String(row.source_type),
    externalId: String(row.external_id),
    displayName: String(row.display_name),
    pathOrUrl: row.path_or_url ? String(row.path_or_url) : null,
    mailboxAddress: row.mailbox_address ? String(row.mailbox_address) : null,
    inclusionStatus: String(row.inclusion_status),
    syncStatus: String(row.sync_status),
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  }));
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
