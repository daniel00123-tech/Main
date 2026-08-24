import type { Env } from "./db";
import {
  GoogleDriveClient,
  parseGoogleDriveCredentials,
  type GoogleDriveListedFile,
} from "./google-drive-client";
import {
  DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG,
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
}

export interface GoogleDriveSyncSummary {
  dryRun: boolean;
  listed: number;
  allowed: number;
  skipped: number;
  imported: number;
  updated: number;
  failed: number;
  skipReasons: Partial<Record<GoogleDriveSkipReason, number>>;
  errors: string[];
}

const CONNECTOR_CODE = "google_drive";

export async function loadGoogleDriveAllowListConfig(
  env: Env
): Promise<GoogleDriveAllowListConfig> {
  const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT config_json FROM connector_config WHERE connector_code = ?"
  )
    .bind(CONNECTOR_CODE)
    .first<{ config_json: string | null }>();

  if (!row?.config_json) {
    return { ...DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG };
  }

  try {
    const parsed = JSON.parse(row.config_json) as { allowList?: unknown };
    return parseGoogleDriveAllowListConfig(parsed.allowList ?? parsed);
  } catch {
    return { ...DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG };
  }
}

export async function getGoogleDriveConnectorStatus(env: Env): Promise<{
  connector: string;
  credentialsConfigured: boolean;
  oauthScopes: readonly string[];
  googlePhotosConnected: false;
  syncMode: "documents_only";
  allowList: GoogleDriveAllowListConfig;
  notes: string;
}> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  const allowList = await loadGoogleDriveAllowListConfig(env);

  return {
    connector: CONNECTOR_CODE,
    credentialsConfigured: credentials !== null,
    oauthScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    googlePhotosConnected: false,
    syncMode: "documents_only",
    allowList,
    notes:
      "Documents-only sync. Personal photos, images, videos and audio are excluded via MIME allow-list before download. Google Photos is not connected. Image ingestion is manual-upload only.",
  };
}

export async function syncGoogleDriveDocuments(
  env: Env,
  options: GoogleDriveSyncOptions = {}
): Promise<GoogleDriveSyncSummary> {
  const credentials = parseGoogleDriveCredentials(env.GOOGLE_DRIVE_CREDENTIALS);
  if (!credentials) {
    throw new Error(
      "GOOGLE_DRIVE_CREDENTIALS is not configured. Provide OAuth client_id, client_secret and refresh_token."
    );
  }

  if (!env.CADDINGTON_KNOWLEDGE) {
    throw new Error("R2 bucket is not configured on this deployment.");
  }

  const allowList = await loadGoogleDriveAllowListConfig(env);
  const client = new GoogleDriveClient(credentials);
  const summary: GoogleDriveSyncSummary = {
    dryRun: options.dryRun ?? false,
    listed: 0,
    allowed: 0,
    skipped: 0,
    imported: 0,
    updated: 0,
    failed: 0,
    skipReasons: {},
    errors: [],
  };

  const importBatch = await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO import_log (source_system, import_type, status, metadata)
     VALUES (?, 'google_drive_sync', 'started', ?)`
  )
    .bind(
      CONNECTOR_CODE,
      JSON.stringify({
        dryRun: summary.dryRun,
        maxFiles: options.maxFiles ?? null,
        autoIndex: options.autoIndex ?? true,
      })
    )
    .run();

  const batchId = importBatch.meta.last_row_id;

  try {
    const listed = await client.listAllFiles();
    summary.listed = listed.length;

    const classified = client.classifyFiles(listed, allowList);
    const allowedFiles = classified.filter((file) => file.filterDecision.allowed);
    summary.allowed = allowedFiles.length;
    summary.skipped = classified.length - allowedFiles.length;

    for (const file of classified) {
      if (!file.filterDecision.allowed) {
        const reason = file.filterDecision.reason;
        summary.skipReasons[reason] = (summary.skipReasons[reason] ?? 0) + 1;
        if (!summary.dryRun) {
          await recordDriveFileState(env, file, "skipped", reason);
        }
      }
    }

    const toProcess = allowedFiles.slice(0, options.maxFiles ?? allowedFiles.length);

    for (const file of toProcess) {
      try {
        if (summary.dryRun) {
          continue;
        }

        const existing = await env.CADDINGTON_BUSINESS_DATA.prepare(
          `SELECT gfs.knowledge_document_id, gfs.md5_checksum, kd.status
           FROM google_drive_files gfs
           LEFT JOIN knowledge_documents kd ON kd.id = gfs.knowledge_document_id
           WHERE gfs.drive_file_id = ?`
        )
          .bind(file.id)
          .first<{
            knowledge_document_id: number | null;
            md5_checksum: string | null;
            status: string | null;
          }>();

        if (
          existing?.knowledge_document_id &&
          file.md5Checksum &&
          existing.md5_checksum === file.md5Checksum
        ) {
          await recordDriveFileState(env, file, "imported");
          continue;
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

        const metadata = {
          ...uploadMetadata,
          connector: CONNECTOR_CODE,
          driveFileId: file.id,
          driveMimeType: file.mimeType,
          driveModifiedTime: file.modifiedTime ?? null,
          exportRequired: download.exportRequired,
          syncMode: "documents_only",
        };

        let documentId = existing?.knowledge_document_id ?? null;

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
              JSON.stringify(metadata),
              documentId
            )
            .run();
          summary.updated++;
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
              JSON.stringify(metadata)
            )
            .run();
          documentId = Number(insert.meta.last_row_id);
          summary.imported++;
        }

        await recordDriveFileState(env, file, "imported", undefined, {
          knowledgeDocumentId: documentId,
          md5Checksum: file.md5Checksum ?? null,
        });

        if (options.autoIndex !== false && documentId) {
          try {
            await indexKnowledgeDocument(env, documentId);
          } catch (indexError) {
            const message =
              indexError instanceof Error ? indexError.message : String(indexError);
            summary.errors.push(`Index failed for ${file.name}: ${message}`);
          }
        }
      } catch (error) {
        summary.failed++;
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`${file.name}: ${message}`);
        if (!summary.dryRun) {
          await recordDriveFileState(env, file, "failed", undefined, {
            errorMessage: message,
          });
        }
      }
    }

    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE import_log
       SET status = 'completed', completed_at = datetime('now'),
           records_processed = ?, records_failed = ?, metadata = ?
       WHERE id = ?`
    )
      .bind(
        summary.imported + summary.updated,
        summary.failed,
        JSON.stringify(summary),
        batchId
      )
      .run();

    log("info", "google_drive_sync_completed", summary);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.CADDINGTON_BUSINESS_DATA.prepare(
      `UPDATE import_log
       SET status = 'failed', completed_at = datetime('now'), error_message = ?
       WHERE id = ?`
    )
      .bind(message, batchId)
      .run();
    throw error;
  }
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
