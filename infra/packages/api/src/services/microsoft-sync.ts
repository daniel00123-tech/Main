/**
 * Microsoft 365 discovery and knowledge sync orchestration.
 * READ ONLY — app-only Graph authentication.
 */

import type { Env } from "../env";
import type { MicrosoftSourceType } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import { listMcpEnvironments } from "./control-plane";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  buildMicrosoftProvenance,
  classifyMicrosoftFile,
  formatMicrosoftSourceLabel,
  listAllDrives,
  listDriveChildren,
  listDriveDelta,
  listSiteDrives,
  listSites,
  listUserOneDrives,
  type GraphDrive,
  type GraphDriveItem,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import {
  buildMicrosoftExternalId,
  deactivateMicrosoftKnowledgeDocument,
} from "./microsoft-knowledge-bridge";
import {
  createMicrosoftFileJob,
  drainMicrosoftFileJobsForSyncRun,
  finalizeMicrosoftSyncRunIfComplete,
  getMicrosoftSourceJobStats,
  hasMicrosoftKnowledgeQueue,
} from "./microsoft-queue";
import { kickMicrosoftJobProcessor } from "./microsoft-job-processor";
import { upsertKnowledgeItem } from "./microsoft-sync-internals";
import {
  normaliseFolderPath,
  parseFolderScope,
  pathMatchesFolderScope,
  serializeFolderScope,
  type FolderScope,
} from "./microsoft-folder-scope";

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
  folderScopeMode: "all" | "include_paths" | "exclude_paths";
  folderIncludePaths: string[];
  folderExcludePaths: string[];
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
    ...(() => {
      const scope = parseFolderScope({
        folderScopeMode: row.folder_scope_mode ? String(row.folder_scope_mode) : null,
        folderIncludePathsJson: row.folder_include_paths_json ? String(row.folder_include_paths_json) : null,
        folderExcludePathsJson: row.folder_exclude_paths_json ? String(row.folder_exclude_paths_json) : null,
      });
      return {
        folderScopeMode: scope.mode,
        folderIncludePaths: scope.includePaths,
        folderExcludePaths: scope.excludePaths,
      };
    })(),
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
  const driveIds = new Set(drives.map((d) => d.id));
  for (const userDrive of await listUserOneDrives(config)) {
    if (!driveIds.has(userDrive.id)) {
      drives.push(userDrive);
      driveIds.add(userDrive.id);
    }
  }
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
      displayName:
        sourceType === "onedrive"
          ? `${owner.name ?? drive.name} (OneDrive)`
          : owner.name ?? drive.name,
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

async function findFolderByPath(
  config: MicrosoftGraphConfig,
  driveId: string,
  targetPath: string,
): Promise<{ folderId: string; path: string } | null> {
  const segments = normaliseFolderPath(targetPath).split("/").filter(Boolean);
  if (segments.length === 0) return { folderId: "root", path: "" };
  let folderId: string | undefined;
  let pathPrefix = "";
  for (const segment of segments) {
    const children = await listDriveChildren(config, driveId, folderId);
    const match = children.find(
      (item) => item.folder && item.name.toLowerCase() === segment.toLowerCase(),
    );
    if (!match?.id) return null;
    folderId = match.id;
    pathPrefix = pathPrefix ? `${pathPrefix}/${match.name}` : match.name;
  }
  return { folderId, path: pathPrefix };
}

async function enumerateScopedDriveFiles(
  config: MicrosoftGraphConfig,
  driveId: string,
  scope: FolderScope,
): Promise<Array<GraphDriveItem & { relativePath: string }>> {
  if (scope.mode === "include_paths" && scope.includePaths.length > 0) {
    const files: Array<GraphDriveItem & { relativePath: string }> = [];
    for (const includePath of scope.includePaths) {
      const folder = await findFolderByPath(config, driveId, includePath);
      if (!folder) continue;
      const nested = await enumerateDriveFiles(
        config,
        driveId,
        folder.folderId === "root" ? undefined : folder.folderId,
        folder.path,
      );
      files.push(...nested.filter((f) => pathMatchesFolderScope(f.relativePath, scope)));
    }
    return files;
  }
  const all = await enumerateDriveFiles(config, driveId);
  return all.filter((f) => pathMatchesFolderScope(f.relativePath, scope));
}

async function recordSyncRun(
  db: D1Database,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    runType: "sync" | "discovery" | "full_sync";
    status: "running" | "completed" | "failed" | "partial";
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId("msr");
  await db
    .prepare(
      `INSERT INTO microsoft_sync_runs (
        id, company_id, connector_instance_id, run_type, status, started_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.companyId,
      input.connectorInstanceId,
      input.runType,
      input.status,
      nowIso(),
      input.metadata ? JSON.stringify(input.metadata) : null,
    )
    .run();
  return id;
}

async function completeSyncRun(
  db: D1Database,
  runId: string,
  input: {
    status: "completed" | "failed" | "partial";
    sourcesProcessed?: number;
    itemsDiscovered?: number;
    itemsIndexed?: number;
    itemsFailed?: number;
    errorSummary?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE microsoft_sync_runs SET
        status = ?, sources_processed = ?, items_discovered = ?, items_indexed = ?,
        items_failed = ?, completed_at = ?, error_summary = ?, metadata_json = COALESCE(?, metadata_json)
       WHERE id = ?`,
    )
    .bind(
      input.status,
      input.sourcesProcessed ?? 0,
      input.itemsDiscovered ?? 0,
      input.itemsIndexed ?? 0,
      input.itemsFailed ?? 0,
      nowIso(),
      input.errorSummary ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      runId,
    )
    .run();
}

export async function tombstoneMicrosoftSourceKnowledge(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    actor: string;
    folderPaths?: string[];
  },
): Promise<{ tombstoned: number; failed: number }> {
  const mcps = await listMcpEnvironments(env.DB, input.companyId);
  const mcp = mcps[0] ?? null;

  const rows = await env.DB.prepare(
    `SELECT id, knowledge_document_id, path, visibility_status
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND connector_instance_id = ? AND source_id = ?
       AND knowledge_document_id IS NOT NULL AND visibility_status = 'active'`,
  )
    .bind(input.companyId, input.connectorInstanceId, input.sourceId)
    .all<{ id: string; knowledge_document_id: number; path: string | null; visibility_status: string }>();

  let tombstoned = 0;
  let failed = 0;
  const folderPaths = (input.folderPaths ?? []).map(normaliseFolderPath);

  for (const row of rows.results ?? []) {
    if (folderPaths.length > 0) {
      const itemPath = normaliseFolderPath(row.path ?? "");
      const inScope = folderPaths.some(
        (p) => itemPath === p || itemPath.startsWith(`${p}/`),
      );
      if (!inScope) continue;
    }
    if (!mcp) {
      failed++;
      continue;
    }
    const result = await deactivateMicrosoftKnowledgeDocument(env, mcp, row.knowledge_document_id);
    if (!result.ok) {
      failed++;
      continue;
    }
    await env.DB.prepare(
      `UPDATE microsoft_knowledge_items SET visibility_status = 'tombstoned', indexing_status = 'deleted', updated_at = ?
       WHERE id = ?`,
    )
      .bind(nowIso(), row.id)
      .run();
    tombstoned++;
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "connector.changed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.sourceId,
    detail: {
      stage: "microsoft.knowledge.tombstoned",
      tombstoned,
      failed,
      folderPaths: input.folderPaths ?? [],
    },
  });

  return { tombstoned, failed };
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
    drainInline?: boolean;
    onJobsEnqueued?: (syncRunId: string) => void;
  },
): Promise<{
  discovered: number;
  queued: number;
  indexed: number;
  skipped: number;
  unsupported: number;
  failed: number;
  deleted: number;
  syncRunId: string;
  mode: "queue" | "inline";
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
  if (!mcps[0]) throw new Error("No Business MCP registered for this company");

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
  let queued = 0;
  let skipped = 0;
  let unsupported = 0;
  let deleted = 0;
  const maxFiles = input.maxFiles ?? 10_000;
  const folderScope: FolderScope = {
    mode: source.folderScopeMode,
    includePaths: source.folderIncludePaths,
    excludePaths: source.folderExcludePaths,
  };
  const queueMode = hasMicrosoftKnowledgeQueue(env) && input.drainInline !== true;

  const syncRunId = await recordSyncRun(env.DB, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
    sourceId: source.id,
    runType: "sync",
    status: "running",
    metadata: {
      sourceName: source.displayName,
      sourceType: source.sourceType,
      folderScope,
      useDelta: Boolean(input.useDelta && source.deltaLink),
      ingestionMode: queueMode ? "queue" : "inline",
    },
  });

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
            `UPDATE microsoft_knowledge_items SET indexing_status = 'deleted', visibility_status = 'tombstoned', updated_at = ? WHERE company_id = ? AND external_item_id = ?`,
          ).bind(nowIso(), input.companyId, item.id).run();
          deleted++;
          continue;
        }
        if (!item.folder && item.file) {
          const relativePath = item.name;
          if (pathMatchesFolderScope(relativePath, folderScope)) {
            files.push({ ...item, relativePath });
          }
        }
      }
    } else {
      files = await enumerateScopedDriveFiles(config, source.externalId, folderScope);
      await env.DB.prepare(
        `UPDATE microsoft_connector_sources SET last_discovery_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(nowIso(), nowIso(), source.id)
        .run();
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

      const existingItem = await env.DB.prepare(
        `SELECT indexing_status, knowledge_document_id, e_tag, visibility_status
         FROM microsoft_knowledge_items
         WHERE company_id = ? AND connector_instance_id = ? AND external_item_id = ? LIMIT 1`,
      )
        .bind(input.companyId, input.connectorInstanceId, file.id)
        .first<{
          indexing_status: string;
          knowledge_document_id: number | null;
          e_tag: string | null;
          visibility_status: string | null;
        }>();

      if (
        existingItem?.indexing_status === "indexed" &&
        existingItem.knowledge_document_id &&
        existingItem.visibility_status === "active" &&
        existingItem.e_tag === (file.eTag ?? null)
      ) {
        skipped++;
        continue;
      }

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
          provenance: {
            ...provenance,
            sourceLabel: formatMicrosoftSourceLabel({
              sourceType: source.sourceType,
              displayName: source.displayName,
              path: file.relativePath,
              filename: file.name,
            }),
          },
          indexingStatus: classification.indexingStatus === "catalogue_only" ? "unsupported" : "skipped",
          lastError: classification.reason,
        });
        unsupported++;
        continue;
      }

      const job = await createMicrosoftFileJob(env, {
        companyId: input.companyId,
        connectorInstanceId: input.connectorInstanceId,
        sourceId: source.id,
        syncRunId,
        driveId: source.externalId,
        externalItemId: file.id,
        fileName: file.name,
        relativePath: file.relativePath,
        mimeType: file.file?.mimeType ?? file.mimeType ?? null,
        eTag: file.eTag ?? null,
        modifiedAt: file.lastModifiedDateTime,
        webUrl: file.webUrl ?? null,
        sizeBytes: file.size ?? null,
        sendToQueue: queueMode,
      });
      if (!job.duplicate) {
        queued++;
      } else if (existingItem?.indexing_status === "failed") {
        queued++;
      }
    }

    const pendingForRun = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM microsoft_file_jobs
       WHERE sync_run_id = ? AND status IN ('queued', 'retrying')`,
    )
      .bind(syncRunId)
      .first<{ count: number }>();

    if (!input.useDelta) {
      const delta = await listDriveDelta(config, source.externalId, null);
      await env.DB.prepare(`UPDATE microsoft_connector_sources SET delta_link = ?, updated_at = ? WHERE id = ?`)
        .bind(delta.deltaLink, nowIso(), source.id)
        .run();
    }

    if (!queueMode && (queued > 0 || (pendingForRun?.count ?? 0) > 0)) {
      if (input.drainInline) {
        await drainMicrosoftFileJobsForSyncRun(env, syncRunId);
      } else if (input.onJobsEnqueued) {
        input.onJobsEnqueued(syncRunId);
      }
    }

    if (queued === 0) {
      await finalizeMicrosoftSyncRunIfComplete(env, syncRunId, source.id);
    }

    const jobStats = await getMicrosoftSourceJobStats(env.DB, {
      companyId: input.companyId,
      sourceId: source.id,
      syncRunId,
    });

    const indexed = (jobStats.byStatus.indexed ?? 0) + (jobStats.byStatus.skipped_unchanged ?? 0);
    const failed = (jobStats.byStatus.failed ?? 0) + (jobStats.byStatus.dead_letter ?? 0);

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: queued > 0 && queueMode ? "connector.sync_started" : "connector.sync_completed",
      actor: input.actor,
      resourceType: "connector",
      resourceId: source.id,
      detail: {
        stage: queued > 0 && queueMode ? "microsoft.sync.enqueued" : "microsoft.sync.completed",
        discovered,
        queued,
        skipped,
        unsupported,
        failed,
        deleted,
        folderScope,
        syncRunId,
        mode: queueMode ? "queue" : "inline",
      },
    });

    if (queued === 0 || !queueMode) {
      await completeSyncRun(env.DB, syncRunId, {
        status: failed > 0 ? "partial" : "completed",
        sourcesProcessed: 1,
        itemsDiscovered: discovered,
        itemsIndexed: indexed,
        itemsFailed: failed,
        metadata: { skipped, unsupported, deleted, folderScope, queued: 0 },
      });
    } else {
      await env.DB.prepare(
        `UPDATE microsoft_sync_runs SET items_discovered = ?, metadata_json = ? WHERE id = ?`,
      )
        .bind(
          discovered,
          JSON.stringify({
            sourceName: source.displayName,
            folderScope,
            queued,
            skipped,
            unsupported,
            deleted,
            ingestionMode: "queue",
          }),
          syncRunId,
        )
        .run();
    }

    return {
      discovered,
      queued,
      indexed,
      skipped,
      unsupported,
      failed,
      deleted,
      syncRunId,
      mode: queueMode ? "queue" : "inline",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await env.DB.prepare(
      `UPDATE microsoft_connector_sources SET sync_status = 'error', last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(message, nowIso(), source.id).run();

    await completeSyncRun(env.DB, syncRunId, {
      status: "failed",
      errorSummary: message,
    });

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

export { getMicrosoftSourceJobStats };

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
    .first<{ display_name: string; connector_instance_id: string }>();
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

export async function setMicrosoftSourceFolderScope(
  db: D1Database,
  input: {
    companyId: string;
    sourceId: string;
    folderScope: FolderScope;
    actor: string;
  },
): Promise<void> {
  const source = await db
    .prepare(`SELECT display_name FROM microsoft_connector_sources WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(input.sourceId, input.companyId)
    .first<{ display_name: string }>();
  if (!source) throw new Error("Source not found");

  const serialised = serializeFolderScope(input.folderScope);
  await db
    .prepare(
      `UPDATE microsoft_connector_sources SET
        folder_scope_mode = ?, folder_include_paths_json = ?, folder_exclude_paths_json = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(
      serialised.folderScopeMode,
      serialised.folderIncludePathsJson,
      serialised.folderExcludePathsJson,
      nowIso(),
      input.sourceId,
      input.companyId,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "connector.changed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.sourceId,
    detail: {
      stage: "microsoft.source.folder_scope_updated",
      sourceName: source.display_name,
      folderScope: input.folderScope,
    },
  });
}

export async function applyMicrosoftSourceExclusion(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    actor: string;
  },
): Promise<{ tombstoned: number; failed: number }> {
  await setMicrosoftSourceInclusion(env.DB, {
    companyId: input.companyId,
    sourceId: input.sourceId,
    inclusionStatus: "excluded",
    actor: input.actor,
  });
  return tombstoneMicrosoftSourceKnowledge(env, input);
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
