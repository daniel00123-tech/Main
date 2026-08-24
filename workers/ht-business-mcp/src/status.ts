import {
  buildExtendedHealthResponse,
  checkDatabaseHealth,
  createLogger,
  getDatabaseSummary,
} from "@business-mcp/core";
import type { Env } from "./db";
import {
  HT_IDENTITY,
  HT_KNOWLEDGE_CONFIGURED,
  HT_STRUCTURED_DATA_CONFIG,
  HT_VERSIONS,
} from "./company-config";
import { htConnectorDefinitions, loadConnectorRegistryRows } from "./connectors";
import { MCP_NAME } from "./constants";

const logger = createLogger(MCP_NAME);

export async function buildLivenessHealth(env: Env): Promise<Response> {
  const database = await checkDatabaseHealth(env.HT_BUSINESS_DATA, logger);
  return new Response(
    JSON.stringify({
      ok: database.connected,
      company: HT_IDENTITY.company,
      environment: HT_IDENTITY.environment,
      service: HT_IDENTITY.serviceName,
      status: database.connected ? "healthy" : "degraded",
      mcpVersion: HT_VERSIONS.mcpVersion,
      coreVersion: HT_VERSIONS.coreVersion,
      timestamp: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export async function buildPublicStatus(env: Env): Promise<Response> {
  const database = await checkDatabaseHealth(env.HT_BUSINESS_DATA, logger);
  const tables = await getDatabaseSummary(
    env.HT_BUSINESS_DATA,
    HT_STRUCTURED_DATA_CONFIG.summary
  );
  const totalRecords = tables.reduce((sum, t) => sum + t.recordCount, 0);

  const payload = buildExtendedHealthResponse({
    identity: HT_IDENTITY,
    versions: HT_VERSIONS,
    status: database.connected ? "healthy" : "degraded",
    database,
    knowledge: {
      status: HT_KNOWLEDGE_CONFIGURED ? "configured" : "not_configured",
      documents: 0,
      indexed: 0,
      lastIndexedAt: null,
    },
    structuredData: {
      status: "configured",
      mode: "warehouse",
      tables: tables.length,
      records: totalRecords,
    },
    connectors: htConnectorDefinitions().map((c) => ({
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

  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function getConnectorRegistryStatus(env: Env): Promise<unknown> {
  return {
    company: HT_IDENTITY.company,
    registry: await loadConnectorRegistryRows(env.HT_BUSINESS_DATA),
    connectors: htConnectorDefinitions(),
  };
}
