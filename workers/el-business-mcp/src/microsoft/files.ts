import type { ElMicrosoftConfig } from "./config";
import type { GraphClient } from "./graph";
import type { AccessPolicy } from "./policy";
import { listUsers, type DirectoryUser } from "./directory";
import { buildGraphKeywordQuery } from "./query-tokens";

export type FileSourceType = "sharepoint" | "onedrive";

export type FileHit = {
  id: string;
  name: string;
  webUrl: string | null;
  size: number | null;
  mimeType: string | null;
  lastModifiedDateTime: string | null;
  folder: boolean;
  sourceType: FileSourceType;
  driveId: string | null;
  siteId: string | null;
  owner: {
    id: string | null;
    displayName: string | null;
    mail: string | null;
  };
  path: string | null;
  provenance: string;
};

export type DriveInfo = {
  id: string;
  name: string | null;
  driveType: string | null;
  webUrl: string | null;
  owner: { id: string | null; displayName: string | null; mail: string | null };
  sourceType: FileSourceType;
  siteId?: string | null;
};

type GraphDrive = {
  id: string;
  name?: string;
  driveType?: string;
  webUrl?: string;
  owner?: { user?: { id?: string; displayName?: string; email?: string } };
};

type GraphItem = {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number } | null;
  file?: { mimeType?: string } | null;
  parentReference?: { driveId?: string; path?: string; siteId?: string };
  createdBy?: { user?: { id?: string; displayName?: string; email?: string } };
  lastModifiedBy?: { user?: { id?: string; displayName?: string; email?: string } };
};

type GraphSite = {
  id: string;
  displayName?: string | null;
  name?: string | null;
  webUrl?: string | null;
};

function ownerFrom(raw?: { user?: { id?: string; displayName?: string; email?: string } }): {
  id: string | null;
  displayName: string | null;
  mail: string | null;
} {
  return {
    id: raw?.user?.id ?? null,
    displayName: raw?.user?.displayName ?? null,
    mail: raw?.user?.email ?? null,
  };
}

function sourceTypeFromDrive(driveType: string | null | undefined): FileSourceType {
  return driveType === "documentLibrary" ? "sharepoint" : "onedrive";
}

export function isIndexableOwner(
  policy: AccessPolicy,
  owner: FileHit["owner"],
  driveId?: string | null,
  webUrl?: string | null,
  path?: string | null
): boolean {
  if (policy.isProtectedDrive(driveId)) return false;
  if (policy.isProtectedUser(owner)) return false;
  if (policy.isProtectedLocation(webUrl, path)) return false;
  return true;
}

function toHit(
  item: GraphItem,
  sourceType: FileSourceType,
  siteId: string | null,
  fallbackOwner: FileHit["owner"]
): FileHit | null {
  const owner = ownerFrom(item.createdBy);
  const lastOwner = ownerFrom(item.lastModifiedBy);
  const resolvedOwner = {
    id: owner.id ?? lastOwner.id ?? fallbackOwner.id,
    displayName: owner.displayName ?? lastOwner.displayName ?? fallbackOwner.displayName,
    mail: owner.mail ?? lastOwner.mail ?? fallbackOwner.mail,
  };
  const driveId = item.parentReference?.driveId ?? null;
  const path = item.parentReference?.path ?? null;
  return {
    id: item.id,
    name: item.name ?? item.id,
    webUrl: item.webUrl ?? null,
    size: item.size ?? null,
    mimeType: item.file?.mimeType ?? null,
    lastModifiedDateTime: item.lastModifiedDateTime ?? null,
    folder: Boolean(item.folder),
    sourceType,
    driveId,
    siteId,
    owner: resolvedOwner,
    path,
    provenance: [
      "Microsoft 365",
      sourceType === "sharepoint" ? "SharePoint" : "OneDrive",
      resolvedOwner.displayName ?? resolvedOwner.mail ?? "unknown owner",
      path,
      item.name,
    ]
      .filter(Boolean)
      .join(" → "),
  };
}

function allowHit(policy: AccessPolicy, hit: FileHit): boolean {
  return isIndexableOwner(policy, hit.owner, hit.driveId, hit.webUrl, hit.path);
}

export async function discoverSharePointSite(
  graph: GraphClient,
  config: ElMicrosoftConfig
): Promise<GraphSite | null> {
  const hostname = config.sharePointHostname;
  const candidates = [
    `/sites/${hostname}`,
    `/sites/${hostname}:/`,
    `/sites/${hostname}:/sites/root`,
  ];
  for (const path of candidates) {
    try {
      const site = await graph.get<GraphSite>(`${path}?$select=id,displayName,name,webUrl`);
      if (site.id) return site;
    } catch {
      /* try next */
    }
  }
  try {
    const page = await graph.get<{ value?: GraphSite[] }>(
      `/sites?search=${encodeURIComponent(hostname)}&$select=id,displayName,name,webUrl&$top=10`
    );
    return page.value?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function discoverTeamSites(graph: GraphClient): Promise<GraphSite[]> {
  const page = await graph.get<{
    value?: Array<{ id: string; displayName?: string; resourceProvisioningOptions?: string[] }>;
  }>("/groups?$select=id,displayName,groupTypes,resourceProvisioningOptions&$top=50");
  const sites: GraphSite[] = [];
  const seen = new Set<string>();
  for (const group of page.value ?? []) {
    try {
      const site = await graph.get<GraphSite>(
        `/groups/${group.id}/sites/root?$select=id,displayName,name,webUrl`
      );
      if (site.id && !seen.has(site.id)) {
        seen.add(site.id);
        sites.push(site);
      }
    } catch {
      /* group has no site or Sites.Selected blocks it */
    }
  }
  return sites;
}

export async function listSiteDrives(graph: GraphClient, siteId: string): Promise<DriveInfo[]> {
  const drives = await graph.getAll<GraphDrive>(
    `/sites/${siteId}/drives?$select=id,name,driveType,webUrl,owner`,
    5
  );
  return drives.map((drive) => ({
    id: drive.id,
    name: drive.name ?? null,
    driveType: drive.driveType ?? null,
    webUrl: drive.webUrl ?? null,
    owner: ownerFrom(drive.owner),
    sourceType: "sharepoint",
    siteId,
  }));
}

export { allowHit, graphSearchDriveItems };

export async function listEligibleOneDrives(
  graph: GraphClient,
  policy: AccessPolicy
): Promise<{ eligible: DriveInfo[]; excluded: Array<{ user: DirectoryUser; reason: string }> }> {
  const users = await listUsers(graph);
  const eligible: DriveInfo[] = [];
  const excluded: Array<{ user: DirectoryUser; reason: string }> = [];

  for (const user of users.slice(0, 30)) {
    if (policy.isProtectedUser(user)) {
      excluded.push({ user, reason: "protected_user" });
      continue;
    }
    try {
      const drive = await graph.get<GraphDrive>(
        `/users/${user.id}/drive?$select=id,name,driveType,webUrl,owner`
      );
      if (!drive.id) continue;
      if (policy.isProtectedDrive(drive.id)) {
        excluded.push({ user, reason: "protected_drive" });
        continue;
      }
      eligible.push({
        id: drive.id,
        name: drive.name ?? user.displayName,
        driveType: drive.driveType ?? "business",
        webUrl: drive.webUrl ?? null,
        owner: {
          id: user.id,
          displayName: user.displayName,
          mail: user.mail ?? user.userPrincipalName,
        },
        sourceType: "onedrive",
      });
    } catch {
      /* user may not have a provisioned OneDrive */
    }
  }
  return { eligible, excluded };
}

async function graphSearchDriveItems(
  graph: GraphClient,
  query: string,
  policy: AccessPolicy
): Promise<{ hits: FileHit[]; error?: string; region?: string }> {
  for (const region of ["GBR"]) {
    try {
      const payload = await graph.post<{
        value?: Array<{
          hitsContainers?: Array<{
            hits?: Array<{
              resource?: GraphItem & {
                remoteItem?: { id?: string };
                parentReference?: GraphItem["parentReference"];
              };
            }>;
          }>;
        }>;
      }>("/search/query", {
        requests: [
          {
            entityTypes: ["driveItem"],
            query: { queryString: buildGraphKeywordQuery(query) },
            from: 0,
            size: 25,
            region,
          },
        ],
      });
      const hits: FileHit[] = [];
      for (const container of payload.value ?? []) {
        for (const hit of container.hitsContainers ?? []) {
          for (const row of hit.hits ?? []) {
            const item = row.resource;
            if (!item?.id) continue;
            if (item.webUrl?.includes("aka.ms/")) continue;
            const sourceType: FileSourceType = item.webUrl?.includes("-my.sharepoint.com")
              ? "onedrive"
              : "sharepoint";
            const mapped = toHit(
              { ...item, name: item.name ?? item.id },
              sourceType,
              item.parentReference?.siteId ?? null,
              ownerFrom(item.createdBy)
            );
            if (mapped && allowHit(policy, mapped) && !mapped.folder) hits.push(mapped);
          }
        }
      }
      return { hits, region };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (region === "EUR") return { hits: [], error: message };
    }
  }
  return { hits: [] };
}

export async function searchFiles(
  graph: GraphClient,
  config: ElMicrosoftConfig,
  policy: AccessPolicy,
  input: { query: string; filename?: string; source?: "sharepoint" | "onedrive" | "all"; top?: number }
): Promise<{
  results: FileHit[];
  sharePointSite: GraphSite | null;
  sharePointDriveCount: number;
  eligibleOneDriveCount: number;
  excludedProtectedCount: number;
}> {
  const query = (input.filename || input.query || "").trim();
  const source = input.source ?? "all";
  const results: FileHit[] = [];
  let excludedProtectedCount = 0;

  const site = source === "onedrive" ? null : await discoverSharePointSite(graph, config);
  const sharePointDrives = site ? await listSiteDrives(graph, site.id) : [];
  const oneDrives =
    source === "sharepoint" ? { eligible: [] as DriveInfo[], excluded: [] } : await listEligibleOneDrives(graph, policy);
  excludedProtectedCount = oneDrives.excluded.length;

  const drives: DriveInfo[] = [
    ...(source === "onedrive" ? [] : sharePointDrives),
    ...(source === "sharepoint" ? [] : oneDrives.eligible),
  ];

  if (query) {
    const graphHits = await graphSearchDriveItems(graph, query, policy);
    results.push(...graphHits.hits);
  } else {
    for (const drive of drives.slice(0, 8)) {
      try {
        const page = await graph.get<{ value?: GraphItem[] }>(
          `/drives/${drive.id}/root/children?$top=10&$select=id,name,webUrl,size,lastModifiedDateTime,folder,file,parentReference,createdBy,lastModifiedBy`
        );
        for (const item of page.value ?? []) {
          const hit = toHit(item, drive.sourceType, site?.id ?? null, drive.owner);
          if (!hit) continue;
          if (!allowHit(policy, hit)) {
            excludedProtectedCount += 1;
            continue;
          }
          results.push(hit);
        }
      } catch {
        /* skip inaccessible drive */
      }
    }
  }

  const unique = new Map<string, FileHit>();
  for (const hit of results) {
    unique.set(`${hit.driveId}:${hit.id}`, hit);
  }
  if (unique.size === 0) {
    for (const drive of sharePointDrives.slice(0, 8)) {
      try {
        const page = await graph.get<{ value?: GraphItem[] }>(
          `/drives/${drive.id}/root/children?$top=15&$select=id,name,webUrl,size,lastModifiedDateTime,folder,file,parentReference,createdBy,lastModifiedBy`
        );
        for (const item of page.value ?? []) {
          const hit = toHit(item, "sharepoint", site?.id ?? null, drive.owner);
          if (hit && allowHit(policy, hit)) unique.set(`${hit.driveId}:${hit.id}`, hit);
        }
      } catch {
        /* Sites.Selected may not include this library yet */
      }
    }
  }

  return {
    results: [...unique.values()].slice(0, input.top ?? 20),
    sharePointSite: site,
    sharePointDriveCount: sharePointDrives.length,
    eligibleOneDriveCount: oneDrives.eligible.length,
    excludedProtectedCount,
  };
}

export async function getFile(
  graph: GraphClient,
  policy: AccessPolicy,
  input: { driveId: string; itemId: string; includeContent?: boolean }
): Promise<FileHit & { contentBase64?: string; contentType?: string | null; truncated?: boolean }> {
  const drive = await graph.get<GraphDrive>(`/drives/${input.driveId}?$select=id,name,driveType,webUrl,owner`);
  const owner = ownerFrom(drive.owner);
  policy.assertDriveAllowed(input.driveId, owner);

  const item = await graph.get<GraphItem>(
    `/drives/${input.driveId}/items/${encodeURIComponent(input.itemId)}?$select=id,name,webUrl,size,lastModifiedDateTime,folder,file,parentReference,createdBy,lastModifiedBy`
  );
  const hit = toHit(item, sourceTypeFromDrive(drive.driveType), null, owner);
  if (!hit || !allowHit(policy, hit)) {
    policy.assertDriveAllowed(input.driveId, hit?.owner ?? owner);
  }

  const payload: FileHit & { contentBase64?: string; contentType?: string | null; truncated?: boolean } = hit!;
  if (input.includeContent && !payload.folder) {
    const maxBytes = 750_000;
    if ((payload.size ?? 0) > maxBytes) {
      payload.truncated = true;
    } else {
      const downloaded = await graph.getBytes(
        `/drives/${input.driveId}/items/${encodeURIComponent(input.itemId)}/content`
      );
      const bytes = new Uint8Array(downloaded.bytes);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      payload.contentBase64 = btoa(binary);
      payload.contentType = downloaded.contentType;
    }
  }
  return payload;
}

export async function listFolder(
  graph: GraphClient,
  policy: AccessPolicy,
  input: { driveId: string; itemId?: string }
): Promise<FileHit[]> {
  const drive = await graph.get<GraphDrive>(`/drives/${input.driveId}?$select=id,name,driveType,webUrl,owner`);
  const owner = ownerFrom(drive.owner);
  policy.assertDriveAllowed(input.driveId, owner);
  const path = input.itemId
    ? `/drives/${input.driveId}/items/${encodeURIComponent(input.itemId)}/children`
    : `/drives/${input.driveId}/root/children`;
  const page = await graph.get<{ value?: GraphItem[] }>(
    `${path}?$top=40&$select=id,name,webUrl,size,lastModifiedDateTime,folder,file,parentReference,createdBy,lastModifiedBy`
  );
  return (page.value ?? [])
    .map((item) => toHit(item, sourceTypeFromDrive(drive.driveType), null, owner))
    .filter((hit): hit is FileHit => Boolean(hit && allowHit(policy, hit)));
}
