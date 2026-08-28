/**
 * Microsoft 365 connector status — app-only (primary) + delegated OAuth (future Outlook).
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  createOauthAuthorizationState,
} from "./connector-oauth";
import { MICROSOFT_GRAPH_SCOPES } from "@infra/shared";
import {
  microsoftAppConfigured,
  microsoftCredentialStatus,
  type MicrosoftAuthMode,
} from "./microsoft-auth";
import { isMicrosoftMultitenantApp } from "./microsoft-multitenant";

const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com";

export type MicrosoftOAuthComponent = "onedrive" | "sharepoint" | "outlook_shared" | "microsoft_365";

export function microsoftOAuthStatus(env: Env): {
  appConfigured: boolean;
  readyForConsent: boolean;
  authMode: MicrosoftAuthMode;
  tenantIdMasked: string | null;
  authorizationBaseUrl: string | null;
  components: Array<{ id: MicrosoftOAuthComponent; scopes: string[]; status: string }>;
  outlookStatus: string;
} {
  const creds = microsoftCredentialStatus(env);
  const configured = creds.configured;
  const multitenant = isMicrosoftMultitenantApp(env);

  return {
    appConfigured: configured,
    readyForConsent: configured,
    authMode: creds.authMode,
    tenantIdMasked: creds.tenantIdMasked,
    multitenantApp: multitenant,
    authorizationBaseUrl: configured
      ? `${MICROSOFT_AUTH_BASE}/${multitenant ? "organizations" : "common"}/v2.0/adminconsent`
      : null,
    components: [
      {
        id: "onedrive",
        scopes: [...MICROSOFT_GRAPH_SCOPES.onedrive],
        status: configured ? "connected" : "requires_authentication",
      },
      {
        id: "sharepoint",
        scopes: [...MICROSOFT_GRAPH_SCOPES.sharepoint],
        status: configured ? "connected" : "requires_authentication",
      },
      {
        id: "outlook_shared",
        scopes: [...MICROSOFT_GRAPH_SCOPES.outlook_shared],
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
          ...MICROSOFT_GRAPH_SCOPES.outlook_shared,
        ]),
      ];
  }
}

/** Delegated OAuth — retained for future interactive Outlook consent. OneDrive/SharePoint use app-only. */
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
      message:
        "Microsoft 365 platform app is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.",
    };
  }

  if (input.component === "outlook_shared" || input.component === "microsoft_365") {
    return {
      ok: false,
      code: "MICROSOFT_OUTLOOK_NOT_READY",
      message:
        "Outlook shared mailboxes require additional Mail.Read application permission. OneDrive and SharePoint use app-only authentication automatically.",
    };
  }

  const clientId = String(env.MICROSOFT_CLIENT_ID);
  const multitenant = isMicrosoftMultitenantApp(env);
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

  if (multitenant) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: oauthState.state,
    });
    return {
      ok: true,
      authorizationUrl: `${MICROSOFT_AUTH_BASE}/organizations/v2.0/adminconsent?${params.toString()}`,
      state: oauthState.state,
    };
  }

  const tenantId = String(env.MICROSOFT_TENANT_ID ?? "common");
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
    authorizationUrl: `${MICROSOFT_AUTH_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${params.toString()}`,
    state: oauthState.state,
  };
}

export async function exchangeMicrosoftAuthorizationCode(
  _env: Env,
  _input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<{ ok: false; code: string; message: string }> {
  return {
    ok: false,
    code: "MICROSOFT_DELEGATED_NOT_REQUIRED",
    message: "OneDrive and SharePoint use app-only authentication. Delegated OAuth is reserved for future Outlook flows.",
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
