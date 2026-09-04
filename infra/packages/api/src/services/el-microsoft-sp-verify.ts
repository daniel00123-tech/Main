/**
 * Fresh EL Microsoft service-principal + token proof.
 * Does not rotate secrets, reconnect Microsoft, or create a new app.
 */

import type { Env } from "../env";
import { platformMultitenantAppEnabled } from "./microsoft-credentials";
import { discoverEntraTenantIdFromDomain } from "./outlook-graph-access";

export const EL_GRAPH_TENANT_ID = "af32e619-3647-44a2-85d9-1c45457c0e91";
export const EL_GRAPH_APP_ID = "e5fd0533-ce51-43b8-999c-152f1e268246";

type TokenAttempt = {
  ok: boolean;
  tenantId: string;
  tokenUrl: string;
  clientIdUsed: string;
  httpStatus: number | null;
  errorCode: string | null;
  error: string | null;
  aadsts: string | null;
};

type ServicePrincipalProof = {
  exists: "YES" | "NO" | "UNKNOWN";
  objectId: string | null;
  appId: string;
  tenantId: string;
  accountEnabled: boolean | null;
  displayName: string | null;
  appOwnerOrganizationId: string | null;
  queryStatus: string;
};

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function aadstsCode(message: string | null): string | null {
  const match = (message ?? "").match(/AADSTS\d+/);
  return match?.[0] ?? null;
}

async function requestClientCredentials(input: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenAttempt & { accessToken?: string }> {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    const error = payload.error_description ?? payload.error ?? (!response.ok ? `HTTP ${response.status}` : null);
    return {
      ok: Boolean(response.ok && payload.access_token),
      tenantId: input.tenantId,
      tokenUrl,
      clientIdUsed: input.clientId,
      httpStatus: response.status,
      errorCode: payload.error ?? (response.ok ? null : `HTTP_${response.status}`),
      error,
      aadsts: aadstsCode(error),
      accessToken: payload.access_token,
    };
  } catch (err) {
    return {
      ok: false,
      tenantId: input.tenantId,
      tokenUrl,
      clientIdUsed: input.clientId,
      httpStatus: null,
      errorCode: "NETWORK",
      error: err instanceof Error ? err.message : String(err),
      aadsts: null,
    };
  }
}

async function graphJson(
  accessToken: string,
  path: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; error: string | null }> {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const err = body && typeof body.error === "object" && body.error
      ? String((body.error as { message?: string }).message ?? response.status)
      : `HTTP ${response.status}`;
    return { ok: false, status: response.status, body, error: err };
  }
  return { ok: true, status: response.status, body, error: null };
}

function firstRow(body: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = body?.value;
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object") return null;
  return value[0] as Record<string, unknown>;
}

async function queryServicePrincipal(
  accessToken: string,
  tenantId: string,
  appId: string,
): Promise<ServicePrincipalProof> {
  const filter = encodeURIComponent(`appId eq '${appId}'`);
  const listed = await graphJson(
    accessToken,
    `/servicePrincipals?$filter=${filter}&$select=id,appId,displayName,accountEnabled,appOwnerOrganizationId`,
  );
  if (listed.ok) {
    const row = firstRow(listed.body);
    if (row?.id) {
      return {
        exists: "YES",
        objectId: String(row.id),
        appId,
        tenantId,
        accountEnabled: typeof row.accountEnabled === "boolean" ? row.accountEnabled : null,
        displayName: typeof row.displayName === "string" ? row.displayName : null,
        appOwnerOrganizationId: typeof row.appOwnerOrganizationId === "string" ? row.appOwnerOrganizationId : null,
        queryStatus: "GRAPH_SERVICE_PRINCIPALS",
      };
    }
    return {
      exists: "NO",
      objectId: null,
      appId,
      tenantId,
      accountEnabled: null,
      displayName: null,
      appOwnerOrganizationId: null,
      queryStatus: "GRAPH_SERVICE_PRINCIPALS_EMPTY",
    };
  }
  return {
    exists: "UNKNOWN",
    objectId: null,
    appId,
    tenantId,
    accountEnabled: null,
    displayName: null,
    appOwnerOrganizationId: null,
    queryStatus: `GRAPH_SP_QUERY_DENIED:${listed.status}:${listed.error}`,
  };
}

export async function verifyElMicrosoftServicePrincipal(env: Env): Promise<Record<string, unknown>> {
  const boundClientId = trim(env.MICROSOFT_CLIENT_ID);
  const boundHomeTenant = trim(env.MICROSOFT_TENANT_ID);
  const boundSecret = trim(env.MICROSOFT_CLIENT_SECRET);
  const domainTenant = await discoverEntraTenantIdFromDomain("elvexpropertyservices.com");

  const bindingAudit = {
    boundClientId: boundClientId || null,
    boundHomeTenantId: boundHomeTenant || null,
    clientIdMatchesExpected: boundClientId === EL_GRAPH_APP_ID,
    homeTenantIsElTenant: boundHomeTenant === EL_GRAPH_TENANT_ID,
    clientSecretConfigured: Boolean(boundSecret),
    tenantIdConfigured: Boolean(boundHomeTenant),
    clientIdConfigured: Boolean(boundClientId),
    multitenantAppEnabled: platformMultitenantAppEnabled(env),
    elCompanyMicrosoft365Row: "missing",
    tokenEndpointUsedForEl: `https://login.microsoftonline.com/${EL_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    wrongTenantBinding: boundHomeTenant ? boundHomeTenant !== EL_GRAPH_TENANT_ID : null,
    wrongClientIdBinding: boundClientId ? boundClientId !== EL_GRAPH_APP_ID : true,
  };

  if (!boundClientId || !boundSecret) {
    return {
      expected: { tenantId: EL_GRAPH_TENANT_ID, appId: EL_GRAPH_APP_ID },
      bindingAudit,
      tokenElTenant: { ok: false, error: "MICROSOFT_NOT_CONFIGURED" },
      servicePrincipal: {
        exists: "UNKNOWN",
        objectId: null,
        appId: EL_GRAPH_APP_ID,
        tenantId: EL_GRAPH_TENANT_ID,
        accountEnabled: null,
        queryStatus: "NO_CREDENTIALS",
      },
      blocker: "Worker Microsoft client id or secret is not bound. Secrets were not rotated.",
    };
  }

  const tokenElTenant = await requestClientCredentials({
    tenantId: EL_GRAPH_TENANT_ID,
    clientId: boundClientId,
    clientSecret: boundSecret,
  });
  const tokenHomeTenant = boundHomeTenant
    ? await requestClientCredentials({
        tenantId: boundHomeTenant,
        clientId: boundClientId,
        clientSecret: boundSecret,
      })
    : null;

  let servicePrincipal: ServicePrincipalProof = {
    exists: tokenElTenant.ok ? "YES" : tokenElTenant.aadsts === "AADSTS7000229" ? "NO" : "UNKNOWN",
    objectId: null,
    appId: EL_GRAPH_APP_ID,
    tenantId: EL_GRAPH_TENANT_ID,
    accountEnabled: null,
    displayName: null,
    appOwnerOrganizationId: null,
    queryStatus: tokenElTenant.ok
      ? "INFERRED_FROM_TOKEN_SUCCESS"
      : tokenElTenant.aadsts === "AADSTS7000229"
        ? "INFERRED_FROM_AADSTS7000229"
        : "TOKEN_FAILED",
  };
  let organization: Record<string, unknown> | null = null;
  if (tokenElTenant.ok && tokenElTenant.accessToken) {
    const queried = await queryServicePrincipal(tokenElTenant.accessToken, EL_GRAPH_TENANT_ID, EL_GRAPH_APP_ID);
    if (queried.exists !== "UNKNOWN") servicePrincipal = queried;
    else servicePrincipal = { ...servicePrincipal, queryStatus: `${servicePrincipal.queryStatus}; ${queried.queryStatus}` };
    const org = await graphJson(tokenElTenant.accessToken, "/organization?$select=id,displayName");
    const orgRow = firstRow(org.body);
    organization = org.ok
      ? { id: orgRow?.id ?? null, displayName: orgRow?.displayName ?? null }
      : { error: org.error };
  }

  let homeTenantApplication: Record<string, unknown> | null = null;
  let homeTenantServicePrincipal: ServicePrincipalProof | null = null;
  if (tokenHomeTenant?.ok && tokenHomeTenant.accessToken) {
    homeTenantServicePrincipal = await queryServicePrincipal(
      tokenHomeTenant.accessToken,
      boundHomeTenant,
      boundClientId,
    );
    const apps = await graphJson(
      tokenHomeTenant.accessToken,
      `/applications?$filter=${encodeURIComponent(`appId eq '${boundClientId}'`)}&$select=id,appId,displayName,signInAudience`,
    );
    const app = firstRow(apps.body);
    homeTenantApplication = apps.ok
      ? {
          exists: Boolean(app?.id),
          objectId: app?.id ?? null,
          appId: app?.appId ?? boundClientId,
          displayName: app?.displayName ?? null,
          signInAudience: app?.signInAudience ?? null,
          queryStatus: app?.id ? "GRAPH_APPLICATIONS" : "GRAPH_APPLICATIONS_EMPTY",
        }
      : { exists: "UNKNOWN", queryStatus: `GRAPH_APP_QUERY_DENIED:${apps.status}` };
  }

  const tokenStill7000229 = tokenElTenant.aadsts === "AADSTS7000229";
  const findings: string[] = [];
  if (bindingAudit.wrongClientIdBinding) {
    findings.push("Worker MICROSOFT_CLIENT_ID does not match the expected EL app id.");
  }
  if (bindingAudit.homeTenantIsElTenant) {
    findings.push("Worker MICROSOFT_TENANT_ID is the EL tenant (home tenant binding equals EL).");
  } else if (boundHomeTenant) {
    findings.push("Worker MICROSOFT_TENANT_ID is not the EL tenant; EL mail uses domain-discovered tenant + platform app credentials.");
  }
  if (tokenStill7000229) {
    findings.push("Fresh token against the exact EL tenant still returns AADSTS7000229 (missing service principal).");
  }
  if (tokenHomeTenant && !tokenHomeTenant.ok) {
    findings.push(`Home-tenant token failed: ${tokenHomeTenant.aadsts ?? tokenHomeTenant.errorCode}`);
  }
  if (tokenHomeTenant?.ok && !tokenElTenant.ok) {
    findings.push("App+secret mint a token in the home tenant, so this is not a stale/wrong production secret pair. The EL tenant still rejects the same app id.");
  }

  let blocker: string | null = null;
  if (!tokenElTenant.ok) {
    blocker =
      tokenElTenant.aadsts === "AADSTS7000229"
        ? `Exact blocker: AADSTS7000229 — service principal for app ${boundClientId || EL_GRAPH_APP_ID} is still missing (or not enabled) in tenant ${EL_GRAPH_TENANT_ID}. Worker token URL=${tokenElTenant.tokenUrl}. Secrets were not rotated.`
        : `Exact blocker: ${tokenElTenant.aadsts ?? tokenElTenant.errorCode ?? "TOKEN_FAILED"} — ${tokenElTenant.error}`;
  }

  return {
    expected: { tenantId: EL_GRAPH_TENANT_ID, appId: EL_GRAPH_APP_ID },
    bindingAudit,
    domainDiscovery: {
      domain: "elvexpropertyservices.com",
      tenantId: domainTenant,
      matchesExpected: domainTenant === EL_GRAPH_TENANT_ID,
    },
    tokenElTenant: {
      ok: tokenElTenant.ok,
      tenantId: tokenElTenant.tenantId,
      tokenUrl: tokenElTenant.tokenUrl,
      clientIdUsed: tokenElTenant.clientIdUsed,
      httpStatus: tokenElTenant.httpStatus,
      errorCode: tokenElTenant.errorCode,
      aadsts: tokenElTenant.aadsts,
      error: tokenElTenant.error,
    },
    tokenHomeTenant: tokenHomeTenant
      ? {
          ok: tokenHomeTenant.ok,
          tenantId: tokenHomeTenant.tenantId,
          tokenUrl: tokenHomeTenant.tokenUrl,
          clientIdUsed: tokenHomeTenant.clientIdUsed,
          httpStatus: tokenHomeTenant.httpStatus,
          errorCode: tokenHomeTenant.errorCode,
          aadsts: tokenHomeTenant.aadsts,
          error: tokenHomeTenant.error,
        }
      : null,
    servicePrincipal,
    organization,
    homeTenantApplication,
    homeTenantServicePrincipal,
    findings,
    blocker,
    tokenMintSucceeded: tokenElTenant.ok,
  };
}
