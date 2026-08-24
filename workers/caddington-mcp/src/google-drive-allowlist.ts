/**
 * Google Drive connector file scope — documents only.
 *
 * Personal photos, videos, audio and other media must never be ingested.
 * Filtering uses Drive file metadata (MIME type, name) BEFORE any download.
 * Image ingestion remains available for manual admin uploads only.
 */

export type GoogleDriveFilterDecision =
  | { allowed: true; reason: "allowed_mime" | "allowed_extension" | "allowed_google_apps" | "additional_allowlist" }
  | { allowed: false; reason: GoogleDriveSkipReason };

export type GoogleDriveSkipReason =
  | "folder"
  | "google_photos"
  | "excluded_mime_prefix"
  | "excluded_mime"
  | "excluded_extension"
  | "unknown_mime"
  | "not_on_allowlist";

/** Google Workspace native types included in the initial documents-only sync. */
export const GOOGLE_DRIVE_DEFAULT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/plain",
  "text/markdown",
] as const;

export const GOOGLE_DRIVE_DEFAULT_ALLOWED_GOOGLE_APPS_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
] as const;

/** Never ingest — checked before allow-list. */
export const GOOGLE_DRIVE_EXCLUDED_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
] as const;

export const GOOGLE_DRIVE_EXCLUDED_MIME_TYPES = [
  "application/vnd.google-apps.photo",
  "application/vnd.google-apps.folder",
  "application/vnd.google-apps.shortcut",
  "application/vnd.google-apps.drive-sdk",
  "application/vnd.google-apps.script",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.jam",
  "application/vnd.google-apps.vid",
] as const;

export const GOOGLE_DRIVE_ALLOWED_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".txt",
  ".md",
] as const;

export const GOOGLE_DRIVE_EXCLUDED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
  ".ico",
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".dng",
  ".orf",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".wma",
] as const;

/** Export targets when downloading Google Docs / Sheets / Slides. */
export const GOOGLE_APPS_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface GoogleDriveAllowListConfig {
  /** Base allow-list — documents only. Do not add image/media types here. */
  allowedMimeTypes: string[];
  allowedGoogleAppsTypes: string[];
  /**
   * Deliberate extension point for future file types.
   * Additional MIME types must be added here explicitly (via connector config),
   * never by widening the default lists.
   */
  additionalAllowedMimeTypes: string[];
  excludedMimeTypePrefixes: string[];
  excludedMimeTypes: string[];
}

export interface GoogleDriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  parents?: string[];
}

export const DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG: GoogleDriveAllowListConfig = {
  allowedMimeTypes: [...GOOGLE_DRIVE_DEFAULT_ALLOWED_MIME_TYPES],
  allowedGoogleAppsTypes: [...GOOGLE_DRIVE_DEFAULT_ALLOWED_GOOGLE_APPS_TYPES],
  additionalAllowedMimeTypes: [],
  excludedMimeTypePrefixes: [...GOOGLE_DRIVE_EXCLUDED_MIME_PREFIXES],
  excludedMimeTypes: [...GOOGLE_DRIVE_EXCLUDED_MIME_TYPES],
};

export function parseGoogleDriveAllowListConfig(
  raw: unknown
): GoogleDriveAllowListConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG };
  }

  const value = raw as Record<string, unknown>;
  return {
    allowedMimeTypes: normalizeStringArray(
      value.allowedMimeTypes,
      DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG.allowedMimeTypes
    ),
    allowedGoogleAppsTypes: normalizeStringArray(
      value.allowedGoogleAppsTypes,
      DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG.allowedGoogleAppsTypes
    ),
    additionalAllowedMimeTypes: normalizeStringArray(
      value.additionalAllowedMimeTypes,
      []
    ),
    excludedMimeTypePrefixes: normalizeStringArray(
      value.excludedMimeTypePrefixes,
      DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG.excludedMimeTypePrefixes
    ),
    excludedMimeTypes: normalizeStringArray(
      value.excludedMimeTypes,
      DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG.excludedMimeTypes
    ),
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isGooglePhotosMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    lower === "application/vnd.google-apps.photo" ||
    lower.includes("google-apps.photo")
  );
}

export function classifyGoogleDriveFile(
  file: Pick<GoogleDriveFileMetadata, "name" | "mimeType">,
  config: GoogleDriveAllowListConfig = DEFAULT_GOOGLE_DRIVE_ALLOWLIST_CONFIG
): GoogleDriveFilterDecision {
  const mimeType = file.mimeType.toLowerCase().split(";")[0].trim();
  const extension = fileExtension(file.name);

  if (mimeType === "application/vnd.google-apps.folder") {
    return { allowed: false, reason: "folder" };
  }

  if (isGooglePhotosMime(mimeType)) {
    return { allowed: false, reason: "google_photos" };
  }

  for (const prefix of config.excludedMimeTypePrefixes) {
    if (mimeType.startsWith(prefix)) {
      return { allowed: false, reason: "excluded_mime_prefix" };
    }
  }

  if (config.excludedMimeTypes.includes(mimeType)) {
    return { allowed: false, reason: "excluded_mime" };
  }

  if (GOOGLE_DRIVE_EXCLUDED_EXTENSIONS.includes(extension as (typeof GOOGLE_DRIVE_EXCLUDED_EXTENSIONS)[number])) {
    return { allowed: false, reason: "excluded_extension" };
  }

  if (config.allowedGoogleAppsTypes.includes(mimeType)) {
    return { allowed: true, reason: "allowed_google_apps" };
  }

  if (config.allowedMimeTypes.includes(mimeType)) {
    return { allowed: true, reason: "allowed_mime" };
  }

  if (config.additionalAllowedMimeTypes.includes(mimeType)) {
    return { allowed: true, reason: "additional_allowlist" };
  }

  if (
    mimeType === "application/octet-stream" &&
    GOOGLE_DRIVE_ALLOWED_EXTENSIONS.includes(
      extension as (typeof GOOGLE_DRIVE_ALLOWED_EXTENSIONS)[number]
    )
  ) {
    return { allowed: true, reason: "allowed_extension" };
  }

  if (mimeType === "application/octet-stream" && extension) {
    return { allowed: false, reason: "excluded_extension" };
  }

  return { allowed: false, reason: "not_on_allowlist" };
}

export function isGoogleDriveFileAllowed(
  file: Pick<GoogleDriveFileMetadata, "name" | "mimeType">,
  config?: GoogleDriveAllowListConfig
): boolean {
  return classifyGoogleDriveFile(file, config).allowed;
}

/** Drive list query — metadata only; never targets Google Photos API. */
export function buildGoogleDriveListQuery(): string {
  return "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
}

export function resolveGoogleDriveDownloadMime(
  sourceMimeType: string
): { downloadMimeType: string; exportRequired: boolean } {
  const mimeType = sourceMimeType.toLowerCase();
  const exportMime = GOOGLE_APPS_EXPORT_MIME[mimeType];
  if (exportMime) {
    return { downloadMimeType: exportMime, exportRequired: true };
  }
  return { downloadMimeType: mimeType, exportRequired: false };
}

export function suggestedStoredFilename(
  originalName: string,
  sourceMimeType: string,
  downloadMimeType: string
): string {
  const base = originalName.replace(/[/\\?%*:|"<>]/g, "_");
  if (!GOOGLE_APPS_EXPORT_MIME[sourceMimeType.toLowerCase()]) {
    return base;
  }

  const extensionByMime: Record<string, string> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ".pptx",
    "text/plain": ".txt",
    "text/csv": ".csv",
  };

  const ext = extensionByMime[downloadMimeType.toLowerCase()] ?? "";
  if (!ext || base.toLowerCase().endsWith(ext)) {
    return base.endsWith(ext) ? base : `${base}${ext}`;
  }
  const stripped = base.replace(/\.[^.]+$/, "");
  return `${stripped}${ext}`;
}
