import { describe, expect, it } from "vitest";
import { rowToConnectorInstance } from "../db/mappers";
import { syncConnectorMirrorFromCompanyMcp } from "./mcp-connector-mirror";
import type { Env } from "../env";
import type { ConnectorInstance, McpEnvironment } from "@infra/shared";

type Row = Record<string, unknown>;

function now() {
  return "2026-08-30T12:15:00.000Z";
}

function instanceRow(partial: Row): Row {
  return {
    id: "ci_el_xero",
    company_id: "co_el",
    connector_definition_id: "conn_xero",
    name: "Xero",
    status: "draft",
    config_json: '{"note":"Registry only."}',
    sync_settings_json: '{"enabled":false,"mode":"manual","schedule":null}',
    data_environment_id: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_message: null,
    health_status: "unknown",
    health_message: "Not configured",
    auth_status: null,
    sync_health: null,
    provider_health: null,
    display_account_name: null,
    external_account_id: null,
    managed_by: null,
    connected_at: null,
    last_health_at: null,
    created_at: now(),
    updated_at: now(),
    ...partial,
  };
}

class FakeStatement {
  sql = "";
  binds: unknown[] = [];
  constructor(private readonly db: FakeD1) {}
  bind(...binds: unknown[]) {
    this.binds = binds;
    return this;
  }
  async first() {
    return this.db.first(this.sql, this.binds);
  }
  async all() {
    return { results: this.db.all(this.sql, this.binds) };
  }
  async run() {
    this.db.run(this.sql, this.binds);
    return { success: true };
  }
}

class FakeD1 {
  instances: Row[];
  audits: Row[] = [];
  mcpUpdates: Row[] = [];

  constructor(instances: Row[]) {
    this.instances = instances.map((row) => ({ ...row }));
  }

  prepare(sql: string) {
    const statement = new FakeStatement(this);
    statement.sql = sql;
    return statement;
  }

  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.toLowerCase();
    if (q.includes("from connector_instances") && q.includes("company_id")) {
      return this.instances
        .filter((row) => row.company_id === binds[0])
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    return [];
  }

  first(sql: string, binds: unknown[]): Row | null {
    return this.all(sql, binds)[0] ?? null;
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.toLowerCase();
    if (q.startsWith("insert into connector_instances")) {
      this.instances.push(
        instanceRow({
          id: binds[0],
          company_id: binds[1],
          connector_definition_id: binds[2],
          name: binds[3],
          status: binds[4],
          config_json: binds[5],
          health_status: binds[7],
          health_message: binds[8],
          auth_status: binds[9],
          provider_health: binds[10],
          display_account_name: binds[11],
          external_account_id: binds[12],
          managed_by: "company_mcp",
          connected_at: binds[14],
          last_health_at: binds[15],
        }),
      );
      return;
    }
    if (q.startsWith("update connector_instances") && q.includes("managed_by = 'company_mcp'")) {
      const id = binds[binds.length - 2];
      const companyId = binds[binds.length - 1];
      const row = this.instances.find((item) => item.id === id && item.company_id === companyId);
      if (!row) return;
      row.name = binds[0];
      row.status = binds[1];
      row.config_json = binds[2];
      row.health_status = binds[3];
      row.health_message = binds[4];
      row.auth_status = binds[5];
      row.provider_health = binds[6];
      row.display_account_name = binds[7];
      if (binds[8] != null) row.external_account_id = binds[8];
      row.managed_by = "company_mcp";
      row.connected_at = binds[9];
      row.last_health_at = binds[10];
      row.updated_at = binds[11];
      return;
    }
    if (q.startsWith("update connector_instances")) {
      const id = binds[binds.length - 2];
      const companyId = binds[binds.length - 1];
      const row = this.instances.find((item) => item.id === id && item.company_id === companyId);
      if (!row) return;
      row.provider_health = binds[0];
      row.health_status = binds[1];
      row.health_message = binds[2];
      row.last_health_at = binds[3];
      if (binds[4] != null) row.display_account_name = binds[4];
      row.updated_at = binds[5];
      return;
    }
    if (q.startsWith("insert into audit_events")) {
      this.audits.push({
        id: binds[0],
        event_type: binds[2],
        resource_id: binds[5],
        detail_json: binds[6],
      });
      return;
    }
    if (q.startsWith("update mcp_environments")) {
      this.mcpUpdates.push({ health_message: binds[1] });
    }
  }
}

function mcp(): McpEnvironment {
  return {
    id: "mcp_el_primary",
    companyId: "co_el",
    name: "EL Business MCP",
    description: "Existing EL Business MCP Worker.",
    endpointUrl: "https://el-business-mcp.infrastack.app/mcp",
    transport: "streamable-http",
    status: "registered",
    enabled: true,
    isExternal: true,
    dataPlaneId: "dp_el_business",
    mcpVersion: "1.2.0",
    businessMcpCoreVersion: "1.0.0",
    capabilities: ["system_health"],
    authSecretRef: "EL_MCP_AUTH_TOKEN",
    serviceBindingRef: "EL_BUSINESS_MCP",
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    healthMessage: "Awaiting first authenticated health check",
    lastSuccessfulRequestAt: null,
    lastError: "routing-probe failed",
    lastLatencyMs: null,
    lastSyncAt: null,
    knowledgeDocumentCount: null,
    knowledgeChunkCount: null,
    capabilitySnapshot: null,
    capabilityRefreshedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

describe("syncConnectorMirrorFromCompanyMcp", () => {
  it("promotes MCP-healthy connectors and leaves disabled ones draft", async () => {
    const db = new FakeD1([
      instanceRow({ id: "ci_el_xero", connector_definition_id: "conn_xero", name: "Xero" }),
      instanceRow({
        id: "ci_el_sharepoint",
        connector_definition_id: "conn_sharepoint",
        name: "SharePoint",
      }),
      instanceRow({
        id: "ci_el_bigchange",
        connector_definition_id: "conn_bigchange",
        name: "BigChange",
      }),
    ]);

    const instances = await syncConnectorMirrorFromCompanyMcp(
      { DB: db as unknown as D1Database } as Env,
      {
        companyId: "co_el",
        actor: "system:connector-mirror",
        mcp: mcp(),
        force: true,
        snapshot: {
          connectors: [
            { type: "xero", status: "configured", enabled: true, health: "healthy" },
            { type: "sharepoint", status: "configured", enabled: true, health: "healthy" },
            { type: "bigchange", status: "disabled", enabled: false },
          ],
          xero: {
            configured: true,
            connected: true,
            organisationName: "Elvex Property Services Ltd",
            tenantId: "tenant-elvex",
            lastApiOk: true,
          },
          microsoft: { configured: true, sharePointHostname: "elvex.sharepoint.com" },
        },
      },
    );

    const byId = new Map(instances.map((item) => [item.connectorDefinitionId, item]));
    expect(byId.get("conn_xero")?.status).toBe("healthy");
    expect(byId.get("conn_xero")?.authStatus).toBe("connected");
    expect(byId.get("conn_xero")?.displayAccountName).toBe("Elvex Property Services Ltd");
    expect(byId.get("conn_sharepoint")?.status).toBe("healthy");
    expect(byId.get("conn_bigchange")?.status).toBe("draft");
    expect(db.audits.some((row) => row.event_type === "connector.connected")).toBe(true);
    expect(String(db.mcpUpdates[0]?.health_message)).toContain("2 connected");
  });

  it("does not overwrite INFRA-managed OAuth that is already connected", async () => {
    const db = new FakeD1([
      instanceRow({
        id: "ci_cad_xero",
        company_id: "co_el",
        connector_definition_id: "conn_xero",
        name: "Xero",
        status: "healthy",
        auth_status: "connected",
        managed_by: "infra",
        credential_ref_id: "cred_1",
        display_account_name: "Keep Me",
      }),
    ]);

    const instances = await syncConnectorMirrorFromCompanyMcp(
      { DB: db as unknown as D1Database } as Env,
      {
        companyId: "co_el",
        actor: "system:connector-mirror",
        mcp: mcp(),
        force: true,
        snapshot: {
          connectors: [{ type: "xero", status: "configured", enabled: true }],
          xero: {
            configured: true,
            connected: true,
            organisationName: "Elvex Property Services Ltd",
          },
        },
      },
    );

    expect(instances[0]?.managedBy).toBe("infra");
    expect(instances[0]?.displayAccountName).toBe("Elvex Property Services Ltd");
    expect(instances[0]?.providerHealth).toBe("healthy");
  });
});

describe("row mapping sanity", () => {
  it("maps a mirrored row for portal health", () => {
    const instance: ConnectorInstance = rowToConnectorInstance(
      instanceRow({
        status: "healthy",
        health_status: "healthy",
        auth_status: "connected",
        provider_health: "healthy",
        display_account_name: "Elvex Property Services Ltd",
        managed_by: "company_mcp",
      }),
    );
    expect(instance.displayAccountName).toBe("Elvex Property Services Ltd");
    expect(instance.managedBy).toBe("company_mcp");
  });
});
