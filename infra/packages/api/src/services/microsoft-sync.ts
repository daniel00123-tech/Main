/**
 * Microsoft 365 discovery and knowledge sync orchestration.
 * READ ONLY — app-only Graph authentication.
 */

import type { Env } from "../env";
import type { MicrosoftSourceType } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { getMcpEnvironment, listMcpEnvironments } from "./control-plane";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  buildMicrosoftProvenance,
  classifyMicrosoftFile,
  downloadDriveItemContent,
  formatMicrosoftSourceLabel,
  listAllDrives,
  listDriveChildren,
  listDriveDelta,
  listSiteDrives,
  listSites,
  type GraphDrive,
  type GraphDriveItem,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import {
  buildMicrosoftExternalId,
  uploadMicrosoftDocumentToKnowledge,
} from "./microsoft-knowledge-bridge";

export type MicrosoftSourceRow = {
  id: string;
  companyId: string;
  connectorInstanceId: string;
  sourceType: MicrosoftSourceType;
  externalId: string;
  displayName: string;
  pathOrUrl: string | null;
  mailboxAddress: string | null;
  inclusionStatus: "included" | "excluded" | "available";
  syncStatus: string;
  lastSyncAt: string | null;
  lastError: string | null;
  ownerUpn: string | null;
  ownerDisplayName: string | null;
  driveType: string | null;
  siteId: string | null;
  itemsDiscovered: number;
  itemsIndexed: number;
  lastDiscoveryAt: string | null;
  deltaLink: string | null;
};

function mapSourceRow(row: Record<string, unknown>): MicrosoftSourceRow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    connectorInstanceId: String(row.connector_instance_id),
    sourceType: String(row.source_type) as MicrosoftSourceType,
    externalId: String(row.external_id),
    displayName: String(row.display_name),
    pathOrUrl: row.path_or_url ? String(row.path_or_url) : null,
    mailboxAddress: row.mailbox_address ? String(row.mailbox_address) : null,
    inclusionStatus: String(row.inclusion_status) as MicrosoftSourceRow["inclusionStatus"],
    syncStatus: String(row.sync_status),
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    ownerUpn: row.owner_upn ? String(row.owner_upn) : null,
    ownerDisplayName: row.owner_display_name ? String(row.owner_display_name) : null,
    driveType: row.drive_type ? String(row.drive_type) : null,
    siteId: row.site_id ? String(row.site_id) : null,
    itemsDiscovered: Number(row.items_discovered ?? 0),
    itemsIndexed: Number(row.items_indexed ?? 0),
    lastDiscoveryAt: row.last_discovery_at ? String(row.last_discovery_at) : null,
    deltaLink: row.delta_link ? String(row.delta_link) : null,
  };
}

export async function listMicrosoftSources(
  db: D1Database,
  companyId: string,
  connectorInstanceId?: string | null,
): Promise<MicrosoftSourceRow[]> {
  const query = connectorInstanceId
    ? `SELECT * FROM microsoft_connector_sources WHERE company_id = ? AND connector_instance_id = ? ORDER BY source_type, display_name`
    : `SELECT * FROM microsoft_connector_sources WHERE company_id = ? ORDER BY source_type, display_name`;
  const binds = connectorInstanceId ? [companyId, connectorInstanceId] : [companyId];
  const result = await db.prepare(query).bind(...binds).all();
  return (result.results ?? []).map((row) => mapSourceRow(row as Record<string, unknown>));
}

async function upsertSource(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceType: MicrosoftSourceType;
    externalId: string;
    displayName: string;
    pathOrUrl?: string | null;
    ownerUpn?: string | null;
    ownerDisplayName?: string | null;
    driveType?: string | null;
    siteId?: string | null;
    inclusionStatus?: MicrosoftSourceRow["inclusionStatus"];
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id, inclusion_status FROM microsoft_connector_sources
       WHERE company_id = ? AND connector_instance_id = ? AND external_id = ? LIMIT 1`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.externalId)
    .first<{ id: string; inclusion_status: string }>();

  const now = nowIso();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE microsoft_connector_sources SET
          display_name = ?, path_or_url = ?, owner_upn = ?, owner_display_name = ?,
          drive_type = ?, site_id = ?, last_discovery_at = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.displayName,
        input.pathOrUrl ?? null,
        input.ownerUpn ?? null,
        input.ownerDisplayName ?? null,
        input.driveType ?? null,
        input.siteId ?? null,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }

  const id = newId("mss");
  await db
    .prepare(
      `INSERT INTO microsoft_connector_sources (
        id, company_id, connector_instance_id, source_type, external_id, display_name,
        path_or_url, mailbox_address, inclusion_status, sync_status, owner_upn, owner_display_name,
        drive_type, site_id, items_discovered, items_indexed, last_discovery_at, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      input.sourceType,
      input.externalId,
      input.displayName,
      input.pathOrUrl ?? null,
      input.inclusionStatus ?? "available",
      input.ownerUpn ?? null,
      input.ownerDisplayName ?? null,
      input.driveType ?? null,
      input.siteId ?? null,
      now,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    )
    .run();
  return id;
}

function driveSourceType(drive: GraphDrive): MicrosoftSourceType {
  if (drive.driveType === "documentLibrary") return "sharepoint";
  return "onedrive";
}

function driveOwner(drive: GraphDrive): { upn: string | null; name: string | null } {
  const user = drive.owner?.user ?? drive.createdBy?.user;
  return {
    upn: user?.email ?? null,
    name: user?.displayName ?? drive.name ?? null,
  };
}

export async function discoverMicrosoftSources(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    actor: string;
    includeAllOneDrives?: boolean;
    includeAllSharePoint?: boolean;
  },
): Promise<{ discovered: number; onedrive: number; sharepoint: number }> {
  const token = await acquireMicrosoftAppToken(env);
  if (!token.ok) throw new Error(token.message);

  const config: MicrosoftGraphConfig = {
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  };

  let discovered = 0;
  let onedrive = 0;
  let sharepoint = 0;

  const drives = await listAllDrives(config);
  for (const drive of drives) {
    const sourceType = driveSourceType(drive);
    const owner = driveOwner(drive);
    const inclusionStatus =
      sourceType === "onedrive"
        ? input.includeAllOneDrives
          ? "included"
          : "available"
        : input.includeAllSharePoint
          ? "included"
          : "available";

    await upsertSource(env.DB, {
      companyId: input.companyId,
      connectorInstanceId: input.connectorInstanceId,
      sourceType,
      externalId: drive.id,
      displayName: owner.name ?? drive.name,
      pathOrUrl: drive.webUrl,
      ownerUpn: owner.upn,
      ownerDisplayName: owner.name,
      driveType: drive.driveType,
      inclusionStatus,
      metadata: { webUrl: drive.webUrl, driveType: drive.driveType },
    });
    discovered++;
    if (sourceType === "onedrive") onedrive++;
    else sharepoint++;
  }

  const sites = await listSites(config);
  for (const site of sites) {
    const libraries = await listSiteDrives(config, site.id);
    for (const library of libraries) {
      const owner = driveOwner(library);
      await upsertSource(env.DB, {
        companyId: input.companyId,
        connectorInstanceId: input.connectorInstanceId,
        sourceType: "sharepoint",
        externalId: library.id,
        displayName: `${site.displayName ?? site.name} → ${library.name}`,
        pathOrUrl: library.webUrl ?? site.webUrl,
        ownerUpn: owner.upn,
        ownerDisplayName: owner.name,
        driveType: library.driveType,
        siteId: site.id,
        inclusionStatus: input.includeAllSharePoint ? "included" : "available",
        metadata: { siteId: site.id, siteName: site.displayName ?? site.name, libraryName: library.name },
      });
      discovered++;
      sharepoint++;
    }
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "connector.sync_completed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.connectorInstanceId,
    detail: {
      stage: "microsoft.discovery.completed",
      discovered,
      onedrive,
      sharepoint,
    },
  });

  return { discovered, onedrive, sharepoint };
}

async function enumerateDriveFiles(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderId?: string,
  pathPrefix = "",
  depth = 0,
  maxDepth = 12,
): Promise<Array<GraphDriveItem & { relativePath: string }>> {
  if (depth > maxDepth) return [];
  const children = await listDriveChildren(config, driveId, folderId);
  const files: Array<GraphDriveItem & { relativePath: string }> = [];

  for (const item of children) {
    const relativePath = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
    if (item.folder) {
      const nested = await enumerateDriveFiles(
        config,
        driveId,
        item.id,
        relativePath,
        depth + 1,
        maxDepth,
      );
      files.push(...nested);
    } else if (item.file) {
      files.push({ ...item, relativePath });
    }
  }
  return files;
}

async function upsertKnowledgeItem(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    sourceType: MicrosoftSourceType;
    externalItemId: string;
    externalId: string;
    title: string;
    path: string | null;
    mimeType: string | null;
    modifiedAt: string | null;
    webUrl: string | null;
    sizeBytes: number | null;
    eTag: string | null;
    provenance: Record<string, unknown>;
    indexingStatus: string;
    knowledgeDocumentId?: number | null;
    lastError?: string | null;
  },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM microsoft_knowledge_items
       WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
    )
    .bind(input.companyId, input.connectorInstanceId, input.externalItemId)
    .first<{ id: string }>();

  const now = nowIso();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE microsoft_knowledge_items SET
          title = ?, path = ?, mime_type = ?, modified_at = ?, web_url = ?, size_bytes = ?,
          e_tag = ?, provenance_json = ?, indexing_status = ?, knowledge_document_id = ?,
          external_id = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.title,
        input.path,
        input.mimeType,
        input.modifiedAt,
        input.webUrl,
        input.sizeBytes,
        input.eTag,
        JSON.stringify(input.provenance),
        input.indexingStatus,
        input.knowledgeDocumentId ?? null,
        input.externalId,
        input.lastError ?? null,
        now,
        existing.id,
      )
      .run();
    return existing.id;
  }

  const id = newId("mki");
  await db
    .prepare(
      `INSERT INTO microsoft_knowledge_items (
        id, company_id, connector_instance_id, source_id, source_type, external_item_id,
        external_id, title, path, mime_type, modified_at, web_url, size_bytes, e_tag,
        provenance_json, indexing_status, knowledge_document_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      input.sourceId,
      input.sourceType,
      input.externalItemId,
      input.externalId,
      input.title,
      input.path,
      input.mimeType,
      input.modifiedAt,
      input.webUrl,
      input.sizeBytes,
      input.eTag,
      JSON.stringify(input.provenance),
      input.indexingStatus,
      input.knowledgeDocumentId ?? null,
      input.lastError ?? null,
      now,
      now,
    )
    .run();
  return id;
}

export async function syncMicrosoftSource(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    actor: string;
    useDelta?: boolean;
    maxFiles?: number;
  },
): Promise<{
  discovered: number;
  indexed: number;
  skipped: number;
  failed: number;
  deleted: number;
}> {
  const sourceRow = await env.DB.prepare(`SELECT * FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(input.sourceId, input.companyId)
    .first<Record<string, unknown>>();
  if (!sourceRow) throw new Error("Microsoft source not found");
  const source = mapSourceRow(sourceRow);

  if (source.inclusionStatus !== "included") {
    throw new Error("Source is not included — enable inclusion before sync");
  }

  const token = await acquireMicrosoftAppToken(env);
  if (!token.ok) throw new Error(token.message);

  const config: MicrosoftGraphConfig = {
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  };

  const mcps = await listMcpEnvironments(env.DB, input.companyId);
  const mcp = mcps[0] ?? null;
  if (!mcp) throw new Error("No Business MCP registered for this company");

  await env.DB.prepare(
    `UPDATE microsoft_connector_sources SET sync_status = 'syncing', updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), source.id).run();

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "connector.sync_started",
    actor: input.actor,
    resourceType: "connector",
    resourceId: source.id,
    detail: { stage: "microsoft.sync.started", sourceName: source.displayName },
  });

  let discovered = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let deleted = 0;
  const maxFiles = input.maxFiles ?? 200;

  try {
    let files: Array<GraphDriveItem & { relativePath: string }> = [];

    if (input.useDelta && source.deltaLink) {
      const delta = await listDriveDelta(config, source.externalId, source.deltaLink);
      await env.DB.prepare(`UPDATE microsoft_connector_sources SET delta_link = ?, updated_at = ? WHERE id = ?`)
        .bind(delta.deltaLink, nowIso(), source.id)
        .run();

      for (const item of delta.items) {
        if (item.deleted) {
          await env.DB.prepare(
            `UPDATE microsoft_knowledge_items SET indexing_status = 'deleted', updated_at = ? WHERE company_id = ? AND external_item_id = ?`,
          ).bind(nowIso(), input.companyId, item.id).run();
          deleted++;
          continue;
        }
        if (!item.folder && item.file) {
          files.push({ ...item, relativePath: item.name });
        }
      }
    } else {
      files = await enumerateDriveFiles(config, source.externalId);
    }

    for (const file of files.slice(0, maxFiles)) {
      discovered++;
      const classification = classifyMicrosoftFile(file.file?.mimeType ?? file.mimeType ?? null, file.name);
      const externalId = buildMicrosoftExternalId({
        sourceType: source.sourceType,
        driveId: source.externalId,
        itemId: file.id,
      });

      const provenance = buildMicrosoftProvenance({
        companyId: input.companyId,
        tenantId: token.tenantId,
        sourceType: source.sourceType,
        externalItemId: file.id,
        path: file.relativePath,
        filename: file.name,
        modifiedAt: file.lastModifiedDateTime,
        driveId: source.externalId,
        siteId: source.siteId,
        webUrl: file.webUrl,
        inclusionStatus: "included",
      });

      if (classification.indexingStatus !== "indexable") {
        await upsertKnowledgeItem(env.DB, {
          companyId: input.companyId,
          connectorInstanceId: input.connectorInstanceId,
          sourceId: source.id,
          sourceType: source.sourceType,
          externalItemId: file.id,
          externalId,
          title: file.name,
          path: file.relativePath,
          mimeType: file.file?.mimeType ?? file.mimeType ?? null,
          modifiedAt: file.lastModifiedDateTime,
          webUrl: file.webUrl,
          sizeBytes: file.size ?? null,
          eTag: file.eTag ?? null,
          provenance: { ...provenance, sourceLabel: formatMicrosoftSourceLabel({ sourceType: source.sourceType, displayName: source.displayName, path: file.relativePath, filename: file.name }) },
          indexingStatus: classification.indexingStatus === "catalogue_only" ? "unsupported" : "skipped",
          lastError: classification.reason,
        });
        skipped++;
        continue;
      }

      try {
        const download = await downloadDriveItemContent(config, source.externalId, file.id);
        const upload = await uploadMicrosoftDocumentToKnowledge(env, mcp, {
          filename: file.name,
          bytes: download.bytes,
          mimeType: download.mimeType,
          externalId,
          title: file.name,
          metadata: {
            ...provenance,
            sourceType: source.sourceType,
            companyId: input.companyId,
            topic: formatMicrosoftSourceLabel({ sourceType: source.sourceType, displayName: source.displayName, path: file.relativePath, filename: file.name }),
          },
          autoIndex: true,
        });

        if (!upload.ok) {
          failed++;
          await upsertKnowledgeItem(env.DB, {
            companyId: input.companyId,
            connectorInstanceId: input.connectorInstanceId,
            sourceId: source.id,
            sourceType: source.sourceType,
            externalItemId: file.id,
            externalId,
            title: file.name,
            path: file.relativePath,
            mimeType: download.mimeType,
            modifiedAt: file.lastModifiedDateTime,
            webUrl: file.webUrl,
            sizeBytes: download.contentLength,
            eTag: file.eTag ?? null,
            provenance,
            indexingStatus: "failed",
            lastError: upload.message,
          });
          continue;
        }

        await upsertKnowledgeItem(env.DB, {
          companyId: input.companyId,
          connectorInstanceId: input.connectorInstanceId,
          sourceId: source.id,
          sourceType: source.sourceType,
          externalItemId: file.id,
          externalId,
          title: file.name,
          path: file.relativePath,
          mimeType: download.mimeType,
          modifiedAt: file.lastModifiedDateTime,
          webUrl: file.webUrl,
          sizeBytes: download.contentLength,
          eTag: file.eTag ?? null,
          provenance,
          indexingStatus: "indexed",
          knowledgeDocumentId: upload.documentId,
        });
        indexed++;
      } catch (err) {
        failed++;
        await upsertKnowledgeItem(env.DB, {
          companyId: input.companyId,
          connectorInstanceId: input.connectorInstanceId,
          sourceId: source.id,
          sourceType: source.sourceType,
          externalItemId: file.id,
          externalId,
          title: file.name,
          path: file.relativePath,
          mimeType: file.file?.mimeType ?? null,
          modifiedAt: file.lastModifiedDateTime,
          webUrl: file.webUrl,
          sizeBytes: file.size ?? null,
          eTag: file.eTag ?? null,
          provenance,
          indexingStatus: "failed",
          lastError: err instanceof Error ? err.message : "Sync failed",
        });
      }
    }

    if (!input.useDelta) {
      const delta = await listDriveDelta(config, source.externalId, null);
      await env.DB.prepare(`UPDATE microsoft_connector_sources SET delta_link = ?, updated_at = ? WHERE id = ?`)
        .bind(delta.deltaLink, nowIso(), source.id)
        .run();
    }

    const syncStatus = failed > 0 ? "needs_attention" : "healthy";
    await env.DB.prepare(
      `UPDATE microsoft_connector_sources SET sync_status = ?, last_sync_at = ?, last_error = NULL,
       items_discovered = ?, items_indexed = ?, updated_at = ? WHERE id = ?`,
    ).bind(syncStatus, nowIso(), discovered, indexed, nowIso(), source.id).run();

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "connector.sync_completed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: source.id,
      detail: {
        stage: "microsoft.sync.completed",
        discovered,
        indexed,
        skipped,
        failed,
        deleted,
      },
    });

    return { discovered, indexed, skipped, failed, deleted };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await env.DB.prepare(
      `UPDATE microsoft_connector_sources SET sync_status = 'error', last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(message, nowIso(), source.id).run();

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "connector.sync_failed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: source.id,
      detail: { stage: "microsoft.sync.failed", error: message },
    });
    throw err;
  }
}

export async function setMicrosoftSourceInclusion(
  db: D1Database,
  input: {
    companyId: string;
    sourceId: string;
    inclusionStatus: "included" | "excluded" | "available";
    actor: string;
  },
): Promise<void> {
  const source = await db
    .prepare(`SELECT * FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(input.sourceId, input.companyId)
    .first<{ display_name: string }>();
  if (!source) throw new Error("Source not found");

  await db
    .prepare(`UPDATE microsoft_connector_sources SET inclusion_status = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .bind(input.inclusionStatus, nowIso(), input.sourceId, input.companyId)
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "connector.changed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.sourceId,
    detail: {
      stage:
        input.inclusionStatus === "included"
          ? "microsoft.source.included"
          : input.inclusionStatus === "excluded"
            ? "microsoft.source.excluded"
            : "microsoft.source.available",
      sourceName: source.display_name,
      inclusionStatus: input.inclusionStatus,
    },
  });
}

export async function getMicrosoftConnectorHealth(env: Env): Promise<{
  credentials: ReturnType<typeof import("./microsoft-auth").microsoftCredentialStatus>;
  graph: Awaited<ReturnType<typeof import("./microsoft-graph").probeMicrosoftGraph>> | null;
  knowledgeBridgeConfigured: boolean;
  adminBridge: Awaited<ReturnType<typeof import("./microsoft-acceptance").probeAdminKnowledgeBridge>> | null;
}> {
  const { microsoftCredentialStatus } = await import("./microsoft-auth");
  const { probeMicrosoftGraph } = await import("./microsoft-graph");
  const { probeAdminKnowledgeBridge } = await import("./microsoft-acceptance");
  const credentials = microsoftCredentialStatus(env);
  let graph = null;
  let adminBridge = null;
  if (credentials.configured) {
    const token = await acquireMicrosoftAppToken(env);
    if (token.ok) {
      graph = await probeMicrosoftGraph({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      });
    }
  }
  if (
    typeof env.CADDINGTON_ADMIN_TOKEN === "string" &&
    env.CADDINGTON_ADMIN_TOKEN.trim()
  ) {
    adminBridge = await probeAdminKnowledgeBridge(env);
  }
  return {
    credentials,
    graph,
    knowledgeBridgeConfigured: Boolean(
      typeof env.CADDINGTON_ADMIN_TOKEN === "string" && env.CADDINGTON_ADMIN_TOKEN.trim(),
    ),
    adminBridge,
  };
}
