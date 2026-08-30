import { describe, expect, it } from "vitest";
import {
  applyRegistryRecords,
} from "./company-mcp-connector-sync";
import { mapMcpConnectorsToRegistryRecords } from "@infra/shared";

type Row = Record<string, unknown>;

function memoryDb(seed: Row[] = []) {
  const rows = [...seed];
  const audits: Row[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (sql.includes("FROM connector_instances WHERE company_id")) {
                const companyId = args[0];
                return { results: rows.filter((row) => row.company_id === companyId) };
              }
              return { results: [] };
            },
            async first() {
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO connector_instances")) {
                rows.push({
                  id: args[0],
                  company_id: args[1],
                  connector_definition_id: args[2],
                  name: args[3],
                  status: args[4],
                  auth_status: args[9],
                  health_status: args[7],
                  managed_by: "company_mcp",
                });
              }
              if (sql.includes("UPDATE connector_instances")) {
                const id = args[args.length - 2];
                const companyId = args[args.length - 1];
                const row = rows.find((item) => item.id === id && item.company_id === companyId);
                if (row) {
                  row.status = args[1];
                  row.auth_status = args[4];
                  row.health_status = args[2];
                  row.managed_by = "company_mcp";
                }
              }
              if (sql.includes("INSERT INTO audit_events") || sql.startsWith("INSERT")) {
                audits.push({ sql, args });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, rows, audits };
}

describe("company MCP connector registry sync", () => {
  it("promotes EL Microsoft 365 and Xero from MCP status without storing secrets", async () => {
    const { db, rows } = memoryDb([
      {
        id: "ci_el_xero",
        company_id: "co_el",
        connector_definition_id: "conn_xero",
        status: "draft",
        auth_status: "not_configured",
        health_status: "unknown",
        managed_by: "company_mcp",
        config_json: "{}",
      },
    ]);
    const records = mapMcpConnectorsToRegistryRecords({
      source: "el-business-mcp",
      connectors: [
        { connectorType: "microsoft_365", connected: true, configured: true, health: "healthy", lastVerified: "2026-08-30T10:00:00.000Z" },
        { connectorType: "xero", connected: true, configured: true, health: "healthy", metadata: { organisationName: "Elvex Property Services Ltd", refreshToken: "secret" } },
        { connectorType: "bigchange", status: "not_configured" },
      ],
    });
    const result = await applyRegistryRecords(db, {
      companyId: "co_el",
      mcpId: "mcp_el_primary",
      records,
      actor: "test",
    });
    expect(result.synced).toBeGreaterThanOrEqual(2);
    const microsoft = rows.find((row) => String(row.connector_definition_id) === "conn_microsoft_365");
    const xero = rows.find((row) => String(row.id) === "ci_el_xero");
    expect(microsoft?.status).toBe("configured");
    expect(microsoft?.auth_status).toBe("connected");
    expect(xero?.status).toBe("configured");
    expect(xero?.auth_status).toBe("connected");
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("does not leak HT records into an EL apply", async () => {
    const { db, rows } = memoryDb([
      {
        id: "ci_ht_xero",
        company_id: "co_ht",
        connector_definition_id: "conn_xero",
        status: "draft",
        auth_status: "not_configured",
        health_status: "unknown",
        managed_by: "company_mcp",
        config_json: "{}",
      },
    ]);
    const records = mapMcpConnectorsToRegistryRecords({
      connectors: [{ connectorType: "xero", connected: true, health: "healthy" }],
    });
    await applyRegistryRecords(db, {
      companyId: "co_el",
      mcpId: "mcp_el_primary",
      records,
      actor: "test",
    });
    const ht = rows.find((row) => row.id === "ci_ht_xero");
    expect(ht?.status).toBe("draft");
    expect(rows.some((row) => row.company_id === "co_el" && row.connector_definition_id === "conn_xero")).toBe(true);
  });
});
