import type { AccessPolicy } from "./policy";
import type { GraphClient } from "./graph";
import type { DriveInfo, FileHit, FileSourceType } from "./files";
import {
  isIndexableOwner,
  listEligibleOneDrives,
  listSiteDrives,
  discoverSharePointSite,
  discoverTeamSites,
} from "./files";
import type { ElMicrosoftConfig } from "./config";
import { searchTokens } from "./query-tokens";

const MAX_ITEMS_PER_DRIVE = 400;
const MAX_DRIVES = 12;
const STALE_MS = 15 * 60 * 1000;

export type CatalogueRow = {
  source_type: FileSourceType;
  source_id: string | null;
  drive_id: string;
  item_id: string;
  owner_id: string | null;
  owner_upn: string | null;
  owner_name: string | null;
  web_url: string | null;
  filename: string | null;
  path: string | null;
  mime_type: string | null;
  size: number | null;
  modified_at: string | null;
  search_text: string | null;
  status: string;
};

type GraphItem = {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number } | null;
  file?: { mimeType?: string } | null;
  deleted?: { state?: string } | null;
  parentReference?: { driveId?: string; path?: string; siteId?: string };
  createdBy?: { user?: { id?: string; displayName?: string; email?: string } };
  lastModifiedBy?: { user?: { id?: string; displayName?: string; email?: string } };
};

function ownerOf(item: GraphItem, fallback: DriveInfo["owner"]): FileHit["owner"] {
  const created = item.createdBy?.user;
  const modified = item.lastModifiedBy?.user;
  return {
    id: created?.id ?? modified?.id ?? fallback.id,
    displayName: created?.displayName ?? modified?.displayName ?? fallback.displayName,
    mail: created?.email ?? modified?.email ?? fallback.mail,
  };
}

function searchText(input: {
  filename?: string | null;
  path?: string | null;
  ownerName?: string | null;
  ownerMail?: string | null;
  mime?: string | null;
}): string {
  return [input.filename, input.path, input.ownerName, input.ownerMail, input.mime]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function toRow(item: GraphItem, drive: DriveInfo, siteId: string | null): CatalogueRow | null {
  if (!item.id || item.folder || item.deleted) return null;
  const owner = ownerOf(item, drive.owner);
  const path = item.parentReference?.path ?? null;
  return {
    source_type: drive.sourceType,
    source_id: siteId ?? item.parentReference?.siteId ?? null,
    drive_id: item.parentReference?.driveId ?? drive.id,
    item_id: item.id,
    owner_id: owner.id,
    owner_upn: owner.mail,
    owner_name: owner.displayName,
    web_url: item.webUrl ?? null,
    filename: item.name ?? null,
    path,
    mime_type: item.file?.mimeType ?? null,
    size: item.size ?? null,
    modified_at: item.lastModifiedDateTime ?? null,
    search_text: searchText({
      filename: item.name,
      path,
      ownerName: owner.displayName,
      ownerMail: owner.mail,
      mime: item.file?.mimeType,
    }),
    status: "catalogue",
  };
}

export async function upsertCatalogueRow(
  db: D1Database,
  policy: AccessPolicy,
  row: CatalogueRow
): Promise<"catalogue" | "excluded_protected" | "deleted"> {
  const owner = { id: row.owner_id, mail: row.owner_upn, displayName: row.owner_name };
  const allowed = isIndexableOwner(policy, owner, row.drive_id, row.web_url, row.path);
  const status = allowed ? "catalogue" : "excluded_protected";
  await db
    .prepare(
      `INSERT INTO microsoft_index_items
        (source_type, source_id, drive_id, item_id, owner_id, owner_upn, owner_name, web_url, filename, path, mime_type, size, modified_at, search_text, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(drive_id, item_id) DO UPDATE SET
         source_type = excluded.source_type,
         source_id = excluded.source_id,
         owner_id = excluded.owner_id,
         owner_upn = excluded.owner_upn,
         owner_name = excluded.owner_name,
         web_url = excluded.web_url,
         filename = excluded.filename,
         path = excluded.path,
         mime_type = excluded.mime_type,
         size = excluded.size,
         modified_at = excluded.modified_at,
         search_text = excluded.search_text,
         status = excluded.status,
         updated_at = datetime('now')`
    )
    .bind(
      row.source_type,
      row.source_id,
      row.drive_id,
      row.item_id,
      row.owner_id,
      row.owner_upn,
      row.owner_name,
      row.web_url,
      row.filename,
      row.path,
      row.mime_type,
      row.size,
      row.modified_at,
      row.search_text,
      status
    )
    .run();
  return status;
}

export async function markDeleted(db: D1Database, driveId: string, itemId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE microsoft_index_items SET status = 'deleted', updated_at = datetime('now')
       WHERE drive_id = ? AND item_id = ?`
    )
    .bind(driveId, itemId)
    .run();
}

export async function purgeProtectedFromCatalogue(db: D1Database, policy: AccessPolicy): Promise<number> {
  const snap = policy.snapshot();
  let changed = 0;
  for (const user of snap.protectedUsers) {
    const byOwner = await db
      .prepare(
        `UPDATE microsoft_index_items SET status = 'excluded_protected', updated_at = datetime('now')
         WHERE status != 'excluded_protected' AND (owner_id = ? OR lower(owner_upn) = lower(?))`
      )
      .bind(user.id, user.mail ?? user.userPrincipalName)
      .run();
    changed += byOwner.meta.changes ?? 0;
    if (user.driveId) {
      const byDrive = await db
        .prepare(
          `UPDATE microsoft_index_items SET status = 'excluded_protected', updated_at = datetime('now')
           WHERE drive_id = ? AND status != 'excluded_protected'`
        )
        .bind(user.driveId)
        .run();
      changed += byDrive.meta.changes ?? 0;
    }
  }
  return changed;
}

async function saveSyncState(
  db: D1Database,
  drive: DriveInfo,
  siteId: string | null,
  deltaLink: string | null,
  itemCount: number,
  error: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO microsoft_sync_state
        (drive_id, source_type, owner_id, site_id, delta_link, item_count, last_error, last_synced_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(drive_id) DO UPDATE SET
         source_type = excluded.source_type,
         owner_id = excluded.owner_id,
         site_id = excluded.site_id,
         delta_link = excluded.delta_link,
         item_count = excluded.item_count,
         last_error = excluded.last_error,
         last_synced_at = datetime('now'),
         updated_at = datetime('now')`
    )
    .bind(
      drive.id,
      drive.sourceType,
      drive.owner.id,
      siteId,
      deltaLink,
      itemCount,
      error
    )
    .run();
}

async function syncDrive(
  db: D1Database,
  graph: GraphClient,
  policy: AccessPolicy,
  drive: DriveInfo,
  siteId: string | null
): Promise<{ indexed: number; excluded: number; deleted: number; error?: string }> {
  if (policy.isProtectedDrive(drive.id) || policy.isProtectedUser(drive.owner)) {
    await saveSyncState(db, drive, siteId, null, 0, "skipped_protected");
    return { indexed: 0, excluded: 0, deleted: 0, error: "skipped_protected" };
  }

  const existing = await db
    .prepare("SELECT delta_link FROM microsoft_sync_state WHERE drive_id = ?")
    .bind(drive.id)
    .first<{ delta_link: string | null }>();

  let path =
    existing?.delta_link ||
    `/drives/${drive.id}/root/delta?$select=id,name,file,folder,parentReference,createdBy,lastModifiedBy,webUrl,size,lastModifiedDateTime,deleted&$top=50`;

  let indexed = 0;
  let excluded = 0;
  let deleted = 0;
  let pages = 0;
  let deltaLink: string | null = null;

  try {
    while (path && pages < 12 && indexed + excluded < MAX_ITEMS_PER_DRIVE) {
      const page = await graph.get<{
        value?: GraphItem[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>(path);
      for (const item of page.value ?? []) {
        if (item.deleted) {
          await markDeleted(db, drive.id, item.id);
          deleted += 1;
          continue;
        }
        const row = toRow(item, drive, siteId);
        if (!row) continue;
        const status = await upsertCatalogueRow(db, policy, row);
        if (status === "catalogue") indexed += 1;
        else excluded += 1;
      }
      deltaLink = page["@odata.deltaLink"] ?? deltaLink;
      path = page["@odata.nextLink"] ?? "";
      pages += 1;
    }
    await saveSyncState(db, drive, siteId, deltaLink, indexed, null);
    return { indexed, excluded, deleted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const walked = await walkChildren(db, graph, policy, drive, siteId);
    await saveSyncState(db, drive, siteId, null, walked.indexed, message.slice(0, 300));
    return { ...walked, error: message.slice(0, 300) };
  }
}

async function walkChildren(
  db: D1Database,
  graph: GraphClient,
  policy: AccessPolicy,
  drive: DriveInfo,
  siteId: string | null
): Promise<{ indexed: number; excluded: number; deleted: number }> {
  const queue: Array<{ itemId?: string; depth: number }> = [{ depth: 0 }];
  let indexed = 0;
  let excluded = 0;
  while (queue.length && indexed + excluded < MAX_ITEMS_PER_DRIVE) {
    const next = queue.shift()!;
    if (next.depth > 4) continue;
    const url = next.itemId
      ? `/drives/${drive.id}/items/${encodeURIComponent(next.itemId)}/children?$top=50&$select=id,name,file,folder,parentReference,createdBy,lastModifiedBy,webUrl,size,lastModifiedDateTime`
      : `/drives/${drive.id}/root/children?$top=50&$select=id,name,file,folder,parentReference,createdBy,lastModifiedBy,webUrl,size,lastModifiedDateTime`;
    try {
      const page = await graph.get<{ value?: GraphItem[] }>(url);
      for (const item of page.value ?? []) {
        if (item.folder) {
          queue.push({ itemId: item.id, depth: next.depth + 1 });
          continue;
        }
        const row = toRow(item, drive, siteId);
        if (!row) continue;
        const status = await upsertCatalogueRow(db, policy, row);
        if (status === "catalogue") indexed += 1;
        else excluded += 1;
      }
    } catch {
      /* skip inaccessible folder */
    }
  }
  return { indexed, excluded, deleted: 0 };
}

export async function syncEligibleCatalogue(
  db: D1Database,
  graph: GraphClient,
  config: ElMicrosoftConfig,
  policy: AccessPolicy
): Promise<{
  drives: number;
  indexed: number;
  excluded: number;
  deleted: number;
  purged: number;
  sharePointDrives: number;
  oneDrives: number;
}> {
  const purged = await purgeProtectedFromCatalogue(db, policy);
  const root = await discoverSharePointSite(graph, config);
  const teamSites = await discoverTeamSites(graph).catch(() => []);
  const sharePointSites = [
    ...(root ? [root] : []),
    ...teamSites.filter((site) => site.id !== root?.id),
  ];
  const sharePointDrives: DriveInfo[] = [];
  for (const site of sharePointSites.slice(0, 8)) {
    try {
      sharePointDrives.push(...(await listSiteDrives(graph, site.id)));
    } catch {
      /* Sites.Selected may block library listing on this group site */
    }
  }
  const oneDrives = await listEligibleOneDrives(graph, policy);
  const drives = [...sharePointDrives, ...oneDrives.eligible].slice(0, MAX_DRIVES);

  let indexed = 0;
  let excluded = 0;
  let deleted = 0;
  for (const drive of drives) {
    if (policy.isProtectedDrive(drive.id) || policy.isProtectedUser(drive.owner)) {
      excluded += 1;
      continue;
    }
    const siteId = drive.siteId ?? null;
    const result = await syncDrive(db, graph, policy, drive, siteId);
    indexed += result.indexed;
    excluded += result.excluded;
    deleted += result.deleted;
  }

  return {
    drives: drives.length,
    indexed,
    excluded,
    deleted,
    purged,
    sharePointDrives: sharePointDrives.length,
    oneDrives: oneDrives.eligible.length,
  };
}

export async function catalogueNeedsRefresh(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(last_synced_at) AS last_synced_at FROM microsoft_sync_state`
    )
    .first<{ n: number; last_synced_at: string | null }>();
  if (!row || !row.n) return true;
  if (!row.last_synced_at) return true;
  const last = Date.parse(row.last_synced_at.replace(" ", "T") + "Z");
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > STALE_MS;
}

export async function searchCatalogue(
  db: D1Database,
  policy: AccessPolicy,
  input: { query?: string; filename?: string; source?: "sharepoint" | "onedrive" | "all"; top?: number }
): Promise<FileHit[]> {
  await purgeProtectedFromCatalogue(db, policy);
  const words = [...searchTokens(input.filename), ...searchTokens(input.query)];
  const source = input.source ?? "all";
  const limit = Math.min(input.top ?? 20, 40);

  let sql = `SELECT * FROM microsoft_index_items WHERE status = 'catalogue'`;
  const binds: Array<string | number> = [];
  if (source !== "all") {
    sql += ` AND source_type = ?`;
    binds.push(source);
  }
  if (words.length) {
    const clauses = words.map(() => `(lower(ifnull(filename,'')) LIKE ? OR lower(ifnull(path,'')) LIKE ? OR lower(ifnull(search_text,'')) LIKE ?)`);
    sql += ` AND ${clauses.join(" AND ")}`;
    for (const word of words) {
      const like = `%${word}%`;
      binds.push(like, like, like);
    }
  }
  sql += ` ORDER BY modified_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await db.prepare(sql).bind(...binds).all<CatalogueRow>();
  const hits: FileHit[] = [];
  for (const row of rows.results ?? []) {
    const owner = { id: row.owner_id, displayName: row.owner_name, mail: row.owner_upn };
    if (!isIndexableOwner(policy, owner, row.drive_id, row.web_url, row.path)) {
      continue;
    }
    hits.push({
      id: row.item_id,
      name: row.filename ?? row.item_id,
      webUrl: row.web_url,
      size: row.size,
      mimeType: row.mime_type,
      lastModifiedDateTime: row.modified_at,
      folder: false,
      sourceType: row.source_type,
      driveId: row.drive_id,
      siteId: row.source_id,
      owner,
      path: row.path,
      provenance: [
        "Microsoft 365",
        row.source_type === "sharepoint" ? "SharePoint" : "OneDrive",
        row.owner_name ?? row.owner_upn ?? "unknown owner",
        row.path,
        row.filename,
      ]
        .filter(Boolean)
        .join(" → "),
    });
  }
  return hits;
}

export function rowCountSql(): string {
  return `SELECT COUNT(*) AS n FROM microsoft_index_items WHERE status = 'catalogue'`;
}

export async function catalogueStats(db: D1Database): Promise<{
  bySource: Array<{ source_type: string; status: string; n: number }>;
  sync: Array<{
    drive_id: string;
    source_type: string;
    owner_id: string | null;
    site_id: string | null;
    item_count: number;
    last_error: string | null;
    last_synced_at: string | null;
  }>;
  samples: Array<{
    filename: string | null;
    source_type: string;
    owner_upn: string | null;
    owner_name: string | null;
    path: string | null;
  }>;
}> {
  const bySource = await db
    .prepare(
      `SELECT source_type, status, COUNT(*) AS n FROM microsoft_index_items GROUP BY source_type, status`
    )
    .all<{ source_type: string; status: string; n: number }>();
  const sync = await db
    .prepare(
      `SELECT drive_id, source_type, owner_id, site_id, item_count, last_error, last_synced_at FROM microsoft_sync_state`
    )
    .all<{
      drive_id: string;
      source_type: string;
      owner_id: string | null;
      site_id: string | null;
      item_count: number;
      last_error: string | null;
      last_synced_at: string | null;
    }>();
  const samples = await db
    .prepare(
      `SELECT filename, source_type, owner_upn, owner_name, path FROM microsoft_index_items
       WHERE status = 'catalogue' ORDER BY modified_at DESC LIMIT 8`
    )
    .all<{
      filename: string | null;
      source_type: string;
      owner_upn: string | null;
      owner_name: string | null;
      path: string | null;
    }>();
  return {
    bySource: bySource.results ?? [],
    sync: sync.results ?? [],
    samples: samples.results ?? [],
  };
}
