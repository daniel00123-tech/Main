import type { Env } from "./db";
import {
  GOOGLE_DRIVE_CRON_EXPRESSION,
  describeGoogleDriveScheduleHandling,
  loadGoogleDriveScheduleConfig,
  type GoogleDriveScheduleConfig,
} from "./google-drive-schedule";
import {
  GOOGLE_DRIVE_OAUTH_SCOPES,
  GoogleDriveClient,
  parseGoogleDriveCredentials,
  type GoogleDriveListedFile,
} from "./google-drive-client";
import {
  GOOGLE_DRIVE_KNOWLEDGE_FOLDER_NAME,
  parseGoogleDriveAllowListConfig,
  suggestedStoredFilename,
  type GoogleDriveAllowListConfig,
  type GoogleDriveSkipReason,
} from "./google-drive-allowlist";
import { indexKnowledgeDocument } from "./knowledge";
import { buildUploadMetadata } from "./knowledge-metadata";
import { log } from "./logger";

export interface GoogleDriveSyncOptions {
  dryRun?: boolean;
  maxFiles?: number;
  autoIndex?: boolean;
  trigger?: "manual" | "scheduled";
}

export interface GoogleDriveSyncSummary {
  dryRun: boolean;
  trigger: "manual" | "scheduled";
  listed: number;
  allowed: number;
  skipped: number;
  queued: number;
  imported: number;
  updated: number;
  failed: number;
  skipReasons: Partial<Record<GoogleDriveSkipReason, number>>;
  queueReasons: Partial<Record<DriveFileQueueReason, number>>;
  errors: string[];
}

export type DriveFileQueueReason = "new" | "modified" | "retry_sync" | "retry_index";

export interface DriveFileQueueDecision {
  action: "queue" | "skip";
  queueReason?: DriveFileQueueReason;
  skipReason?: GoogleDriveSkipReason;
}

export interface GoogleDriveFileQueueMessage {
  driveFileId: string;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  md5Checksum?: string | null;
  trigger: "manual" | "scheduled";
  autoIndex: boolean;
}

export interface GoogleDriveScanSummary {
  dryRun: boolean;
  trigger: "manual" | "scheduled";
  listed: number;
  allowed: number;
  skipped: number;
  queued: number;
  unchanged: number;
  skipReasons: Partial<Record<GoogleDriveSkipReason, number>>;
  queueReasons: Partial<Record<DriveFileQueueReason, number>>;
  errors: string[];
  batchId: number | null;
}

const CONNECTOR_CODE = "google_drive";

export interface GoogleDriveConnectorConfig {
  syncMode: "documents_only";
  writeOperationsEnabled: false;
  googlePhotosConnected: false;
  knowledgeFolderName: string;
  knowledgeFolderId: string | null;
  allowList: GoogleDriveAllowListConfig;
  schedule: GoogleDriveScheduleConfig;
}

interface DriveFileExistingState {
  knowledge_document_id: number | null;
  md5_checksum: string | null;
  modified_time: string | null;
  sync_status: string;
  document_status: string | null;
}

async function loadConnectorConfigJson(
  env: Env
): Promise<Record<string, unknown>> {
  const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT config_json FROM connector_config WHERE connector_code = ?"
  )
    .bind(CONNECTOR_CODE)
    .first<{ config_json: string | null }>();

  if (!row?.config_json) {
    return {};
  }

  try {
    return JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function loadGoogleDriveConnectorConfig(
  env: Env
): Promise<GoogleDriveConnectorConfig> {
  const parsed = await loadConnectorConfigJson(env);
  const knowledgeFolderId =
    env.GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID?.trim() ||
    (typeof parsed.knowledgeFolderId === "string" && parsed.knowledgeFolderId.trim()
      ? parsed.knowledgeFolderId.trim()
      : null);

  return {
    syncMode: "documents_only",
    writeOperationsEnabled: false,
    googlePhotosConnected: false,
    knowledgeFolderName:
      typeof parsed.knowledgeFolderName === "string" &&
      parsed.knowledgeFolderName.trim()
        ? parsed.knowledgeFolderName.trim()
        : GOOGLE_DRIVE_KNOWLEDGE_FOLDER_NAME,
    knowledgeFolderId,
    allowList: parseGoogleDriveAllowListConfig(parsed.allowList ?? parsed),
    schedule: await loadGoogleDriveScheduleConfig(env),
  };
}

export async function loadGoogleDriveAllowListConfig(
  env: Env
): Promise<GoogleDriveAllowListConfig> {
  const config = await loadGoogleDriveConnectorConfig(env);
  return config.allowList;
}

export function classifyDriveFileForSync(
  file: GoogleDriveListedFile,
  existing: DriveFileExistingState | null
): DriveFileQueueDecision {
  if (!file.filterDecision.allowed) {
    return { action: "skip", skipReason: file.filterDecision.reason };
  }

  if (existing?.sync_status === "failed") {
    return { action: "queue", queueReason: "retry_sync" };
  }

  if (
    existing?.knowledge_document_id &&
    existing.document_status &&
    existing.document_status !== "indexed"
  ) {
    return { action: "queue", queueReason: "retry_index" };
  }

  if (!existing?.knowledge_document_id) {
    return { action: "queue", queueReason: "new" };
  }

  if (
    file.md5Checksum &&
    existing.md5_checksum &&
    existing.md5_checksum === file.md5Checksum &&
    existing.document_status === "indexed"
  ) {
    return { action: "skip" };
  }

  if (
    !file.md5Checksum &&
    file.modifiedTime &&
    existing.modified_time === file.modifiedTime &&
    existing.document_status === "indexed"
  ) {
    return { action: "skip" };
  }

  if (file.md5Checksum && existing.md5_checksum !== file.md5Checksum) {
    return { action: "queue", queueReason: "modified" };
  }

  if (file.modifiedTime && existing.modified_time !== file.modifiedTime) {
    return { action: "queue", queueReason: "modified" };
  }

  if (existing.knowledge_document_id && existing.document_status === "indexed") {
    return { action: "skip" };
  }

  return { action: "queue", queueReason: "new" };
}

async function loadDriveFileStates(
  env: Env,
  driveFileIds: string[]
): Promise<Map<string, DriveFileExistingState>> {
  const states = new Map<string, DriveFileExistingState>();
  if (driveFileIds.length === 0) {
    return states;
  }

  const chunkSize = 50;
  for (let i = 0; i < driveFileIds.length; i += chunkSize) {
    const chunk = driveFileIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.CADDINGTON_BUSINESS_DATA.prepare(
      `SELECT gfs.drive_file_id, gfs.knowledge_document_id, gfs.md5_checksum,
              gfs.modified_time, gfs.sync_status, kd.status AS document_status
       FROM google_drive_files gfs
       LEFT JOIN knowledge_documents kd ON kd.id = gfs.knowledge_document_id
       WHERE gfs.drive_file_id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{
        drive_file_id: string;
        knowledge_document_id: number | null;
        md5_checksum: string | null;
        modified_time: string | null;
        sync_status: string;
        document_status: string | null;
      }>();

    for (const row of rows.results) {
      states.set(row.drive_file_id, {
        knowledge_document_id: row.knowledge_document_id,
        md5_checksum: row.md5_checksum,
        modified_time: row.modified_time,
        sync_status: row.sync_status,
        document_status: row.document_status,
      });
    }
  }

  return states;
}

export async function getGoogleDriveConnectorStatus(env: Env): Promise<{
  connector: string;
  credentialsConfigured: boolean;
  credentialsSecretPresent: boolean;
  knowledgeFolderConfigured: boolean;
  oauthScopes: readonly string[];
  googlePhotosConnected: false;
  syncMode: "documents_only";
  writeOperationsEnabled: false;
  knowledgeFolderName: string;
  knowledgeFolderId: string | null;
  allowList: GoogleDriveAllowListConfig;
  schedule: GoogleDriveScheduleConfig & {
    cronExpression: string;
    scheduleHandling: string;
  };
  notes: string;
}> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  const connectorConfig = await loadGoogleDriveConnectorConfig(env);

  return {
    connector: CONNECTOR_CODE,
    credentialsConfigured: credentials !== null,
    credentialsSecretPresent: Boolean(env.GOOGLE_DRIVE_CREDENTIALS?.trim()),
    knowledgeFolderConfigured: connectorConfig.knowledgeFolderId !== null,
    oauthScopes: GOOGLE_DRIVE_OAUTH_SCOPES,
    googlePhotosConnected: false,
    syncMode: "documents_only",
    writeOperationsEnabled: false,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    allowList: connectorConfig.allowList,
    schedule: {
      ...connectorConfig.schedule,
      cronExpression: GOOGLE_DRIVE_CRON_EXPRESSION,
      scheduleHandling: describeGoogleDriveScheduleHandling(),
    },
    notes:
      "Documents-only sync restricted to the Caddington Knowledge folder and its subfolders. Daily metadata scan at 12:00 Europe/London with queue fan-out for per-file import/index. Personal photos, images, videos and audio are excluded via MIME allow-list before download. Google Photos is not connected. Drive OAuth uses full drive scope for future folder writes; sync remains read-only. Image ingestion is manual-upload only.",
  };
}

export async function previewGoogleDriveKnowledgeFolder(env: Env): Promise<{
  knowledgeFolderId: string;
  knowledgeFolderName: string;
  rootChildren: Array<{ id: string; name: string; mimeType: string }>;
  subfolderInventories: Array<{
    folderId: string;
    folderName: string;
    childCount: number;
    children: Array<{ id: string; name: string; mimeType: string; allowed: boolean; reason: string }>;
  }>;
  recursiveFileCount: number;
  recursiveAllowedCount: number;
  recursiveSkippedCount: number;
  skipReasons: Partial<Record<GoogleDriveSkipReason, number>>;
}> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  if (!credentials) {
    throw new Error("GOOGLE_DRIVE_CREDENTIALS is not configured.");
  }

  const connectorConfig = await loadGoogleDriveConnectorConfig(env);
  if (!connectorConfig.knowledgeFolderId) {
    throw new Error("Google Drive knowledge folder is not configured.");
  }

  const client = new GoogleDriveClient(credentials);
  const rootPage = await client.listFolderChildrenPage(
    connectorConfig.knowledgeFolderId
  );
  const rootChildren = rootPage.files.map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
  }));

  const subfolders = rootPage.files.filter(
    (file) => file.mimeType === "application/vnd.google-apps.folder"
  );

  const subfolderInventories = [];
  for (const folder of subfolders) {
    const page = await client.listFolderChildrenPage(folder.id);
    const children = client.classifyFiles(page.files, connectorConfig.allowList).map(
      (file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        allowed: file.filterDecision.allowed,
        reason: file.filterDecision.allowed
          ? file.filterDecision.reason
          : file.filterDecision.reason,
      })
    );
    subfolderInventories.push({
      folderId: folder.id,
      folderName: folder.name,
      childCount: page.files.length,
      children,
    });
  }

  const recursive = client.classifyFiles(
    await client.listAllFilesInFolder(connectorConfig.knowledgeFolderId),
    connectorConfig.allowList
  );
  const skipReasons: Partial<Record<GoogleDriveSkipReason, number>> = {};
  for (const file of recursive) {
    if (!file.filterDecision.allowed) {
      const reason = file.filterDecision.reason;
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    }
  }

  return {
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
    rootChildren,
    subfolderInventories,
    recursiveFileCount: recursive.length,
    recursiveAllowedCount: recursive.filter((f) => f.filterDecision.allowed).length,
    recursiveSkippedCount: recursive.filter((f) => !f.filterDecision.allowed).length,
    skipReasons,
  };
}

export async function scanAndQueueGoogleDriveChanges(
  env: Env,
  options: GoogleDriveSyncOptions = {}
): Promise<GoogleDriveScanSummary> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  if (!credentials) {
    throw new Error(
      "GOOGLE_DRIVE_CREDENTIALS is not configured. Provide OAuth client_id, client_secret and refresh_token."
    );
  }

  const connectorConfig = await loadGoogleDriveConnectorConfig(env);
  if (!connectorConfig.knowledgeFolderId) {
    throw new Error(
      `Google Drive knowledge folder is not configured. Set GOOGLE_DRIVE_KNOWLEDGE_FOLDER_ID or connector_config.knowledgeFolderId for "${connectorConfig.knowledgeFolderName}".`
    );
  }

  const trigger = options.trigger ?? "manual";
  const dryRun = options.dryRun ?? false;
  const autoIndex = options.autoIndex !== false;
  const client = new GoogleDriveClient(credentials);
  const summary: GoogleDriveScanSummary = {
    dryRun,
    trigger,
    listed: 0,
    allowed: 0,
    skipped: 0,
    queued: 0,
    unchanged: 0,
    skipReasons: {},
    queueReasons: {},
    errors: [],
    batchId: null,
  };

  const importBatch = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO import_log (source_system, import_type, status, metadata)
     VALUES (?, 'google_drive_sync', 'started', ?)`
  )
    .bind(
      CONNECTOR_CODE,
      JSON.stringify({
        dryRun,
        trigger,
        maxFiles: options.maxFiles ?? null,
        autoIndex,
        knowledgeFolderId: connectorConfig.knowledgeFolderId,
        knowledgeFolderName: connectorConfig.knowledgeFolderName,
        phase: "metadata_scan",
      })
    )
    .run();

  summary.batchId = Number(importBatch.meta.last_row_id);

  try {
    const listed = await client.listAllFilesInFolder(
      connectorConfig.knowledgeFolderId
    );
    summary.listed = listed.length;

    const classified = client.classifyFiles(listed, connectorConfig.allowList);
    const allowedFiles = classified.filter((file) => file.filterDecision.allowed);
    summary.allowed = allowedFiles.length;
    summary.skipped = classified.length - allowedFiles.length;

    const existingStates = await loadDriveFileStates(
      env,
      allowedFiles.map((file) => file.id)
    );

    for (const file of classified) {
      if (!file.filterDecision.allowed) {
        const reason = file.filterDecision.reason;
        summary.skipReasons[reason] = (summary.skipReasons[reason] ?? 0) + 1;
        if (!dryRun) {
          await recordDriveFileState(env, file, "skipped", reason);
        }
        continue;
      }

      const decision = classifyDriveFileForSync(
        file,
        existingStates.get(file.id) ?? null
      );

      if (decision.action === "skip") {
        summary.unchanged++;
        if (!dryRun) {
          await recordDriveFileState(env, file, "imported");
        }
        continue;
      }

      const queueReason = decision.queueReason ?? "new";
      summary.queueReasons[queueReason] = (summary.queueReasons[queueReason] ?? 0) + 1;

      if (dryRun) {
        summary.queued++;
        continue;
      }

      const message: GoogleDriveFileQueueMessage = {
        driveFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime ?? null,
        md5Checksum: file.md5Checksum ?? null,
        trigger,
        autoIndex,
      };

      if (env.GOOGLE_DRIVE_SYNC_QUEUE) {
        await env.GOOGLE_DRIVE_SYNC_QUEUE.send(message);
        summary.queued++;
      } else {
        summary.errors.push(
          "GOOGLE_DRIVE_SYNC_QUEUE is not configured; inline processing is used only via syncGoogleDriveDocuments."
        );
      }
    }

    const maxFiles = options.maxFiles;
    if (maxFiles !== undefined && summary.queued > maxFiles) {
      summary.errors.push(
        `Queued ${summary.queued} files exceeds maxFiles=${maxFiles}; queue messages were still sent for all eligible changes.`
      );
    }

    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE import_log
       SET status = 'completed', completed_at = datetime('now'),
           records_processed = ?, records_failed = ?, metadata = ?
       WHERE id = ?`
    )
      .bind(summary.queued, summary.errors.length, JSON.stringify(summary), summary.batchId)
      .run();

    log("info", "google_drive_scan_completed", summary);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE import_log
       SET status = 'failed', completed_at = datetime('now'), error_message = ?
       WHERE id = ?`
    )
      .bind(message, summary.batchId)
      .run();
    throw error;
  }
}

export async function processGoogleDriveFileMessage(
  env: Env,
  message: GoogleDriveFileQueueMessage
): Promise<{ action: "imported" | "updated"; documentId: number }> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  if (!credentials) {
    throw new Error("GOOGLE_DRIVE_CREDENTIALS is not configured.");
  }

  if (!env.CADDINGTON_KNOWLEDGE) {
    throw new Error("R2 bucket is not configured on this deployment.");
  }

  const connectorConfig = await loadGoogleDriveConnectorConfig(env);
  if (!connectorConfig.knowledgeFolderId) {
    throw new Error("Google Drive knowledge folder is not configured.");
  }

  const client = new GoogleDriveClient(credentials);
  const existingStates = await loadDriveFileStates(env, [message.driveFileId]);
  const existing = existingStates.get(message.driveFileId) ?? null;

  const metadata = await client.getFileMetadata(message.driveFileId);
  if (!metadata) {
    throw new Error(
      `Drive file ${message.driveFileId} is no longer present in Google Drive.`
    );
  }

  const [file] = client.classifyFiles([metadata], connectorConfig.allowList);

  if (!file.filterDecision.allowed) {
    await recordDriveFileState(env, file, "skipped", file.filterDecision.reason);
    throw new Error(
      `Drive file ${file.name} is no longer allow-listed (${file.filterDecision.reason}).`
    );
  }

  const decision = classifyDriveFileForSync(file, existing);
  if (decision.action === "skip") {
    await recordDriveFileState(env, file, "imported");
    const documentId = existing?.knowledge_document_id;
    if (!documentId) {
      throw new Error(`Drive file ${file.name} was unchanged but has no knowledge document.`);
    }
    return { action: "updated", documentId };
  }

  const download = await client.downloadAllowedFile(file);
  const storedName = suggestedStoredFilename(
    file.name,
    file.mimeType,
    download.mimeType
  );
  const externalId = `gdrive-${file.id}`;
  const r2Key = `connectors/google_drive/${externalId}/${storedName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  await env.CADDINGTON_KNOWLEDGE.put(r2Key, download.bytes, {
    httpMetadata: { contentType: download.mimeType },
    customMetadata: {
      external_id: externalId,
      drive_file_id: file.id,
      source: "google_drive",
    },
  });

  const uploadMetadata = buildUploadMetadata(storedName, {
    source: "google_drive",
    category: "document",
  });

  const documentMetadata = {
    ...uploadMetadata,
    connector: CONNECTOR_CODE,
    driveFileId: file.id,
    driveMimeType: file.mimeType,
    driveModifiedTime: file.modifiedTime ?? null,
    exportRequired: download.exportRequired,
    syncMode: "documents_only",
    knowledgeFolderId: connectorConfig.knowledgeFolderId,
    knowledgeFolderName: connectorConfig.knowledgeFolderName,
  };

  let documentId = existing?.knowledge_document_id ?? null;
  let action: "imported" | "updated" = "imported";

  if (documentId) {
    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE knowledge_documents
       SET title = ?, r2_key = ?, mime_type = ?, byte_size = ?, status = 'pending',
           metadata = ?, updated_at = datetime('now'), indexed_at = NULL
       WHERE id = ?`
    )
      .bind(
        file.name,
        r2Key,
        download.mimeType,
        download.bytes.byteLength,
        JSON.stringify(documentMetadata),
        documentId
      )
      .run();
    action = "updated";
  } else {
    const insert = await env.CADDINGTON_BUSINESS_DATA.prepare(
      `INSERT INTO knowledge_documents (external_id, title, r2_key, mime_type, byte_size, status, metadata)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(
        externalId,
        file.name,
        r2Key,
        download.mimeType,
        download.bytes.byteLength,
        JSON.stringify(documentMetadata)
      )
      .run();
    documentId = Number(insert.meta.last_row_id);
    action = "imported";
  }

  await recordDriveFileState(env, file, "imported", undefined, {
    knowledgeDocumentId: documentId,
    md5Checksum: file.md5Checksum ?? null,
  });

  if (message.autoIndex && documentId) {
    await indexKnowledgeDocument(env, documentId);
  }

  log("info", "google_drive_file_processed", {
    driveFileId: file.id,
    documentId,
    action,
    trigger: message.trigger,
  });

  return { action, documentId };
}

export async function syncGoogleDriveDocuments(
  env: Env,
  options: GoogleDriveSyncOptions = {}
): Promise<GoogleDriveSyncSummary> {
  const scan = await scanAndQueueGoogleDriveChanges(env, options);
  const summary: GoogleDriveSyncSummary = {
    dryRun: scan.dryRun,
    trigger: scan.trigger,
    listed: scan.listed,
    allowed: scan.allowed,
    skipped: scan.skipped,
    queued: scan.queued,
    imported: 0,
    updated: 0,
    failed: 0,
    skipReasons: scan.skipReasons,
    queueReasons: scan.queueReasons,
    errors: [...scan.errors],
  };

  if (scan.dryRun || scan.queued === 0) {
    return summary;
  }

  if (env.GOOGLE_DRIVE_SYNC_QUEUE) {
    return summary;
  }

  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  if (!credentials) {
    throw new Error("GOOGLE_DRIVE_CREDENTIALS is not configured.");
  }

  const connectorConfig = await loadGoogleDriveConnectorConfig(env);
  const client = new GoogleDriveClient(credentials);
  const files = client.classifyFiles(
    await client.listAllFilesInFolder(connectorConfig.knowledgeFolderId!),
    connectorConfig.allowList
  );
  const existingStates = await loadDriveFileStates(
    env,
    files.map((file) => file.id)
  );

  const autoIndex = options.autoIndex !== false;
  const toProcess = files.filter((file) => {
    const decision = classifyDriveFileForSync(
      file,
      existingStates.get(file.id) ?? null
    );
    return decision.action === "queue";
  });

  const maxFiles = options.maxFiles ?? toProcess.length;
  for (const file of toProcess.slice(0, maxFiles)) {
    try {
      const result = await processGoogleDriveFileMessage(env, {
        driveFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime ?? null,
        md5Checksum: file.md5Checksum ?? null,
        trigger: options.trigger ?? "manual",
        autoIndex,
      });
      if (result.action === "imported") {
        summary.imported++;
      } else {
        summary.updated++;
      }
    } catch (error) {
      summary.failed++;
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`${file.name}: ${message}`);
      await recordDriveFileState(env, file, "failed", undefined, {
        errorMessage: message,
      });
    }
  }

  return summary;
}

async function recordDriveFileState(
  env: Env,
  file: GoogleDriveListedFile,
  syncStatus: "skipped" | "imported" | "failed",
  skipReason?: GoogleDriveSkipReason,
  extras?: {
    knowledgeDocumentId?: number | null;
    md5Checksum?: string | null;
    errorMessage?: string;
  }
): Promise<void> {
  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO google_drive_files (
       drive_file_id, name, mime_type, modified_time, md5_checksum,
       sync_status, skip_reason, knowledge_document_id, last_synced_at, metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(drive_file_id) DO UPDATE SET
       name = excluded.name,
       mime_type = excluded.mime_type,
       modified_time = excluded.modified_time,
       md5_checksum = COALESCE(excluded.md5_checksum, google_drive_files.md5_checksum),
       sync_status = excluded.sync_status,
       skip_reason = excluded.skip_reason,
       knowledge_document_id = COALESCE(excluded.knowledge_document_id, google_drive_files.knowledge_document_id),
       last_synced_at = excluded.last_synced_at,
       metadata = excluded.metadata`
  )
    .bind(
      file.id,
      file.name,
      file.mimeType,
      file.modifiedTime ?? null,
      extras?.md5Checksum ?? file.md5Checksum ?? null,
      syncStatus,
      skipReason ?? null,
      extras?.knowledgeDocumentId ?? null,
      JSON.stringify({
        filterDecision: file.filterDecision,
        errorMessage: extras?.errorMessage ?? null,
      })
    )
    .run();
}

export async function runScheduledGoogleDriveScan(env: Env): Promise<GoogleDriveScanSummary> {
  return scanAndQueueGoogleDriveChanges(env, {
    trigger: "scheduled",
    autoIndex: true,
    dryRun: false,
  });
}
