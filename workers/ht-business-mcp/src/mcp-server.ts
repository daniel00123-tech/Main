import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCP_NAME, MCP_VERSION } from "./constants";
import {
  checkDatabaseHealth,
  getDatabaseSummary,
  runReadOnlyQuery,
  type Env,
} from "./db";
import { log } from "./logger";
import { validateReadOnlySql } from "./sql-safety";

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
        timestamp: new Date().toISOString(),
        database: {
          connected: dbHealth.connected,
          latencyMs: dbHealth.latencyMs,
          error: dbHealth.error,
        },
      };
      log("info", "system_health", { status: payload.status });
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
          tables,
          totals: {
            tables: tables.length,
            records: tables.reduce((sum, t) => sum + t.recordCount, 0),
          },
        };
        log("info", "database_summary", {
          tableCount: tables.length,
          totalRecords: payload.totals.records,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("error", "database_summary_failed", { error: message });
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
      const validation = validateReadOnlySql(sql);
      if (!validation.ok) {
        log("warn", "query_business_data_rejected", { reason: validation.error });
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

      let executableSql = validation.normalizedSql;
      const hasLimit = /\bLIMIT\s+\d+/i.test(executableSql);
      const rowLimit = limit ?? 100;
      if (!hasLimit) {
        executableSql = `${executableSql} LIMIT ${rowLimit}`;
      }

      try {
        const result = await runReadOnlyQuery(env.HT_BUSINESS_DATA, executableSql);
        log("info", "query_business_data", {
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
        log("error", "query_business_data_failed", { error: message });
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

  return server;
}
