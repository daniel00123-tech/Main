/**
 * Generic company-MCP → INFRA connector registry sync.
 * Tenant-scoped. Never copies secrets. Works for EL, HT, Caddington, and future MCPs.
 */

import {
  decideRegistrySync,
  getConnectorById,
  mapMcpConnectorsToRegistryRecords,
  registryInstanceId,
  type McpRegistryConnector,
  type PlatformRegistryRecord,
} from "@infra/shared";
import type { Env } from "../env";
import { nowIso } from "../db/mappers";
import { getCompanyById, listMcpEnvironments, recordAuditEvent } from "./control-plane";
import { resolveMcpAdminAuthHeader } from "./mcp-admin-bridge";
import { resolveMcpFetcher } from "./mcp-client";

export type ConnectorRegistrySyncResult = {
  companyId: string;
  mcpId: string | null;
  synced: number;
  skipped: number;
  failed: number;
  records: Array<{
    catalogueId: string;
    connected: boolean;
    action: "upsert" | "skip" | "create";
  }>;
  error?: string;
};

function parseConnectorsFromAdminPayload(payload: unknown): McpRegistryConnector[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as Record<string, unknown>;
  const platform = body.platformRegistry;
  if (platform && typeof platform === "object") {
    const list = (platform as { connectors?: unknown }).connectors;
    if (Array.isArray(list)) return list as McpRegistryConnector[];
  }
  if (Array.isArray(body.connectors)) {
    return (body.connectors as Array<Record<string, unknown>>).map((item) => ({
      connectorType: String(item.connectorType ?? item.type ?? item.code ?? ""),
      connectorInstance: item.connectorInstance ? String(item.connectorInstance) : "default",
      configured: item.configured === true || item.authenticationConfigured === true,
      connected:
        item.connected === true ||
        item.status === "configured" ||
        item.status === "active" ||
        item.status === "healthy",
      enabled: item.enabled !== false,
      status: item.status ? String(item.status) : null,
      health: item.health ? String(item.health) : null,
      lastVerified: item.lastVerified ? String(item.lastVerified) : item.lastSuccessfulConnection
        ? String(item.lastSuccessfulConnection)
        : null,
      label: item.label ? String(item.label) : null,
      category: item.category ? String(item.category) : null,
      authenticationConfigured: item.authenticationConfigured === true,
      metadata: item.metadata && typeof item.metadata === "object"
        ? (item.metadata as Record<string, unknown>)
        : null,
      source: item.source ? String(item.source) : null,
    }));
  }
  return [];
}

export async function fetchCompanyMcpConnectorRegistry(
  env: Env,
  mcp: {
    id: string;
    endpointUrl: string;
    adminSecretRef?: string | null;
    serviceBindingRef?: string | null;
  },
): Promise<{ ok: true; connectors: McpRegistryConnector[]; source: string } | { ok: false; error: string }> {
  const auth = resolveMcpAdminAuthHeader(env, {
    adminSecretRef: mcp.adminSecretRef ?? null,
  } as Parameters<typeof resolveMcpAdminAuthHeader>[1]);
  if (!auth.authorizationHeader) {
    return { ok: false, error: "MCP admin token is not configured" };
  }

  const endpoint = new URL(mcp.endpointUrl);
  const adminUrl = `${endpoint.origin}/admin/connectors`;
  const fetcher = resolveMcpFetcher(env, mcp.serviceBindingRef);
  const headers: Record<string, string> = {
    Authorization: auth.authorizationHeader,
    Accept: "application/json",
  };
  if (fetcher) headers.Host = endpoint.host;

  try {
    const request = new Request(adminUrl, { method: "GET", headers });
    const response = fetcher ? await fetcher.fetch(request) : await fetch(request);
    if (!response.ok) {
      return { ok: false, error: `MCP admin HTTP ${response.status}` };
    }
    const payload = await response.json();
    return {
      ok: true,
      connectors: parseConnectorsFromAdminPayload(payload),
      source: mcp.serviceBindingRef ?? mcp.id,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function applyRegistryRecords(
  db: D1Database,
  input: {
    companyId: string;
    mcpId: string;
    records: PlatformRegistryRecord[];
    actor: string;
  },
): Promise<ConnectorRegistrySyncResult> {
  const now = nowIso();
  const existing = await db
    .prepare(`SELECT * FROM connector_instances WHERE company_id = ?`)
    .bind(input.companyId)
    .all();
  const byDefinition = new Map<string, Record<string, unknown>>();
  for (const row of existing.results ?? []) {
    byDefinition.set(String(row.connector_definition_id), row);
  }

  const result: ConnectorRegistrySyncResult = {
    companyId: input.companyId,
    mcpId: input.mcpId,
    synced: 0,
    skipped: 0,
    failed: 0,
    records: [],
  };

  for (const record of input.records) {
    const definition = getConnectorById(record.catalogueId);
    if (!definition) {
      result.skipped += 1;
      continue;
    }
    const row = byDefinition.get(record.catalogueId) ?? null;
    const decision = decideRegistrySync({
      existing: row
        ? {
            id: String(row.id),
            companyId: input.companyId,
            connectorDefinitionId: record.catalogueId,
            status: String(row.status),
            authStatus: row.auth_status ? String(row.auth_status) : undefined,
            managedBy: row.managed_by ? (String(row.managed_by) as "infra" | "company_mcp") : undefined,
            healthStatus: row.health_status ? (String(row.health_status) as "healthy") : "unknown",
            providerHealth: row.provider_health ? (String(row.provider_health) as "healthy") : undefined,
          }
        : null,
      incoming: record,
    });
    if (decision.action === "skip") {
      result.skipped += 1;
      result.records.push({ catalogueId: record.catalogueId, connected: record.connected, action: "skip" });
      continue;
    }

    const id = row ? String(row.id) : registryInstanceId(input.companyId, record.catalogueId);
    const previousStatus = row ? String(row.status) : "missing";
    const status = record.connected ? "configured" : record.configured ? "configured" : "draft";
    const authStatus = record.connected ? "connected" : record.configured ? "configuring" : "not_configured";
    const healthStatus = record.health === "unknown" && record.connected ? "healthy" : record.health;
    const providerHealth = healthStatus;
    const lastVerified = record.lastVerified ?? (record.connected ? now : null);
    const metadata = JSON.stringify({
      ...(typeof row?.config_json === "string" ? safeJson(String(row.config_json)) : {}),
      sourceMcp: record.source,
      lastRegistrySyncAt: now,
      ...record.metadata,
    });

    try {
      if (row) {
        await db
          .prepare(
            `UPDATE connector_instances
             SET name = ?, status = ?, health_status = ?, health_message = ?,
                 auth_status = ?, provider_health = ?, sync_health = ?,
                 managed_by = COALESCE(managed_by, 'company_mcp'),
                 display_account_name = COALESCE(?, display_account_name),
                 last_successful_sync_at = COALESCE(?, last_successful_sync_at),
                 last_health_at = ?, last_verified_at = ?,
                 source_mcp_id = ?, source_connector_code = ?,
                 non_secret_metadata_json = ?, config_json = ?,
                 connected_at = CASE
                   WHEN connected_at IS NULL AND ? = 1 THEN ?
                   ELSE connected_at
                 END,
                 updated_at = ?
             WHERE id = ? AND company_id = ?`,
          )
          .bind(
            record.label,
            status,
            healthStatus,
            record.connected ? "Connected via company MCP" : "Reported by company MCP",
            authStatus,
            providerHealth,
            record.connected ? "completed" : "unknown",
            typeof record.metadata.organisationName === "string" ? record.metadata.organisationName : null,
            lastVerified,
            now,
            lastVerified,
            input.mcpId,
            record.connectorType,
            JSON.stringify(record.metadata),
            metadata,
            record.connected ? 1 : 0,
            now,
            now,
            id,
            input.companyId,
          )
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO connector_instances (
              id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
              health_status, health_message, auth_status, provider_health, sync_health,
              managed_by, display_account_name, last_successful_sync_at, last_health_at,
              last_verified_at, source_mcp_id, source_connector_code, non_secret_metadata_json,
              connected_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'company_mcp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.companyId,
            record.catalogueId,
            record.label,
            status,
            metadata,
            JSON.stringify({ enabled: record.connected, mode: "mcp", schedule: null }),
            healthStatus,
            record.connected ? "Connected via company MCP" : "Reported by company MCP",
            authStatus,
            providerHealth,
            record.connected ? "completed" : "unknown",
            typeof record.metadata.organisationName === "string" ? record.metadata.organisationName : null,
            lastVerified,
            now,
            lastVerified,
            input.mcpId,
            record.connectorType,
            JSON.stringify(record.metadata),
            record.connected ? now : null,
            now,
            now,
          )
          .run();
      }

      result.synced += 1;
      result.records.push({
        catalogueId: record.catalogueId,
        connected: record.connected,
        action: row ? "upsert" : "create",
      });

      if (previousStatus !== status) {
        await recordAuditEvent(db, {
          companyId: input.companyId,
          eventType: record.connected ? "connector.connected" : "connector.disconnected",
          actor: input.actor,
          resourceType: "connector_instance",
          resourceId: id,
          detail: {
            catalogueId: record.catalogueId,
            previousStatus,
            status,
            source: record.source,
          },
        });
      }
      if (record.health === "unhealthy") {
        await recordAuditEvent(db, {
          companyId: input.companyId,
          eventType: "connector.health_failure",
          actor: input.actor,
          resourceType: "connector_instance",
          resourceId: id,
          detail: { catalogueId: record.catalogueId, health: record.health },
        });
      }
    } catch {
      result.failed += 1;
    }
  }

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "connector.registry_synced",
    actor: input.actor,
    resourceType: "mcp",
    resourceId: input.mcpId,
    detail: { synced: result.synced, skipped: result.skipped, failed: result.failed },
  });

  return result;
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function syncCompanyMcpConnectorRegistry(
  env: Env,
  companyId: string,
  actor = "infra-system",
): Promise<ConnectorRegistrySyncResult> {
  const company = await getCompanyById(env.DB, companyId);
  if (!company) {
    return {
      companyId,
      mcpId: null,
      synced: 0,
      skipped: 0,
      failed: 0,
      records: [],
      error: "Company not found",
    };
  }

  const mcps = await listMcpEnvironments(env.DB, companyId);
  const mcp = mcps.find((item) => item.enabled) ?? mcps[0];
  if (!mcp) {
    return {
      companyId,
      mcpId: null,
      synced: 0,
      skipped: 0,
      failed: 0,
      records: [],
      error: "No MCP environment registered",
    };
  }

  const fetched = await fetchCompanyMcpConnectorRegistry(env, mcp);
  if (!fetched.ok) {
    return {
      companyId,
      mcpId: mcp.id,
      synced: 0,
      skipped: 0,
      failed: 0,
      records: [],
      error: fetched.error,
    };
  }

  const records = mapMcpConnectorsToRegistryRecords({
    connectors: fetched.connectors,
    source: fetched.source,
  });
  return applyRegistryRecords(env.DB, {
    companyId,
    mcpId: mcp.id,
    records,
    actor,
  });
}
