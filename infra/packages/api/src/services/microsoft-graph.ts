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
  sharePointIds?: { siteId?: string; siteUrl?: string; webId?: string };
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
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
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

/** Public Graph app-role names from a JWT. Never returns the raw token. */
export function readGraphAppTokenClaims(accessToken: string): {
  appId: string | null;
  tenantId: string | null;
  roles: string[];
} {
  try {
    const part = accessToken.split(".")[1];
    if (!part) return { appId: null, tenantId: null, roles: [] };
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const roles = Array.isArray(payload.roles) ? payload.roles.map((role) => String(role)).sort() : [];
    const appId =
      typeof payload.appid === "string"
        ? payload.appid
        : typeof payload.azp === "string"
          ? payload.azp
          : null;
    return {
      appId,
      tenantId: typeof payload.tid === "string" ? payload.tid : null,
      roles,
    };
  } catch {
    return { appId: null, tenantId: null, roles: [] };
  }
}

export function hostnameFromSharePointUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host.endsWith(".sharepoint.com")) return null;
    if (host.includes("-my.sharepoint.com") || host.startsWith("my.")) return null;
    return host;
  } catch {
    return null;
  }
}

export async function probeGraphPath(
  config: MicrosoftGraphConfig,
  path: string,
): Promise<{ path: string; ok: boolean; status: number | null; requestId: string | null; error: string | null }> {
  try {
    await graphGet(config, path);
    return { path, ok: true, status: 200, requestId: null, error: null };
  } catch (err) {
    return {
      path,
      ok: false,
      status: err instanceof MicrosoftGraphError ? err.status : null,
      requestId: err instanceof MicrosoftGraphError ? err.requestId : null,
      error: err instanceof Error ? err.message.slice(0, 240) : String(err),
    };
  }
}

export async function graphPost<T>(config: MicrosoftGraphConfig, path: string, body: unknown): Promise<T> {
  return graphRequest(config, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Metadata-only recent drive items. Not a semantic knowledge search. */
export async function searchRecentDriveItems(
  config: MicrosoftGraphConfig,
  input: { top?: number; source?: "onedrive" | "sharepoint" | "all" },
): Promise<GraphDriveItem[]> {
  const size = Math.min(Math.max(input.top ?? 10, 1), 50);
  try {
    const payload = await graphPost<{
      value?: Array<{ hitsContainers?: Array<{ hits?: Array<{ resource?: GraphDriveItem }> }> }>;
    }>(config, "/search/query", {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: "isDocument=true" },
          from: 0,
          size,
          sortProperties: [{ name: "lastModifiedDateTime", isDescending: true }],
        },
      ],
    });
    const items: GraphDriveItem[] = [];
    for (const request of payload.value ?? []) {
      for (const container of request.hitsContainers ?? []) {
        for (const hit of container.hits ?? []) {
          if (hit.resource?.id && hit.resource.name) items.push(hit.resource);
        }
      }
    }
    if (items.length) return items.slice(0, size);
  } catch {
    // App-only /search/query is often unavailable; fall through to drive listing.
  }
  return listRecentDriveItemsFromDrives(config, size, input.source);
}

async function listRecentDriveItemsFromDrives(
  config: MicrosoftGraphConfig,
  size: number,
  source?: "onedrive" | "sharepoint" | "all",
): Promise<GraphDriveItem[]> {
  const drives: GraphDrive[] = [];
  const seen = new Set<string>();
  const add = (drive: GraphDrive | null) => {
    if (!drive?.id || seen.has(drive.id)) return;
    if (source === "onedrive" && drive.driveType && drive.driveType !== "personal" && drive.driveType !== "business") {
      if (!/personal|onedrive/i.test(`${drive.driveType} ${drive.webUrl ?? ""}`)) return;
    }
    if (source === "sharepoint" && /personal|onedrive/i.test(`${drive.driveType ?? ""} ${drive.webUrl ?? ""}`)) return;
    seen.add(drive.id);
    drives.push(drive);
  };
  try {
    for (const drive of await listAllDrives(config)) add(drive);
  } catch {
    /* tenant /drives may be empty for personal-only tenants */
  }
  if (drives.length < 4) {
    try {
      for (const drive of await listUserOneDrives(config, { maxUsers: 4 })) add(drive);
    } catch {
      /* User.Read.All may be missing */
    }
  }
  const items: GraphDriveItem[] = [];
  for (const drive of drives.slice(0, 8)) {
    try {
      const children = await listDriveChildren(config, drive.id);
      for (const child of children) {
        if (!child.folder && child.id && child.name) items.push(child);
      }
    } catch {
      continue;
    }
  }
  return items
    .sort((left, right) => String(right.lastModifiedDateTime ?? "").localeCompare(String(left.lastModifiedDateTime ?? "")))
    .slice(0, size);
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
    "/drives?$select=id,name,driveType,webUrl,owner,createdBy,quota,sharePointIds",
  );
}

function addUniqueSite(sites: GraphSite[], seen: Set<string>, site?: GraphSite | null): void {
  if (!site?.id || seen.has(site.id)) return;
  seen.add(site.id);
  sites.push(site);
}

/**
 * Discover SharePoint sites. `/sites?search=` is often 403 under Sites.Selected;
 * keep going with /sites/root and hostname lookups instead of failing closed.
 */
export async function listSites(
  config: MicrosoftGraphConfig,
  search = "*",
  hostnames: string[] = [],
): Promise<GraphSite[]> {
  const seen = new Set<string>();
  const sites: GraphSite[] = [];

  const queries = [search, "Communication", "Elvex", "Caddington"].filter(
    (query, index, all) => query && all.indexOf(query) === index,
  );

  for (const query of queries) {
    try {
      const batch = await graphGetAll<GraphSite>(
        config,
        `/sites?search=${encodeURIComponent(query)}&$select=id,name,displayName,webUrl`,
        10,
      );
      for (const site of batch) addUniqueSite(sites, seen, site);
    } catch {
      /* Sites.Selected / tenant policy may deny search while root/hostname still work */
    }
  }

  const directPaths = [
    "/sites/root?$select=id,name,displayName,webUrl,siteCollection",
    ...hostnames.flatMap((hostname) => {
      const host = hostname.trim().toLowerCase();
      if (!host) return [];
      return [
        `/sites/${host}?$select=id,name,displayName,webUrl,siteCollection`,
        `/sites/${host}:/?$select=id,name,displayName,webUrl,siteCollection`,
      ];
    }),
  ];

  for (const path of directPaths) {
    try {
      addUniqueSite(sites, seen, await graphGet<GraphSite>(config, path));
    } catch {
      /* try the next well-known path */
    }
  }

  return sites;
}

/** Enumerate tenant users (requires User.Read.All application permission). */
export async function listTenantUsers(
  config: MicrosoftGraphConfig,
): Promise<Array<{ id: string; userPrincipalName: string | null; displayName: string | null; mail: string | null }>> {
  return graphGetAll(
    config,
    `/users?$select=id,userPrincipalName,displayName,mail&$top=100`,
    10,
  );
}

/** Fetch a single user's OneDrive by user ID. */
export async function getUserOneDrive(
  config: MicrosoftGraphConfig,
  userId: string,
): Promise<GraphDrive | null> {
  try {
    const drive = await graphGet<GraphDrive>(
      config,
      `/users/${userId}/drive?$select=id,name,driveType,webUrl,owner,createdBy,quota`,
    );
    return drive?.id ? drive : null;
  } catch {
    return null;
  }
}

/** Enumerate personal OneDrive drives via /users when /drives omits them. */
export async function listUserOneDrives(
  config: MicrosoftGraphConfig,
  options?: { userIds?: string[]; maxUsers?: number },
): Promise<GraphDrive[]> {
  const drives: GraphDrive[] = [];
  if (options?.userIds?.length) {
    for (const userId of options.userIds) {
      const drive = await getUserOneDrive(config, userId);
      if (drive) drives.push(drive);
    }
    return drives;
  }

  let users: Array<{ id: string; userPrincipalName?: string; displayName?: string }> = [];
  try {
    users = await graphGetAll(
      config,
      `/users?$select=id,userPrincipalName,displayName&$top=100`,
      options?.maxUsers ?? 5,
    );
  } catch {
    return drives;
  }

  for (const user of users) {
    const drive = await getUserOneDrive(config, user.id);
    if (drive) {
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

export type GraphSubscription = {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
};

export async function createGraphSubscription(
  config: MicrosoftGraphConfig,
  input: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState: string;
  },
): Promise<GraphSubscription> {
  return graphRequest<GraphSubscription>(config, "/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: input.changeType,
      notificationUrl: input.notificationUrl,
      resource: input.resource,
      expirationDateTime: input.expirationDateTime,
      clientState: input.clientState,
      includeResourceData: false,
    }),
  });
}

export async function renewGraphSubscription(
  config: MicrosoftGraphConfig,
  subscriptionId: string,
  expirationDateTime: string,
): Promise<GraphSubscription> {
  return graphRequest<GraphSubscription>(config, `/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expirationDateTime }),
  });
}

export async function deleteGraphSubscription(
  config: MicrosoftGraphConfig,
  subscriptionId: string,
): Promise<void> {
  await graphRequest<void>(config, `/subscriptions/${subscriptionId}`, { method: "DELETE" });
}

/** Graph PATCH cannot change notificationUrl. Recreate when the webhook host changes. */
export function isGraphSubscriptionConflict(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("subscription limit") ||
    message.includes("quota exceeded") ||
    message.includes("maximum number of subscriptions")
  );
}

/**
 * Create the replacement subscription first so the existing one keeps delivering
 * if Graph rejects the new notification URL. Delete the old id only after create.
 * If Graph refuses a second subscription on the same resource, fall back to
 * delete-then-create.
 */
export async function createReplacingGraphSubscription(
  config: MicrosoftGraphConfig,
  input: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState: string;
  },
  existingGraphSubscriptionId?: string | null,
): Promise<GraphSubscription> {
  try {
    const created = await createGraphSubscription(config, input);
    if (existingGraphSubscriptionId && existingGraphSubscriptionId !== created.id) {
      try {
        await deleteGraphSubscription(config, existingGraphSubscriptionId);
      } catch {
        // Old Graph row may already be gone; D1 now points at the new id.
      }
    }
    return created;
  } catch (err) {
    if (existingGraphSubscriptionId && isGraphSubscriptionConflict(err)) {
      try {
        await deleteGraphSubscription(config, existingGraphSubscriptionId);
      } catch {
        // Continue — create is the recovery path.
      }
      return createGraphSubscription(config, input);
    }
    throw err;
  }
}

export async function ensureDriveFolderByPath(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderPath: string,
): Promise<string> {
  const segments = folderPath.split("/").filter(Boolean);
  let parentId: string | undefined;
  for (const segment of segments) {
    const children = await listDriveChildren(config, driveId, parentId);
    const existing = children.find((c) => c.name === segment && c.folder);
    if (existing?.id) {
      parentId = existing.id;
      continue;
    }
    const created = await graphRequest<GraphDriveItem>(
      config,
      parentId
        ? `/drives/${driveId}/items/${parentId}/children`
        : `/drives/${driveId}/root/children`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: segment,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      },
    );
    parentId = created.id;
  }
  if (!parentId) throw new Error("Failed to resolve folder path");
  return parentId;
}

export async function uploadTextFileToDrive(
  config: MicrosoftGraphConfig,
  driveId: string,
  parentId: string,
  fileName: string,
  content: string,
): Promise<GraphDriveItem> {
  return graphRequest<GraphDriveItem>(
    config,
    `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(fileName)}:/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    },
  );
}

const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export async function uploadBinaryFileToDrive(
  config: MicrosoftGraphConfig,
  driveId: string,
  parentId: string,
  fileName: string,
  bytes: ArrayBuffer,
  contentType?: string | null,
): Promise<GraphDriveItem> {
  const mime = contentType?.trim() || "application/octet-stream";
  if (bytes.byteLength <= SIMPLE_UPLOAD_MAX_BYTES) {
    return graphRequest<GraphDriveItem>(
      config,
      `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(fileName)}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: bytes,
      },
    );
  }

  const session = await graphRequest<{ uploadUrl?: string }>(
    config,
    `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(fileName)}:/createUploadSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: fileName,
        },
      }),
    },
  );
  if (!session.uploadUrl) throw new Error("Graph upload session missing uploadUrl");

  const CHUNK = 5 * 1024 * 1024;
  let offset = 0;
  let last: GraphDriveItem | null = null;
  const view = new Uint8Array(bytes);
  while (offset < view.byteLength) {
    const end = Math.min(offset + CHUNK, view.byteLength);
    const slice = view.subarray(offset, end);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${offset}-${end - 1}/${view.byteLength}`,
      },
      body: slice,
    });
    if (!response.ok && response.status !== 202) {
      const body = await response.text().catch(() => "");
      throw new MicrosoftGraphError(
        `Microsoft Graph upload session error ${response.status}: ${body.slice(0, 300)}`,
        response.status,
      );
    }
    if (response.status === 200 || response.status === 201) {
      last = (await response.json()) as GraphDriveItem;
    }
    offset = end;
  }
  if (!last?.id) throw new Error("Graph upload session completed without an item");
  return last;
}

export async function updateTextFileContent(
  config: MicrosoftGraphConfig,
  driveId: string,
  itemId: string,
  content: string,
): Promise<void> {
  await graphRequest<void>(config, `/drives/${driveId}/items/${itemId}/content`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: content,
  });
}

export async function renameDriveItem(
  config: MicrosoftGraphConfig,
  driveId: string,
  itemId: string,
  newName: string,
): Promise<GraphDriveItem> {
  return graphRequest<GraphDriveItem>(config, `/drives/${driveId}/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export async function deleteDriveItem(
  config: MicrosoftGraphConfig,
  driveId: string,
  itemId: string,
): Promise<void> {
  await graphRequest<void>(config, `/drives/${driveId}/items/${itemId}`, { method: "DELETE" });
}

export async function findDriveItemByPath(
  config: MicrosoftGraphConfig,
  driveId: string,
  itemPath: string,
): Promise<GraphDriveItem | null> {
  try {
    return await graphGet<GraphDriveItem>(
      config,
      `/drives/${driveId}/root:/${itemPath.split("/").map(encodeURIComponent).join("/")}`,
    );
  } catch (err) {
    if (err instanceof MicrosoftGraphError && err.status === 404) return null;
    throw err;
  }
}
