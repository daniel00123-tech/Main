import type { AccessPolicy } from "./policy";
import { isIndexableOwner, type FileHit } from "./files";

/**
 * Knowledge/index helpers for Microsoft files.
 *
 * EL Business MCP does not yet have R2/Vectorize bindings, so this layer
 * only records catalogue rows and enforces protected-owner exclusion
 * before any future ingestion. It never starts a full-tenant crawl.
 */

export function assertIndexableFile(policy: AccessPolicy, hit: FileHit): boolean {
  return isIndexableOwner(policy, hit.owner, hit.driveId);
}

export async function upsertCatalogueItem(
  db: D1Database,
  policy: AccessPolicy,
  hit: FileHit
): Promise<{ status: "catalogue" | "excluded_protected" }> {
  const allowed = assertIndexableFile(policy, hit);
  const status = allowed ? "catalogue" : "excluded_protected";
  await db
    .prepare(
      `INSERT INTO microsoft_index_items
        (source_type, source_id, drive_id, item_id, owner_id, owner_upn, web_url, filename, modified_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(drive_id, item_id) DO UPDATE SET
         source_type = excluded.source_type,
         owner_id = excluded.owner_id,
         owner_upn = excluded.owner_upn,
         web_url = excluded.web_url,
         filename = excluded.filename,
         modified_at = excluded.modified_at,
         status = excluded.status,
         updated_at = datetime('now')`
    )
    .bind(
      hit.sourceType,
      hit.siteId,
      hit.driveId,
      hit.id,
      hit.owner.id,
      hit.owner.mail,
      hit.webUrl,
      hit.name,
      hit.lastModifiedDateTime,
      status
    )
    .run();
  return { status };
}

export async function purgeProtectedOwnerItems(
  db: D1Database,
  ownerId: string
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE microsoft_index_items
       SET status = 'excluded_protected', updated_at = datetime('now')
       WHERE owner_id = ? AND status != 'excluded_protected'`
    )
    .bind(ownerId)
    .run();
  return result.meta.changes ?? 0;
}

export async function purgeProtectedDriveItems(db: D1Database, driveId: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE microsoft_index_items
       SET status = 'excluded_protected', updated_at = datetime('now')
       WHERE drive_id = ? AND status != 'excluded_protected'`
    )
    .bind(driveId)
    .run();
  return result.meta.changes ?? 0;
}
