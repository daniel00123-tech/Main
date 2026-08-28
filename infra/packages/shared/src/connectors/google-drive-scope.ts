/** Per-company Google Drive knowledge ingestion scope (Caddington MCP connector_config). */

export type GoogleDriveScopeMode = "ENTIRE_DRIVE" | "SELECTED_FOLDERS";

export type GoogleDriveImageIngestionPolicy = "EXCLUDED" | "ALLOWED";

export type GoogleDriveScopeConfig = {
  scopeMode: GoogleDriveScopeMode;
  imageIngestionPolicy: GoogleDriveImageIngestionPolicy;
  /** Selected folder id when scopeMode = SELECTED_FOLDERS */
  knowledgeFolderId?: string | null;
  knowledgeFolderName?: string | null;
};

export function parseGoogleDriveScopeMode(value: unknown): GoogleDriveScopeMode {
  return value === "ENTIRE_DRIVE" ? "ENTIRE_DRIVE" : "SELECTED_FOLDERS";
}

export function parseGoogleDriveImagePolicy(value: unknown): GoogleDriveImageIngestionPolicy {
  return value === "ALLOWED" ? "ALLOWED" : "EXCLUDED";
}

export function resolveGoogleDriveScanRootId(config: GoogleDriveScopeConfig): string | null {
  if (config.scopeMode === "ENTIRE_DRIVE") return "root";
  return config.knowledgeFolderId?.trim() || null;
}
