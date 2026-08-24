import {
  buildGoogleDriveFolderChildrenQuery,
  classifyGoogleDriveFile,
  type GoogleDriveAllowListConfig,
  type GoogleDriveFileMetadata,
  resolveGoogleDriveDownloadMime,
} from "./google-drive-allowlist";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Full Drive scope (read/write). Sync remains read-only today; write access is
 * reserved for future updates to the Caddington Knowledge folder only.
 * Google Photos API is never used.
 */
export const GOOGLE_DRIVE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive",
] as const;

const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleDriveCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export interface GoogleDriveListResult {
  files: GoogleDriveFileMetadata[];
  nextPageToken?: string;
}

export interface GoogleDriveListedFile extends GoogleDriveFileMetadata {
  filterDecision: ReturnType<typeof classifyGoogleDriveFile>;
}

export interface GoogleDriveDownloadResult {
  bytes: ArrayBuffer;
  mimeType: string;
  exportRequired: boolean;
}

export function parseGoogleDriveCredentials(raw: string | undefined): GoogleDriveCredentials | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleDriveCredentials>;
    if (
      typeof parsed.client_id === "string" &&
      typeof parsed.client_secret === "string" &&
      typeof parsed.refresh_token === "string"
    ) {
      return {
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
        refresh_token: parsed.refresh_token,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class GoogleDriveClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;

  constructor(private readonly credentials: GoogleDriveCredentials) {}

  /**
   * Lists non-folder files under a root folder and all nested subfolders.
   * Does not traverse or sync anything outside this folder tree.
   */
  async listAllFilesInFolder(
    rootFolderId: string,
    pageSize = 100
  ): Promise<GoogleDriveFileMetadata[]> {
    const files: GoogleDriveFileMetadata[] = [];
    const folderQueue = [rootFolderId];
    const visitedFolders = new Set<string>();

    while (folderQueue.length > 0) {
      const folderId = folderQueue.shift();
      if (!folderId || visitedFolders.has(folderId)) {
        continue;
      }
      visitedFolders.add(folderId);

      let pageToken: string | undefined;
      do {
        const page = await this.listFolderChildrenPage(folderId, pageSize, pageToken);
        for (const item of page.files) {
          if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
            folderQueue.push(item.id);
          } else {
            files.push(item);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }

    return files;
  }

  async listFolderChildrenPage(
    folderId: string,
    pageSize = 100,
    pageToken?: string
  ): Promise<GoogleDriveListResult> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({
      q: buildGoogleDriveFolderChildrenQuery(folderId),
      pageSize: String(pageSize),
      fields:
        "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Drive list failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as {
      files?: GoogleDriveFileMetadata[];
      nextPageToken?: string;
    };

    return {
      files: payload.files ?? [],
      nextPageToken: payload.nextPageToken,
    };
  }

  classifyFiles(
    files: GoogleDriveFileMetadata[],
    config: GoogleDriveAllowListConfig
  ): GoogleDriveListedFile[] {
    return files.map((file) => ({
      ...file,
      filterDecision: classifyGoogleDriveFile(file, config),
    }));
  }

  async downloadAllowedFile(
    file: GoogleDriveFileMetadata
  ): Promise<GoogleDriveDownloadResult> {
    const { downloadMimeType, exportRequired } = resolveGoogleDriveDownloadMime(
      file.mimeType
    );
    const token = await this.getAccessToken();

    const url = exportRequired
      ? `${DRIVE_FILES_URL}/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(downloadMimeType)}`
      : `${DRIVE_FILES_URL}/${encodeURIComponent(file.id)}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google Drive download failed for ${file.id} (${response.status}): ${body}`
      );
    }

    return {
      bytes: await response.arrayBuffer(),
      mimeType: downloadMimeType,
      exportRequired,
    };
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.client_id,
        client_secret: this.credentials.client_secret,
        refresh_token: this.credentials.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!payload.access_token) {
      throw new Error("Google OAuth token refresh returned no access_token.");
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = now + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
