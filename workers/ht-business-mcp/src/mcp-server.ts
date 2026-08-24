import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  appendLimitIfMissing,
  buildKnowledgeNotConfiguredGuidance,
  CORE_VERSION,
  createLogger,
  recordSystemHealthLog,
  validateReadOnlySql as validateReadOnlySqlCore,
} from "@business-mcp/core";
import {
  HT_IDENTITY,
  HT_KNOWLEDGE_CONFIGURED,
  HT_STRUCTURED_DATA_CONFIG,
  HT_VERSIONS,
} from "./company-config";
import { htConnectorDefinitions } from "./connectors";
import {
  checkDatabaseHealth,
  getDatabaseSummary,
  runReadOnlyQuery,
  type Env,
} from "./db";
import {
  COMPANY_NAME,
  MCP_NAME,
  MCP_VERSION,
  QUERYABLE_TABLES,
} from "./constants";

const logger = createLogger(MCP_NAME);

export function createHtBusinessMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: MCP_VERSION,
  });

  server.registerTool(
    "system_health",
    {
      description:
        "Returns MCP status, version, current timestamp and database connectivity.",
    },
    async () => {
      const dbHealth = await checkDatabaseHealth(env.HT_BUSINESS_DATA);
      const payload = {
        status: dbHealth.connected ? "healthy" : "degraded",
        mcp: {
          name: MCP_NAME,
          version: MCP_VERSION,
        },
        company: HT_IDENTITY.company,
        environment: HT_IDENTITY.environment,
        coreVersion: CORE_VERSION,
        timestamp: new Date().toISOString(),
        database: {
          connected: dbHealth.connected,
          latencyMs: dbHealth.latencyMs,
          error: dbHealth.error,
        },
      };

      if (dbHealth.connected) {
        await recordSystemHealthLog(
          env.HT_BUSINESS_DATA,
          {
            overallStatus: payload.status,
            mcpVersion: MCP_VERSION,
            d1: dbHealth,
            r2: {
              available: false,
              error: "R2 not provisioned for HT Business MCP.",
            },
            vectorize: {
              available: false,
              error: "Vectorize not provisioned for HT Business MCP.",
            },
          },
          logger
        );
      }

      logger.info("system_health", { status: payload.status });
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerTool(
    "database_summary",
    {
      description:
        "Returns warehouse tables, record counts and latest data timestamps.",
    },
    async () => {
      try {
        const tables = await getDatabaseSummary(env.HT_BUSINESS_DATA);
        const payload = {
          timestamp: new Date().toISOString(),
          company: HT_IDENTITY.company,
          coreVersion: CORE_VERSION,
          tables,
          totals: {
            tables: tables.length,
            records: tables.reduce((sum, t) => sum + t.recordCount, 0),
          },
        };
        logger.info("database_summary", {
          tableCount: tables.length,
          totalRecords: payload.totals.records,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("database_summary_failed", { error: message });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "query_business_data",
    {
      description:
        "Run a safe read-only SELECT against HT business warehouse tables (import_log, entity_registry, entity_records).",
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe("Read-only SELECT query against allowed warehouse tables."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Optional row cap applied when query has no LIMIT clause."),
      },
    },
    async ({ sql, limit }) => {
      const validation = validateReadOnlySqlCore(sql, QUERYABLE_TABLES);
      if (!validation.ok) {
        logger.warn("query_business_data_rejected", { reason: validation.error });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: validation.error }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const rowLimit = limit ?? 100;
      const executableSql = appendLimitIfMissing(validation.normalizedSql, rowLimit);

      try {
        const result = await runReadOnlyQuery(env.HT_BUSINESS_DATA, executableSql);
        logger.info("query_business_data", {
          rowCount: result.rowCount,
          columns: result.columns,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  columns: result.columns,
                  rowCount: result.rowCount,
                  rows: result.rows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("query_business_data_failed", { error: message });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "search_company_knowledge",
    {
      description:
        "Hybrid search across HT Business company knowledge (when configured).",
      inputSchema: {
        query: z.string().describe("Natural language search query."),
        top_k: z.number().int().min(1).max(12).optional(),
      },
    },
    async ({ query, top_k }) => {
      void query;
      void top_k;
      const payload = {
        status: "not_configured" as const,
        results: [],
        confidence: "weak" as const,
        guidance: buildKnowledgeNotConfiguredGuidance(COMPANY_NAME),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_knowledge_document",
    {
      description: "Fetch a knowledge document and chunks by document ID.",
      inputSchema: {
        document_id: z.number().int().positive(),
      },
    },
    async ({ document_id }) => {
      void document_id;
      void HT_KNOWLEDGE_CONFIGURED;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "not_configured" as const }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
