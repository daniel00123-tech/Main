import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCP_NAME, MCP_VERSION } from "./constants";
import {
  checkDatabaseHealth,
  checkR2Health,
  checkVectorizeHealth,
  getDatabaseSummary,
  recordSystemHealthLog,
  runReadOnlyQuery,
  type Env,
} from "./db";
import {
  getKnowledgeDocument,
  searchCompanyKnowledge,
} from "./knowledge";
import { log } from "./logger";
import { validateReadOnlySql } from "./sql-safety";

export function createCaddingtonMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: MCP_VERSION,
  });

  server.registerTool(
    "system_health",
    {
      description:
        "Returns MCP status, version, timestamp, D1, R2 and Vectorize connectivity.",
    },
    async () => {
      const d1 = await checkDatabaseHealth(env.CADDINGTON_BUSINESS_DATA);
      const r2 = await checkR2Health(env.CADDINGTON_KNOWLEDGE);
      const vectorize = await checkVectorizeHealth(
        env.CADDINGTON_KNOWLEDGE_INDEX
      );

      const healthyCount =
        (d1.connected ? 1 : 0) +
        (r2.available ? 1 : 0) +
        (vectorize.available ? 1 : 0);
      const overallStatus =
        healthyCount === 3
          ? "healthy"
          : healthyCount > 0
            ? "degraded"
            : "unhealthy";

      const payload = {
        status: overallStatus,
        mcp: { name: MCP_NAME, version: MCP_VERSION },
        timestamp: new Date().toISOString(),
        database: {
          connected: d1.connected,
          latencyMs: d1.latencyMs,
          error: d1.error,
        },
        r2: {
          available: r2.available,
          latencyMs: r2.latencyMs,
          error: r2.error,
        },
        vectorize: {
          available: vectorize.available,
          latencyMs: vectorize.latencyMs,
          error: vectorize.error,
        },
      };

      await recordSystemHealthLog(env, {
        overallStatus,
        d1,
        r2,
        vectorize,
      });

      log("info", "system_health", { status: overallStatus });
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerTool(
    "database_summary",
    {
      description:
        "Returns safe summary of the Caddington D1 data warehouse tables.",
    },
    async () => {
      try {
        const tables = await getDatabaseSummary(env.CADDINGTON_BUSINESS_DATA);
        const connectors = await env.CADDINGTON_BUSINESS_DATA.prepare(
          "SELECT code, label, status FROM connector_registry ORDER BY code"
        ).all();

        const payload = {
          timestamp: new Date().toISOString(),
          tables,
          connectors: connectors.results,
          totals: {
            tables: tables.length,
            records: tables.reduce((s, t) => s + t.recordCount, 0),
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "query_business_data",
    {
      description:
        "Read-only SELECT against Caddington warehouse tables (import_log, entity_records, knowledge tables, connector_registry, etc.).",
      inputSchema: {
        sql: z.string().min(1).describe("Read-only SELECT query."),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ sql, limit }) => {
      const validation = validateReadOnlySql(sql);
      if (!validation.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: validation.error }),
            },
          ],
          isError: true,
        };
      }

      let executableSql = validation.normalizedSql;
      if (!/\bLIMIT\s+\d+/i.test(executableSql)) {
        executableSql = `${executableSql} LIMIT ${limit ?? 100}`;
      }

      try {
        const result = await runReadOnlyQuery(
          env.CADDINGTON_BUSINESS_DATA,
          executableSql
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "search_company_knowledge",
    {
      description:
        "Hybrid semantic + lexical search across indexed company knowledge with optional metadata filters.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language search query."),
        topK: z.number().int().min(1).max(20).optional(),
        company: z.string().optional(),
        project: z.string().optional(),
        category: z.string().optional(),
        document_type: z.string().optional(),
        document_date: z.string().optional(),
        source: z.string().optional(),
        filename: z.string().optional(),
        title: z.string().optional(),
        department: z.string().optional(),
        property: z.string().optional(),
        topic: z.string().optional(),
        person: z.string().optional(),
        customer: z.string().optional(),
        supplier: z.string().optional(),
        includeNeighbourContext: z.boolean().optional(),
        includeDiagnostics: z.boolean().optional(),
        includeFullContent: z.boolean().optional(),
      },
    },
    async ({
      query,
      topK,
      company,
      project,
      category,
      document_type,
      document_date,
      source,
      filename,
      title,
      department,
      property,
      topic,
      person,
      customer,
      supplier,
      includeNeighbourContext,
      includeDiagnostics,
      includeFullContent,
    }) => {
      try {
        const filters = {
          company,
          project,
          category,
          document_type,
          document_date,
          source,
          filename,
          title,
          department,
          property,
          topic,
          person,
          customer,
          supplier,
        };
        const hasFilters = Object.values(filters).some(
          (value) => value !== undefined && value !== ""
        );

        const response = await searchCompanyKnowledge(env, query, topK ?? 5, {
          filters: hasFilters ? filters : undefined,
          includeNeighbourContext,
          includeDiagnostics,
          includeFullContent,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_knowledge_document",
    {
      description:
        "Retrieve metadata, chunks and import history for a knowledge document by id or external_id.",
      inputSchema: {
        documentRef: z
          .string()
          .min(1)
          .describe("Numeric document id or external_id string."),
      },
    },
    async ({ documentRef }) => {
      try {
        const doc = await getKnowledgeDocument(env, documentRef);
        if (!doc) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Document not found." }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}
