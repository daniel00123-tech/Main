import {
  deriveMirroredConnectorState,
  deriveStatusUrlFromMcpEndpoint,
  parseMcpConnectorSnapshot,
  resolveCatalogueConnector,
  type McpConnectorSnapshot,
  type MirroredConnectorState,
} from "@infra/shared";
import type { ConnectorInstance, McpEnvironment } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import type { Env } from "../env";
import { resolveMcpFetcher } from "./mcp-client";
import { listConnectorInstances, listMcpEnvironments, recordAuditEvent } from "./control-plane";

const MIRROR_FRESH_MS = 90_000;
const FETCH_TIMEOUT_MS = 6_000;

function asConfig(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && typeof value === "object" ? { ...value } : {};
}

function recentlyMirrored(instances: ConnectorInstance[]): boolean {
  const now = Date.now();
  return instances.some((instance) => {
    if (instance.managedBy !== "company_mcp") return false;
    if (instance.healthStatus !== "healthy" || instance.status === "draft") return false;
    if (!instance.lastHealthAt) return false;
    const at = Date.parse(instance.lastHealthAt);
    return Number.isFinite(at) && now - at < MIRROR_FRESH_MS;
  });
}

function preserveInfraManaged(instance: ConnectorInstance): boolean {
  if (instance.managedBy !== "infra") return false;
  return (
    instance.authStatus === "connected" ||
    instance.authStatus === "configuring" ||
    Boolean(instance.credentialRefId)
  );
}

export async function fetchCompanyMcpConnectorSnapshot(
  env: Env,
  mcp: McpEnvironment,
): Promise<McpConnectorSnapshot | null> {
  const statusUrl = deriveStatusUrlFromMcpEndpoint(mcp.endpointUrl);
  if (!statusUrl) return null;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "INFRA-connector-mirror/1.0",
  };
  try {
    headers.Host = new URL(mcp.endpointUrl).host;
  } catch {
    /* keep default host */
  }

  const fetcher = resolveMcpFetcher(env, mcp.serviceBindingRef);
  try {
    const request = new Request(statusUrl, { method: "GET", headers });
    const response = fetcher
      ? await fetcher.fetch(request)
      : await fetch(request, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    return parseMcpConnectorSnapshot(await response.json());
  } catch {
    return null;
  }
}

async function persistMirroredInstance(
  env: Env,
  input: {
    companyId: string;
    actor: string;
    existing: ConnectorInstance | undefined;
    definitionId: string;
    definitionName: string;
    mcpType: string;
    desired: MirroredConnectorState;
  },
): Promise<{ changed: boolean; connectedTransition: boolean }> {
  const now = nowIso();
  const existing = input.existing;

  if (existing && preserveInfraManaged(existing)) {
    if (!input.desired.connected) {
      return { changed: false, connectedTransition: false };
    }
    await env.DB.prepare(
      `UPDATE connector_instances
       SET provider_health = ?, health_status = ?, health_message = ?,
           last_health_at = ?, display_account_name = COALESCE(?, display_account_name),
           updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
      .bind(
        input.desired.providerHealth,
        input.desired.healthStatus,
        input.desired.healthMessage,
        now,
        input.desired.displayAccountName,
        now,
        existing.id,
        input.companyId,
      )
      .run();
    return { changed: true, connectedTransition: false };
  }

  const wasConnected =
    existing != null &&
    existing.status !== "draft" &&
    existing.authStatus === "connected" &&
    existing.healthStatus === "healthy";

  const config = asConfig(existing?.config);
  config.source = "company_mcp_registry";
  config.mcpConnectorType = input.mcpType;
  config.mirroredAt = now;
  delete config.note;

  const syncSettings = JSON.stringify(
    existing?.syncSettings ?? { enabled: false, mode: "manual", schedule: null },
  );

  if (!existing) {
    if (!input.desired.connected) return { changed: false, connectedTransition: false };
    const id = newId("ci");
    await env.DB.prepare(
      `INSERT INTO connector_instances (
        id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
        data_environment_id, last_sync_at, last_sync_status, last_sync_message,
        health_status, health_message, auth_status, sync_health, provider_health,
        display_account_name, external_account_id, managed_by, configured_by,
        connected_at, last_health_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
        ?, ?, ?, 'unknown', ?, ?, ?, 'company_mcp', ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.companyId,
        input.definitionId,
        input.definitionName,
        input.desired.status,
        JSON.stringify(config),
        syncSettings,
        input.desired.healthStatus,
        input.desired.healthMessage,
        input.desired.authStatus,
        input.desired.providerHealth,
        input.desired.displayAccountName,
        input.desired.externalAccountId,
        input.actor,
        now,
        now,
        now,
        now,
      )
      .run();
    return { changed: true, connectedTransition: true };
  }

  const nextStatus = input.desired.connected ? input.desired.status : "draft";
  const connectedAt = input.desired.connected ? (existing.connectedAt ?? now) : existing.connectedAt;

  await env.DB.prepare(
    `UPDATE connector_instances
     SET name = ?, status = ?, config_json = ?, health_status = ?, health_message = ?,
         auth_status = ?, provider_health = ?, display_account_name = ?,
         external_account_id = COALESCE(?, external_account_id),
         managed_by = 'company_mcp', connected_at = ?, last_health_at = ?,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
  )
    .bind(
      existing.name,
      nextStatus,
      JSON.stringify(config),
      input.desired.healthStatus,
      input.desired.healthMessage,
      input.desired.authStatus,
      input.desired.providerHealth,
      input.desired.displayAccountName,
      input.desired.externalAccountId,
      connectedAt,
      now,
      now,
      existing.id,
      input.companyId,
    )
    .run();

  return {
    changed: true,
    connectedTransition: input.desired.connected && !wasConnected,
  };
}

async function markMcpMirrorHealthy(
  env: Env,
  mcp: McpEnvironment,
  connectedCount: number,
): Promise<void> {
  const stale =
    !mcp.lastHealthyAt ||
    /awaiting|probe|routing/i.test(mcp.healthMessage ?? "") ||
    /probe|routing/i.test(mcp.lastError ?? "");
  if (!stale && mcp.status === "healthy") return;

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE mcp_environments
     SET status = CASE WHEN status IN ('registered', 'unhealthy', 'degraded') THEN 'healthy' ELSE status END,
         last_healthy_at = COALESCE(last_healthy_at, ?),
         health_message = ?,
         last_error = CASE WHEN last_error IS NOT NULL AND lower(last_error) LIKE '%probe%' THEN NULL ELSE last_error END,
         updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      now,
      `Company MCP connector registry synchronised · ${connectedCount} connected`,
      now,
      mcp.id,
    )
    .run();
}

/**
 * Mirror company-MCP connector registry/status into INFRA `connector_instances`.
 * Company MCP is authoritative. INFRA-managed OAuth in flight is not overwritten.
 */
export async function syncConnectorMirrorFromCompanyMcp(
  env: Env,
  input: {
    companyId: string;
    actor: string;
    instances?: ConnectorInstance[];
    mcp?: McpEnvironment | null;
    snapshot?: McpConnectorSnapshot | null;
    force?: boolean;
  },
): Promise<ConnectorInstance[]> {
  const instances = input.instances ?? (await listConnectorInstances(env.DB, input.companyId));
  const mcp =
    input.mcp ??
    (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled) ??
    null;

  if (!mcp) return instances;
  if (!input.force && !input.snapshot && recentlyMirrored(instances)) return instances;

  const snapshot = input.snapshot ?? (await fetchCompanyMcpConnectorSnapshot(env, mcp));
  if (!snapshot) return instances;

  const byDefinition = new Map(instances.map((item) => [item.connectorDefinitionId, item]));
  let connectedCount = 0;

  for (const advertised of snapshot.connectors) {
    const definition = resolveCatalogueConnector(advertised.type);
    if (!definition || definition.integrationType !== "business_system") continue;

    const desired = deriveMirroredConnectorState(advertised, {
      xero: snapshot.xero,
      microsoft: snapshot.microsoft,
    });
    if (desired.connected) connectedCount += 1;

    const existing = byDefinition.get(definition.id);
    const result = await persistMirroredInstance(env, {
      companyId: input.companyId,
      actor: input.actor,
      existing,
      definitionId: definition.id,
      definitionName: definition.name,
      mcpType: advertised.type,
      desired,
    });

    if (result.connectedTransition) {
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "connector.connected",
        actor: input.actor,
        resourceType: "connector",
        resourceId: existing?.id ?? definition.id,
        detail: {
          source: "company_mcp_registry",
          connector: definition.id,
          mcpType: advertised.type,
          displayAccountName: desired.displayAccountName,
        },
      });
    }
  }

  await markMcpMirrorHealthy(env, mcp, connectedCount);
  return listConnectorInstances(env.DB, input.companyId);
}
