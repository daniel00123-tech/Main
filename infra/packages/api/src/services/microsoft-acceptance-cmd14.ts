/**
 * CMD14 — Queue-based Microsoft OneDrive scale hardening acceptance.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { executeRegisteredMcpTool } from "./control-plane";
import {
  listMicrosoftSources,
  setMicrosoftSourceFolderScope,
  setMicrosoftSourceInclusion,
  syncMicrosoftSource,
} from "./microsoft-sync";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  classifyMicrosoftFile,
  getUserOneDrive,
  listDriveChildren,
  listTenantUsers,
  type GraphDriveItem,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import {
  getMicrosoftSourceJobStats,
  waitForMicrosoftSyncRun,
  MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
  hasMicrosoftKnowledgeQueue,
} from "./microsoft-queue";

const COMPANY_ID = "co_caddington";
const CONNECTOR_DEF = "conn_microsoft_365";
const DANIEL_SOURCE_HINT = "Daniel Dwyer";

async function ensureConnectorInstance(db: D1Database): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = ? LIMIT 1`,
    )
    .bind(COMPANY_ID, CONNECTOR_DEF)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = `ci_ms365_${Date.now()}`;
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Microsoft 365', 'configured', 'connected', ?, ?)`,
    )
    .bind(id, COMPANY_ID, CONNECTOR_DEF, now, now)
    .run();
  return id;
}

async function resolveDanielSource(env: Env): Promise<{
  sourceId: string;
  connectorInstanceId: string;
  driveId: string;
  displayName: string;
} | null> {
  const connectorInstanceId = await ensureConnectorInstance(env.DB);
  const sources = await listMicrosoftSources(env.DB, COMPANY_ID, connectorInstanceId);
  const daniel = sources.find(
    (s) =>
      s.sourceType === "onedrive" &&
      (s.displayName.includes(DANIEL_SOURCE_HINT) || s.ownerDisplayName?.includes("Daniel")),
  );
  if (daniel) {
    return {
      sourceId: daniel.id,
      connectorInstanceId,
      driveId: daniel.externalId,
      displayName: daniel.displayName,
    };
  }

  const token = await acquireMicrosoftAppToken(env);
  if (!token.ok) return null;
  const config: MicrosoftGraphConfig = { accessToken: token.accessToken, tenantId: token.tenantId };
  const users = await listTenantUsers(config);
  const danielUser =
    users.find((u) => (u.displayName ?? "").toLowerCase().includes("daniel")) ??
    users.find((u) => (u.userPrincipalName ?? "").toLowerCase().includes("daniel"));
  if (!danielUser?.id) return null;
  const drive = await getUserOneDrive(config, danielUser.id);
  if (!drive?.id) return null;

  const sourceId = newId("mss");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO microsoft_connector_sources (
      id, company_id, connector_instance_id, source_type, external_id, display_name,
      inclusion_status, sync_status, owner_upn, owner_display_name, drive_type,
      folder_scope_mode, items_discovered, items_indexed, created_at, updated_at
    ) VALUES (?, ?, ?, 'onedrive', ?, ?, 'available', 'pending', ?, ?, 'personal', 'all', 0, 0, ?, ?)`,
  )
    .bind(
      sourceId,
      COMPANY_ID,
      connectorInstanceId,
      drive.id,
      `${danielUser.displayName ?? "Daniel Dwyer"} (OneDrive)`,
      danielUser.userPrincipalName ?? null,
      danielUser.displayName ?? null,
      now,
      now,
    )
    .run();

  return {
    sourceId,
    connectorInstanceId,
    driveId: drive.id,
    displayName: `${danielUser.displayName ?? "Daniel Dwyer"} (OneDrive)`,
  };
}

async function enumerateInventory(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderId?: string,
  pathPrefix = "",
  depth = 0,
): Promise<{
  folders: number;
  files: Array<GraphDriveItem & { relativePath: string }>;
}> {
  if (depth > 14) return { folders: 0, files: [] };
  const children = await listDriveChildren(config, driveId, folderId);
  let folders = 0;
  const files: Array<GraphDriveItem & { relativePath: string }> = [];
  for (const item of children) {
    const relativePath = pathPrefix ? `${pathPrefix}/${item.name}` : item.name;
    if (item.folder) {
      folders++;
      const nested = await enumerateInventory(config, driveId, item.id, relativePath, depth + 1);
      folders += nested.folders;
      files.push(...nested.files);
    } else if (item.file) {
      files.push({ ...item, relativePath });
    }
  }
  return { folders, files };
}

export async function runCmd14Discovery(env: Env): Promise<Record<string, unknown>> {
  const daniel = await resolveDanielSource(env);
  if (!daniel) return { phase: "discover", verdict: "STOPPED_NO_DANIEL_SOURCE" };

  const beforeScope = await env.DB.prepare(
    `SELECT folder_scope_mode, folder_include_paths_json FROM microsoft_connector_sources WHERE id = ? LIMIT 1`,
  )
    .bind(daniel.sourceId)
    .first<{ folder_scope_mode: string; folder_include_paths_json: string | null }>();

  await setMicrosoftSourceFolderScope(env.DB, {
    companyId: COMPANY_ID,
    sourceId: daniel.sourceId,
    folderScope: { mode: "all", includePaths: [], excludePaths: [] },
    actor: "cmd14-discovery",
  });
  await setMicrosoftSourceInclusion(env.DB, {
    companyId: COMPANY_ID,
    sourceId: daniel.sourceId,
    inclusionStatus: "included",
    actor: "cmd14-discovery",
  });

  const token = await acquireMicrosoftAppToken(env);
  if (!token.ok) return { phase: "discover", verdict: "STOPPED_GRAPH_AUTH" };

  const config: MicrosoftGraphConfig = { accessToken: token.accessToken, tenantId: token.tenantId };
  const inventory = await enumerateInventory(config, daniel.driveId);

  const fileTypes: Record<string, number> = {};
  let indexable = 0;
  let catalogueOnly = 0;
  let totalBytes = 0;
  for (const file of inventory.files) {
    const ext = file.name.includes(".") ? file.name.split(".").pop()?.toLowerCase() ?? "none" : "none";
    fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
    totalBytes += file.size ?? 0;
    const classification = classifyMicrosoftFile(file.file?.mimeType ?? file.mimeType ?? null, file.name);
    if (classification.indexingStatus === "indexable") indexable++;
    else if (classification.indexingStatus === "catalogue_only") catalogueOnly++;
  }

  const existingIndexed = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM microsoft_knowledge_items
     WHERE company_id = ? AND source_id = ? AND indexing_status = 'indexed'`,
  )
    .bind(COMPANY_ID, daniel.sourceId)
    .first<{ count: number }>();

  const sources = await listMicrosoftSources(env.DB, COMPANY_ID, daniel.connectorInstanceId);
  const otherIncludedOneDrives = sources.filter(
    (s) => s.sourceType === "onedrive" && s.id !== daniel.sourceId && s.inclusionStatus === "included",
  );

  return {
    phase: "discover",
    ranAt: new Date().toISOString(),
    sourceId: daniel.sourceId,
    driveId: daniel.driveId,
    displayName: daniel.displayName,
    folderScopeBefore: {
      mode: beforeScope?.folder_scope_mode ?? "unknown",
      includePaths: beforeScope?.folder_include_paths_json
        ? JSON.parse(beforeScope.folder_include_paths_json)
        : [],
    },
    folderScopeAfter: { mode: "all", label: "Entire OneDrive" },
    inventory: {
      totalFolders: inventory.folders,
      totalFiles: inventory.files.length,
      indexable,
      catalogueOnly,
      fileTypes,
      estimatedBytes: totalBytes,
      filesAlreadyIndexed: existingIndexed?.count ?? 0,
    },
    queueConfigured: hasMicrosoftKnowledgeQueue(env),
    queueName: MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
    governance: {
      danielIncluded: true,
      otherOneDrivesIncluded: otherIncludedOneDrives.length,
      defaultPolicy: "available-not-auto-included",
    },
    verdict: "DISCOVERY_COMPLETE",
  };
}

export async function runCmd14FullSync(
  env: Env,
  input?: { sourceId?: string; waitMs?: number },
): Promise<Record<string, unknown>> {
  const daniel = input?.sourceId
    ? {
        sourceId: input.sourceId,
        connectorInstanceId: await ensureConnectorInstance(env.DB),
        driveId: "",
        displayName: DANIEL_SOURCE_HINT,
      }
    : await resolveDanielSource(env);
  if (!daniel) return { phase: "sync", verdict: "STOPPED_NO_DANIEL_SOURCE" };

  const syncResult = await syncMicrosoftSource(env, {
    companyId: COMPANY_ID,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd14-full-sync",
    useDelta: false,
    onJobsEnqueued: (syncRunId) => {
      void (async () => {
        const { kickMicrosoftJobProcessor } = await import("./microsoft-job-processor");
        await kickMicrosoftJobProcessor(env, syncRunId);
      })();
    },
  });

  if (syncResult.queued > 0 && !hasMicrosoftKnowledgeQueue(env)) {
    const { kickMicrosoftJobProcessor } = await import("./microsoft-job-processor");
    await kickMicrosoftJobProcessor(env, syncResult.syncRunId);
  }

  const wait = await waitForMicrosoftSyncRun(env, {
    syncRunId: syncResult.syncRunId,
    sourceId: daniel.sourceId,
    companyId: COMPANY_ID,
    timeoutMs: input?.waitMs ?? 600_000,
  });

  const jobStats = await getMicrosoftSourceJobStats(env.DB, {
    companyId: COMPANY_ID,
    sourceId: daniel.sourceId,
    syncRunId: syncResult.syncRunId,
  });

  const targetFiles = ["LLP Agreement - signed.pdf", "Mizzen - Combined_Financial_Model.xlsx"];
  const fileResults = await env.DB.prepare(
    `SELECT title, path, indexing_status, last_error, knowledge_document_id, visibility_status
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND source_id = ? AND title IN (${targetFiles.map(() => "?").join(",")})`,
  )
    .bind(COMPANY_ID, daniel.sourceId, ...targetFiles)
    .all();

  const llp = (fileResults.results ?? []).find((r) => r.title === targetFiles[0]);
  const mizzen = (fileResults.results ?? []).find((r) => r.title === targetFiles[1]);

  return {
    phase: "sync",
    ranAt: new Date().toISOString(),
    sourceId: daniel.sourceId,
    syncResult,
    queueWait: wait,
    jobStats,
    targetFiles: {
      llpAgreement: {
        title: targetFiles[0],
        status: llp?.indexing_status ?? "not_found",
        indexed: llp?.indexing_status === "indexed",
        knowledgeDocumentId: llp?.knowledge_document_id ?? null,
        lastError: llp?.last_error ?? null,
        path: llp?.path ?? null,
      },
      mizzenXlsx: {
        title: targetFiles[1],
        status: mizzen?.indexing_status ?? "not_found",
        indexed: mizzen?.indexing_status === "indexed",
        knowledgeDocumentId: mizzen?.knowledge_document_id ?? null,
        lastError: mizzen?.last_error ?? null,
        path: mizzen?.path ?? null,
      },
    },
    verdict: wait.completed ? "SYNC_COMPLETE" : "SYNC_TIMEOUT",
  };
}

async function runSearch(env: Env, query: string): Promise<Record<string, unknown>> {
  const mcps = await env.DB.prepare(
    `SELECT id FROM mcp_environments WHERE company_id = ? LIMIT 1`,
  )
    .bind(COMPANY_ID)
    .first<{ id: string }>();
  if (!mcps?.id) return { query, ok: false, error: "No MCP" };

  const result = await executeRegisteredMcpTool(env, {
    mcpId: mcps.id,
    toolName: "search_company_knowledge",
    arguments: { query, limit: 5 },
    actorUserId: "cmd14-acceptance",
    actorEmail: "cmd14-acceptance@system",
    sourceClient: "cmd14-acceptance",
  });

  if (result.status !== 200) {
    return { query, ok: false, error: result.error, status: result.status };
  }

  const data = result.data as Record<string, unknown>;
  const hits =
    (data.results as unknown[]) ??
    (data.matches as unknown[]) ??
    (data.documents as unknown[]) ??
    (data.items as unknown[]) ??
    [];
  return {
    query,
    ok: true,
    hitCount: Array.isArray(hits) ? hits.length : 0,
    topHits: Array.isArray(hits)
      ? hits.slice(0, 3).map((h) => {
          const row = h as Record<string, unknown>;
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          return {
            title: row.title ?? row.documentTitle ?? row.name ?? null,
            topic: row.topic ?? meta.topic ?? null,
            source: row.source ?? meta.source ?? null,
            snippet: String(row.snippet ?? row.text ?? row.excerpt ?? "").slice(0, 120) || null,
          };
        })
      : [],
  };
}

export async function runCmd14SearchAcceptance(env: Env): Promise<Record<string, unknown>> {
  const outsideTestQueries = await env.DB.prepare(
    `SELECT DISTINCT title, path FROM microsoft_knowledge_items
     WHERE company_id = ? AND indexing_status = 'indexed'
       AND path NOT LIKE 'INFRA Knowledge Test%'
     ORDER BY updated_at DESC LIMIT 3`,
  )
    .bind(COMPANY_ID)
    .all<{ title: string; path: string | null }>();

  const queries = [
    ...(outsideTestQueries.results ?? []).map((r) => r.title.replace(/\.[^.]+$/, "")),
    "Coal Search",
    "Company Van Policy",
    "HeatTech Shareholders Agreement",
  ];

  const uniqueQueries = [...new Set(queries.filter(Boolean))];
  const results = [];
  for (const query of uniqueQueries) {
    results.push(await runSearch(env, query));
  }

  return {
    phase: "search",
    ranAt: new Date().toISOString(),
    queries: uniqueQueries,
    results,
    outsideTestFolderQueries: (outsideTestQueries.results ?? []).map((r) => r.title),
    verdict: results.some((r) => r.ok && (r.hitCount as number) > 0) ? "SEARCH_PASS" : "SEARCH_FAIL",
  };
}

export async function runCmd14MicrosoftAcceptance(env: Env): Promise<Record<string, unknown>> {
  const discovery = await runCmd14Discovery(env);
  if (discovery.verdict !== "DISCOVERY_COMPLETE") {
    return { command: "CMD14", discovery, verdict: discovery.verdict };
  }

  const sync = await runCmd14FullSync(env, { sourceId: String(discovery.sourceId) });
  const search = sync.verdict === "SYNC_COMPLETE" ? await runCmd14SearchAcceptance(env) : null;

  const llpOk = (sync.targetFiles as { llpAgreement?: { indexed?: boolean } })?.llpAgreement?.indexed;
  const mizzenOk = (sync.targetFiles as { mizzenXlsx?: { indexed?: boolean } })?.mizzenXlsx?.indexed;
  const searchOk = search?.verdict === "SEARCH_PASS";

  let classification: string;
  if (llpOk && mizzenOk && sync.verdict === "SYNC_COMPLETE" && searchOk) {
    classification = "MICROSOFT KNOWLEDGE SCALE PASS";
  } else if (sync.verdict === "SYNC_COMPLETE") {
    classification = "BETA READY WITH LIMITATIONS";
  } else {
    classification = "FAIL";
  }

  return {
    command: "CMD14",
    discovery,
    sync,
    search,
    classification,
    verdict: classification,
  };
}
