import type { Env } from "../env";
import { createXeroClient, type XeroClient } from "./client";
import { loadXeroConfig, organisationMatchesExpected, type ElXeroConfig } from "./config";
import { ElXeroError } from "./errors";
import { getValidAccessToken } from "./tokens";

export type XeroContext = {
  env: Env;
  config: ElXeroConfig;
  client: XeroClient;
  organisationName: string;
  tenantId: string;
};

export async function createXeroContext(env: Env): Promise<XeroContext> {
  const config = loadXeroConfig(env);
  if (!config) {
    throw new ElXeroError(
      "Xero is not configured. EL_XERO_CLIENT_ID and EL_XERO_CLIENT_SECRET are required.",
      "EL_XERO_NOT_CONFIGURED",
      503
    );
  }
  const token = await getValidAccessToken(env);
  if (!organisationMatchesExpected(token.organisationName, config.expectedOrganisation)) {
    throw new ElXeroError(
      `Refusing to query Xero organisation '${token.organisationName}'. Expected ${config.expectedOrganisation}.`,
      "EL_XERO_TENANT_DENIED",
      403
    );
  }
  return {
    env,
    config,
    organisationName: token.organisationName,
    tenantId: token.tenantId,
    client: createXeroClient({
      db: env.EL_BUSINESS_DATA,
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      organisationName: token.organisationName,
    }),
  };
}

export function jsonTool(data: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
