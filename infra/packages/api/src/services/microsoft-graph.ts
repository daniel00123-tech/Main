/**
 * Microsoft Graph API client — read-only, app-only compatible.
 * Never log access tokens.
 */

import type { MicrosoftKnowledgeProvenance, MicrosoftSourceType } from "@infra/shared";

export type MicrosoftGraphConfig = {
  accessToken: string;
  tenantId: string;
};

export type GraphDrive = {
  id: string;
  name: string;
  driveType: string;
  webUrl: string | null;
  owner?: {
    user?: { id?: string; displayName?: string; email?: string };
  };
  createdBy?: { user?: { displayName?: string; email?: string } };
  quota?: { used?: number; total?: number };
};

export type GraphSite = {
  id: string;
  name: string;
  webUrl: string | null;
  displayName: string | null;
  hostname?: string;
  siteCollection?: { hostname?: string; root?: { webUrl?: string } };
};

export type GraphDriveItem = {
  id: string;
  name: string;
  webUrl: string | null;
  size: number | null;
  mimeType?: string | null;
  lastModifiedDateTime: string | null;
  createdDateTime?: string | null;
  eTag?: string | null;
  cTag?: string | null;
  folder?: { childCount: number } | null;
  file?: { mimeType: string; hashes?: { sha1Hash?: string } } | null;
  parentReference?: { driveId?: string; path?: string; id?: string };
  deleted?: { state?: string } | null;
};

export type GraphMailMessage = {
  id: string;
  subject: string | null;
  from: { emailAddress?: { address?: string; name?: string } } | null;
  receivedDateTime: string | null;
  conversationId: string | null;
  bodyPreview: string | null;
  hasAttachments: boolean;
};

export type GraphPage<T> = {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

export class MicrosoftGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "MicrosoftGraphError";
  }
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function graphRequest<T>(
  config: MicrosoftGraphConfig,
  path: string,
  init?: RequestInit,
  attempt = 0,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const requestId = response.headers.get("request-id") ?? response.headers.get("client-request-id");

  if (response.status === 429 && attempt < 4) {
    const retryAfterMs = parseRetryAfterMs(response) ?? 2000 * (attempt + 1);
    await new Promise((r) => setTimeout(r, retryAfterMs));
    return graphRequest(config, path, init, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new MicrosoftGraphError(
      `Microsoft Graph error ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      parseRetryAfterMs(response),
      requestId,
    );
  }

  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

export async function graphGet<T>(config: MicrosoftGraphConfig, path: string): Promise<T> {
  return graphRequest(config, path, { method: "GET" });
}

export async function graphGetAll<T>(
  config: MicrosoftGraphConfig,
  path: string,
  maxPages = 50,
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path;
  let pages = 0;
  while (next && pages < maxPages) {
    const page: GraphPage<T> = await graphGet<GraphPage<T>>(config, next);
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"];
    pages++;
  }
  return items;
}

export async function probeMicrosoftGraph(config: MicrosoftGraphConfig): Promise<{
  ok: boolean;
  driveCount: number;
  siteCount: number;
  message: string;
}> {
  try {
    const drives = await graphGet<GraphPage<GraphDrive>>(config, "/drives?$top=1");
    const sites = await graphGet<GraphPage<GraphSite>>(
      config,
      "/sites?search=*&$select=id,displayName,webUrl&$top=1",
    );
    return {
      ok: true,
      driveCount: drives.value?.length ?? 0,
      siteCount: sites.value?.length ?? 0,
      message: "Microsoft Graph app-only connectivity verified.",
    };
  } catch (err) {
    return {
      ok: false,
      driveCount: 0,
      siteCount: 0,
      message: err instanceof Error ? err.message : "Graph probe failed",
    };
  }
}

/** Discover all drives accessible to the application (OneDrive + document libraries). */
export async function listAllDrives(config: MicrosoftGraphConfig): Promise<GraphDrive[]> {
  return graphGetAll<GraphDrive>(
    config,
    "/drives?$select=id,name,driveType,webUrl,owner,createdBy,quota",
  );
}

export async function listSites(config: MicrosoftGraphConfig, search = "*"): Promise<GraphSite[]> {
  const seen = new Set<string>();
  const sites: GraphSite[] = [];

  const queries = [
    search,
    "Communication",
    "Caddington",
  ].filter((q, i, arr) => arr.indexOf(q) === i);

  for (const query of queries) {
    const batch = await graphGetAll<GraphSite>(
      config,
      `/sites?search=${encodeURIComponent(query)}&$select=id,name,displayName,webUrl`,
      10,
    );
    for (const site of batch) {
      if (!seen.has(site.id)) {
        seen.add(site.id);
        sites.push(site);
      }
    }
  }

  try {
    const root = await graphGet<GraphSite>(config, "/sites/root?$select=id,name,displayName,webUrl");
    if (root?.id && !seen.has(root.id)) {
      seen.add(root.id);
      sites.push(root);
    }
  } catch {
    /* root site may be unavailable */
  }

  return sites;
}

/** Enumerate personal OneDrive drives via /users when /drives omits them. */
export async function listUserOneDrives(config: MicrosoftGraphConfig): Promise<GraphDrive[]> {
  const drives: GraphDrive[] = [];
  let users: Array<{ id: string; userPrincipalName?: string; displayName?: string }> = [];
  try {
    users = await graphGetAll(
      config,
      `/users?$select=id,userPrincipalName,displayName&$top=100`,
      5,
    );
  } catch {
    return drives;
  }

  for (const user of users) {
    try {
      const drive = await graphGet<GraphDrive>(
        config,
        `/users/${user.id}/drive?$select=id,name,driveType,webUrl,owner,createdBy,quota`,
      );
      if (drive?.id) {
        drives.push({
          ...drive,
          owner: drive.owner ?? {
            user: {
              id: user.id,
              email: user.userPrincipalName,
              displayName: user.displayName,
            },
          },
        });
      }
    } catch {
      /* user may not have OneDrive provisioned */
    }
  }
  return drives;
}

export async function listSiteDrives(
  config: MicrosoftGraphConfig,
  siteId: string,
): Promise<GraphDrive[]> {
  return graphGetAll<GraphDrive>(
    config,
    `/sites/${siteId}/drives?$select=id,name,driveType,webUrl,owner,createdBy`,
  );
}

export async function listDriveChildren(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderId?: string,
): Promise<GraphDriveItem[]> {
  const path = folderId
    ? `/drives/${driveId}/items/${folderId}/children?$select=id,name,webUrl,size,lastModifiedDateTime,createdDateTime,eTag,cTag,folder,file,parentReference`
    : `/drives/${driveId}/root/children?$select=id,name,webUrl,size,lastModifiedDateTime,createdDateTime,eTag,cTag,folder,file,parentReference`;
  return graphGetAll<GraphDriveItem>(config, path);
}

export async function listDriveDelta(
  config: MicrosoftGraphConfig,
  driveId: string,
  deltaLink?: string | null,
): Promise<{ items: GraphDriveItem[]; deltaLink: string | null }> {
  const path = deltaLink ?? `/drives/${driveId}/root/delta?$select=id,name,webUrl,size,lastModifiedDateTime,eTag,cTag,folder,file,parentReference,deleted`;
  const page = await graphGet<GraphPage<GraphDriveItem>>(config, path);
  return {
    items: page.value ?? [],
    deltaLink: page["@odata.deltaLink"] ?? page["@odata.nextLink"] ?? null,
  };
}

export async function downloadDriveItemContent(
  config: MicrosoftGraphConfig,
  driveId: string,
  itemId: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string | null; contentLength: number }> {
  const meta = await graphGet<{ file?: { mimeType?: string }; size?: number }>(
    config,
    `/drives/${driveId}/items/${itemId}?$select=file,size`,
  );
  const response = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  if (!response.ok) {
    throw new MicrosoftGraphError(
      `Download failed: HTTP ${response.status}`,
      response.status,
    );
  }
  const bytes = await response.arrayBuffer();
  return {
    bytes,
    mimeType: meta.file?.mimeType ?? response.headers.get("content-type"),
    contentLength: bytes.byteLength,
  };
}

export async function listSharedMailboxMessages(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  folder = "inbox",
  top = 25,
): Promise<GraphMailMessage[]> {
  const path = `/users/${encodeURIComponent(mailboxAddress)}/mailFolders/${folder}/messages?$top=${top}&$orderby=receivedDateTime desc`;
  const body = await graphGet<GraphPage<GraphMailMessage>>(config, path);
  return body.value ?? [];
}

export function buildMicrosoftProvenance(input: {
  companyId: string;
  tenantId: string | null;
  sourceType: MicrosoftSourceType;
  externalItemId: string;
  path: string | null;
  filename: string | null;
  subject?: string | null;
  modifiedAt: string | null;
  driveId?: string | null;
  siteId?: string | null;
  mailboxAddress?: string | null;
  webUrl?: string | null;
  inclusionStatus: "included" | "excluded" | "available";
}): MicrosoftKnowledgeProvenance {
  return {
    connector: "microsoft_365",
    sourceType: input.sourceType,
    companyId: input.companyId,
    tenantId: input.tenantId,
    driveId: input.driveId ?? null,
    siteId: input.siteId ?? null,
    mailboxAddress: input.mailboxAddress ?? null,
    path: input.path,
    filename: input.filename,
    subject: input.subject ?? null,
    externalItemId: input.externalItemId,
    modifiedAt: input.modifiedAt,
    scope: input.inclusionStatus,
  };
}

/** MIME types eligible for text extraction via company MCP indexer. */
export const MICROSOFT_INDEXABLE_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/csv",
]);

export const MICROSOFT_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function classifyMicrosoftFile(mimeType: string | null, filename: string): {
  indexingStatus: "indexable" | "catalogue_only" | "unsupported";
  reason: string;
} {
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : "";
  const mime = (mimeType ?? "").toLowerCase();

  if (MICROSOFT_INDEXABLE_MIMES.has(mime) || ["pdf", "docx", "xlsx", "pptx", "txt", "csv", "md"].includes(ext ?? "")) {
    return { indexingStatus: "indexable", reason: "Supported document format" };
  }
  if (MICROSOFT_IMAGE_MIMES.has(mime) || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext ?? "")) {
    return { indexingStatus: "catalogue_only", reason: "Image discovered — text indexing not supported yet" };
  }
  return { indexingStatus: "unsupported", reason: "Unsupported format for text indexing" };
}

export function formatMicrosoftSourceLabel(input: {
  sourceType: MicrosoftSourceType;
  displayName: string;
  path?: string | null;
  filename?: string | null;
}): string {
  const component =
    input.sourceType === "onedrive"
      ? "OneDrive"
      : input.sourceType === "sharepoint"
        ? "SharePoint"
        : "Outlook Shared Mailbox";
  const parts = ["Microsoft 365", component, input.displayName];
  if (input.path) parts.push(input.path);
  if (input.filename) parts.push(input.filename);
  return parts.filter(Boolean).join(" → ");
}
