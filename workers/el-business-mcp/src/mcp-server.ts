import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  appendLimitIfMissing,
  buildExtendedHealthResponse,
  buildKnowledgeNotConfiguredGuidance,
  checkDatabaseHealth,
  CORE_VERSION,
  createLogger,
  getDatabaseSummary,
  notConfiguredToolPayload,
  recordSystemHealthLog,
  runReadOnlyQuery,
  validateReadOnlySql,
} from "@business-mcp/core";
import {
  EL_IDENTITY,
  EL_KNOWLEDGE_CONFIGURED,
  EL_STRUCTURED_DATA_CONFIG,
  EL_VERSIONS,
} from "./company-config";
import { elConnectorDefinitions, loadConnectorRegistryRows } from "./connectors";
import type { Env } from "./env";
import {
  MCP_NAME,
  MCP_VERSION,
  QUERYABLE_TABLES,
} from "./constants";
import { loadMicrosoftConfig, publicMicrosoftPolicy } from "./microsoft/config";
import {
  registerMicrosoftTools,
  searchCompanyKnowledgeViaMicrosoft,
} from "./microsoft/tools";
import { toolErrorPayload } from "./microsoft/errors";

const logger = createLogger(MCP_NAME);

export function createElBusinessMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: MCP_VERSION,
    description:
      `${EL_IDENTITY.company} (Elvex Property Services Ltd) is the authoritative internal business source when explicitly requested. ` +
      "Microsoft 365 access is limited to approved shared mailboxes (finance@ and info@) plus company SharePoint and eligible employee OneDrives. " +
      "Protected-user OneDrive content is never searchable or returnable. " +
      "Personal staff mailboxes and personal calendars are not exposed. " +
      "Do not invent company documents or policies.",
  });

  registerMicrosoftTools(server, env);

  server.registerTool(
    "system_health",
    {
      description:
        "Returns MCP status, version, Core version, timestamp, and D1 connectivity.",
    },
    async () => {
      const database = await checkDatabaseHealth(env.EL_BUSINESS_DATA, logger);
      const tables = await getDatabaseSummary(
        env.EL_BUSINESS_DATA,
        EL_STRUCTURED_DATA_CONFIG.summary
      );
      const totalRecords = tables.reduce((sum, t) => sum + t.recordCount, 0);

      const payload = {
        ...buildExtendedHealthResponse({
          identity: EL_IDENTITY,
          versions: EL_VERSIONS,
          status: database.connected ? "healthy" : "degraded",
          database,
          knowledge: {
            status: "not_configured",
            documents: 0,
            indexed: 0,
            lastIndexedAt: null,
          },
          structuredData: {
            status: "healthy",
            mode: "warehouse",
            tables: tables.length,
            records: totalRecords,
          },
          connectors: elConnectorDefinitions(env).map((c) => ({
            type: c.connectorType,
            status: c.status,
            enabled: c.enabled,
            version: c.connectorVersion,
          })),
          queues: { status: "not_configured" },
          capabilities: ["READ", "SEARCH", "SEND"],
          tables,
        }),
        microsoft: publicMicrosoftPolicy(loadMicrosoftConfig(env)),
      };

      if (database.connected) {
        await recordSystemHealthLog(
          env.EL_BUSINESS_DATA,
          {
            overallStatus: payload.status,
            mcpVersion: MCP_VERSION,
            d1: database,
            r2: {
              available: false,
              error: "R2 not provisioned for EL Business MCP.",
            },
            vectorize: {
              available: false,
              error: "Vectorize not provisioned for EL Business MCP.",
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
        "Returns warehouse framework tables, record counts and latest timestamps.",
    },
    async () => {
      try {
        const tables = await getDatabaseSummary(
          env.EL_BUSINESS_DATA,
          EL_STRUCTURED_DATA_CONFIG.summary
        );
        const connectors = await loadConnectorRegistryRows(env.EL_BUSINESS_DATA);
        const payload = {
          timestamp: new Date().toISOString(),
          company: EL_IDENTITY.company,
          coreVersion: CORE_VERSION,
          tables,
          connectors,
          totals: {
            tables: tables.length,
            records: tables.reduce((sum, t) => sum + t.recordCount, 0),
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "query_business_data",
    {
      description:
        "Execute a read-only SELECT query against EL warehouse framework tables.",
      inputSchema: {
        sql: z.string().describe("Read-only SELECT query."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum rows (default 100)."),
      },
    },
    async ({ sql, limit = 100 }) => {
      const validation = validateReadOnlySql(sql, QUERYABLE_TABLES);
      if (!validation.ok) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: validation.error }, null, 2) },
          ],
          isError: true,
        };
      }

      try {
        const bounded = appendLimitIfMissing(validation.normalizedSql, limit);
        const result = await runReadOnlyQuery(env.EL_BUSINESS_DATA, bounded);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  company: EL_IDENTITY.company,
                  rowCount: result.rowCount,
                  columns: result.columns,
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
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "search_company_knowledge",
    {
      description:
        "Search Elvex company knowledge. When the local index is not provisioned this runs a live Microsoft Graph file search across SharePoint and eligible OneDrives, excluding protected users.",
      inputSchema: {
        query: z.string().describe("Natural language search query."),
        top_k: z.number().int().min(1).max(12).optional(),
      },
    },
    async ({ query, top_k }) => {
      if (!EL_KNOWLEDGE_CONFIGURED) {
        try {
          const live = await searchCompanyKnowledgeViaMicrosoft(env, query, top_k ?? 8);
          return {
            content: [{ type: "text", text: JSON.stringify(live, null, 2) }],
          };
        } catch (error) {
          const payload = {
            status: "not_configured" as const,
            results: [],
            confidence: "weak" as const,
            guidance: buildKnowledgeNotConfiguredGuidance(EL_IDENTITY.company),
            microsoft: toolErrorPayload(error),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(notConfiguredToolPayload("search_company_knowledge"), null, 2),
          },
        ],
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
      const payload = { status: "not_configured" as const };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  return server;
}
