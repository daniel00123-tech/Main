import {
  CONNECTOR_ERROR_CODES,
  XERO_AUTH,
  customerConnectorError,
} from "@infra/shared";
import type { Env } from "../env";
import { getConnectorInstance, listConnectorInstances, listMcpEnvironments } from "./control-plane";
import { getValidXeroAccessToken } from "./xero";

/**
 * Server-to-server bridge: Company Business MCP resolves Xero execution context.
 * Never exposed to ChatGPT or the portal UI.
 */
export async function resolveXeroMcpExecutionContext(input: {
  env: Env;
  companyId: string;
  mcpEnvironmentId: string;
  authHeader: string | null;
  actor?: string;
}): Promise<
  | {
      ok: true;
      tenantId: string;
      apiBaseUrl: string;
      accessToken: string;
      instanceId: string;
      organisationName: string | null;
      grantedScopes: string[];
    }
  | { ok: false; status: 401 | 403 | 404 | 409; body: ReturnType<typeof customerConnectorError> }
> {
  const mcps = await listMcpEnvironments(input.env.DB, input.companyId);
  const mcp = mcps.find((row) => row.id === input.mcpEnvironmentId);
  if (!mcp || !mcp.enabled) {
    return {
      ok: false,
      status: 404,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONFIG_INCOMPLETE),
    };
  }

  const bearer = input.authHeader?.startsWith("Bearer ")
    ? input.authHeader.slice(7).trim()
    : null;
  if (!bearer || !mcp.authSecretRef) {
    return {
      ok: false,
      status: 401,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED),
    };
  }
  const expected = input.env[mcp.authSecretRef as keyof Env];
  if (typeof expected !== "string" || !expected.trim() || bearer !== expected.trim()) {
    return {
      ok: false,
      status: 401,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.PERMISSION_DENIED),
    };
  }

  const instances = await listConnectorInstances(input.env.DB, input.companyId);
  const instance =
    instances.find(
      (row) =>
        row.connectorDefinitionId === "conn_xero" &&
        row.authStatus === "connected" &&
        Boolean(row.externalAccountId),
    ) ?? null;
  if (!instance) {
    return {
      ok: false,
      status: 409,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CONNECTOR_NOT_CONNECTED),
    };
  }

  const fresh = await getConnectorInstance(input.env.DB, instance.id);
  if (!fresh || fresh.companyId !== input.companyId) {
    return {
      ok: false,
      status: 403,
      body: customerConnectorError(CONNECTOR_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN),
    };
  }

  const token = await getValidXeroAccessToken({
    env: input.env,
    companyId: input.companyId,
    instanceId: fresh.id,
    actor: input.actor ?? "mcp-bridge",
    reason: "mcp_resolve",
  });
  if (!token.ok) {
    return { ok: false, status: token.status, body: token.body };
  }

  return {
    ok: true,
    tenantId: token.tenantId,
    apiBaseUrl: XERO_AUTH.apiBaseUrl,
    accessToken: token.accessToken,
    instanceId: fresh.id,
    organisationName: token.payload.organisationName,
    grantedScopes: token.payload.scopes,
  };
}
