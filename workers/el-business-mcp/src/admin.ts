import {
  adminUnauthorizedResponse,
  buildExtendedHealthResponse,
  buildStructuredDataHealthSummary,
  checkAdminAuth,
  checkDatabaseHealth,
  createLogger,
  getDatabaseSummary,
} from "@business-mcp/core";
import type { Env } from "./env";
import {
  EL_IDENTITY,
  EL_KNOWLEDGE_CONFIGURED,
  EL_STRUCTURED_DATA_CONFIG,
  EL_VERSIONS,
} from "./company-config";
import {
  elConnectorCapabilitiesCatalog,
  elConnectorDefinitions,
  loadConnectorRegistryRows,
} from "./connectors";
import { MCP_NAME } from "./constants";

const logger = createLogger(`${MCP_NAME}-admin`);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAdminRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (!checkAdminAuth(request, env.EL_ADMIN_TOKEN)) {
    logger.warn("admin_auth_failed", { path: url.pathname });
    return adminUnauthorizedResponse();
  }

  if (url.pathname === "/admin/health") {
    return json({ ok: true, service: `${MCP_NAME}-admin` });
  }

  if (url.pathname === "/admin/connectors") {
    return json({
      company: EL_IDENTITY.company,
      connectors: elConnectorDefinitions(),
      capabilityCatalog: elConnectorCapabilitiesCatalog(),
      registry: await loadConnectorRegistryRows(env.EL_BUSINESS_DATA),
    });
  }

  return json({ error: "Not Found" }, 404);
}

export async function buildPublicStatus(env: Env): Promise<Response> {
  const database = await checkDatabaseHealth(env.EL_BUSINESS_DATA, logger);
  const tables = await getDatabaseSummary(
    env.EL_BUSINESS_DATA,
    EL_STRUCTURED_DATA_CONFIG.summary
  );
  const totalRecords = tables.reduce((sum, t) => sum + t.recordCount, 0);
  const operationalRecords =
    tables.find((t) => t.name === "entity_records")?.recordCount ?? 0;

  const payload = buildExtendedHealthResponse({
    identity: EL_IDENTITY,
    versions: EL_VERSIONS,
    status: database.connected ? "healthy" : "degraded",
    database,
    knowledge: {
      status: EL_KNOWLEDGE_CONFIGURED ? "configured" : "not_configured",
      documents: 0,
      indexed: 0,
      lastIndexedAt: null,
    },
    structuredData: buildStructuredDataHealthSummary({
      frameworkConfigured: true,
      mode: "warehouse",
      tables: tables.length,
      records: totalRecords,
      operationalRecords,
    }),
    connectors: elConnectorDefinitions().map((c) => ({
      type: c.connectorType,
      status: c.status,
      enabled: c.enabled,
      version: c.connectorVersion,
    })),
    queues: { status: "not_configured" },
    capabilities: ["READ", "SEARCH"],
    recentErrors: [],
    tables,
  });

  return json(payload);
}

export async function buildLivenessHealth(env: Env): Promise<Response> {
  const database = await checkDatabaseHealth(env.EL_BUSINESS_DATA, logger);
  return json({
    ok: database.connected,
    company: EL_IDENTITY.company,
    environment: EL_IDENTITY.environment,
    service: EL_IDENTITY.serviceName,
    status: database.connected ? "healthy" : "degraded",
    mcpVersion: EL_VERSIONS.mcpVersion,
    coreVersion: EL_VERSIONS.coreVersion,
    timestamp: new Date().toISOString(),
  });
}
