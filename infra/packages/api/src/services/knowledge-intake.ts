/**
 * Tenant-configurable Microsoft 365 knowledge-intake landing zone.
 * Store original attachments first, then index. Platform-wide — not EL-only.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { getCompanyById } from "./control-plane";
import { ELVEX_INFO_MAILBOXES } from "@infra/shared";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";
import {
  ensureDriveFolderByPath,
  graphPost,
  listDriveChildren,
  listSiteDrives,
  listSites,
  uploadBinaryFileToDrive,
  type GraphDrive,
  type GraphDriveItem,
  type GraphSite,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";

export const KNOWLEDGE_INTAKE_ROOT = "INFRA Knowledge Intake";
export const KNOWLEDGE_INTAKE_EMAIL_FOLDER = "Email Attachments";
export const KNOWLEDGE_INTAKE_QUARANTINE_FOLDER = "_quarantine";

export function knowledgeIntakeFolderSegments(
  mailboxAddress: string,
  receivedAt: Date,
  quarantine = false,
): string[] {
  const year = String(receivedAt.getUTCFullYear());
  const month = String(receivedAt.getUTCMonth() + 1).padStart(2, "0");
  const mailbox = mailboxFolderSegment(mailboxAddress);
  return quarantine
    ? [KNOWLEDGE_INTAKE_EMAIL_FOLDER, KNOWLEDGE_INTAKE_QUARANTINE_FOLDER, mailbox, year, month]
    : [KNOWLEDGE_INTAKE_EMAIL_FOLDER, mailbox, year, month];
}

export type KnowledgeIntakeTargetRow = {
  id: string;
  company_id: string;
  provider: string;
  site_id: string | null;
  drive_id: string | null;
  root_folder_id: string | null;
  root_folder_path: string | null;
  web_url: string | null;
  status: "unconfigured" | "ready" | "error" | "disabled";
  last_error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export type KnowledgeIntakeStoreResult =
  | {
      ok: true;
      via: "graph" | "durable_fallback";
      storedItemId: string;
      storedUrl: string | null;
      storedFilename: string;
      siteId: string | null;
      driveId: string | null;
      folderId: string | null;
      landingZoneReady: boolean;
      warning: string | null;
    }
  | { ok: false; code: string; message: string };

export function isKnowledgeIntakePath(path?: string | null): boolean {
  if (!path) return false;
  return /(^|\/)INFRA Knowledge Intake(\/|$)/i.test(path);
}

export function mailboxFolderSegment(mailboxAddress: string): string {
  const local = mailboxAddress.split("@")[0]?.trim() || "mailbox";
  return local.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "mailbox";
}

export function collisionSafeIntakeFilename(original: string, contentHash: string, attachmentId: string): string {
  const trimmed = (original || "attachment").trim() || "attachment";
  const dot = trimmed.lastIndexOf(".");
  const stem = (dot > 0 ? trimmed.slice(0, dot) : trimmed).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  const ext = dot > 0 ? trimmed.slice(dot, dot + 12) : "";
  const token = (contentHash.slice(0, 10) || attachmentId.slice(0, 10) || "item").toLowerCase();
  return `${stem}__${token}${ext}`;
}

export async function ensureKnowledgeIntakeTargetsSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS knowledge_intake_targets (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT 'microsoft_365',
        site_id TEXT,
        drive_id TEXT,
        root_folder_id TEXT,
        root_folder_path TEXT,
        web_url TEXT,
        status TEXT NOT NULL DEFAULT 'unconfigured',
        last_error TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
}

export async function getKnowledgeIntakeTarget(
  db: D1Database,
  companyId: string,
): Promise<KnowledgeIntakeTargetRow | null> {
  await ensureKnowledgeIntakeTargetsSchema(db);
  return db
    .prepare(`SELECT * FROM knowledge_intake_targets WHERE company_id = ? LIMIT 1`)
    .bind(companyId)
    .first<KnowledgeIntakeTargetRow>();
}

async function upsertKnowledgeIntakeTarget(
  db: D1Database,
  companyId: string,
  patch: Partial<KnowledgeIntakeTargetRow> & { metadata?: Record<string, unknown> },
): Promise<KnowledgeIntakeTargetRow> {
  await ensureKnowledgeIntakeTargetsSchema(db);
  const now = nowIso();
  const existing = await getKnowledgeIntakeTarget(db, companyId);
  const metadataJson = patch.metadata
    ? JSON.stringify(patch.metadata)
    : existing?.metadata_json ?? null;
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE knowledge_intake_targets
         SET provider = COALESCE(?, provider),
             site_id = COALESCE(?, site_id),
             drive_id = COALESCE(?, drive_id),
             root_folder_id = COALESCE(?, root_folder_id),
             root_folder_path = COALESCE(?, root_folder_path),
             web_url = COALESCE(?, web_url),
             status = COALESCE(?, status),
             last_error = ?,
             metadata_json = COALESCE(?, metadata_json),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        patch.provider ?? null,
        patch.site_id ?? null,
        patch.drive_id ?? null,
        patch.root_folder_id ?? null,
        patch.root_folder_path ?? null,
        patch.web_url ?? null,
        patch.status ?? null,
        patch.last_error === undefined ? existing.last_error : patch.last_error,
        metadataJson,
        now,
        existing.id,
      )
      .run();
    return (await getKnowledgeIntakeTarget(db, companyId))!;
  }
  const id = newId("kit");
  await db
    .prepare(
      `INSERT INTO knowledge_intake_targets (
        id, company_id, provider, site_id, drive_id, root_folder_id, root_folder_path,
        web_url, status, last_error, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      companyId,
      patch.provider ?? "microsoft_365",
      patch.site_id ?? null,
      patch.drive_id ?? null,
      patch.root_folder_id ?? null,
      patch.root_folder_path ?? null,
      patch.web_url ?? null,
      patch.status ?? "unconfigured",
      patch.last_error ?? null,
      metadataJson,
      now,
      now,
    )
    .run();
  return (await getKnowledgeIntakeTarget(db, companyId))!;
}

function preferDocumentLibrary(drives: GraphDrive[]): GraphDrive | null {
  const libraries = drives.filter((drive) => drive.driveType === "documentLibrary" || !drive.driveType);
  const named =
    libraries.find((drive) => /documents|shared documents|document library/i.test(drive.name ?? "")) ??
    libraries[0] ??
    drives.find((drive) => drive.driveType !== "personal") ??
    null;
  return named ?? null;
}

function preferCompanySite(sites: GraphSite[], companyName: string | null): GraphSite | null {
  const needle = (companyName ?? "").toLowerCase();
  const scored = sites
    .filter((site) => site.id && !/personal|my\.sharepoint|onedrive/i.test(`${site.webUrl ?? ""} ${site.displayName ?? ""}`))
    .map((site) => {
      const label = `${site.displayName ?? ""} ${site.name ?? ""}`.toLowerCase();
      let score = 0;
      if (needle && label.includes(needle)) score += 5;
      if (/elvex|property services/.test(label)) score += 3;
      if (/communication|team site|sharepoint/.test(label)) score += 1;
      return { site, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.site ?? sites[0] ?? null;
}

async function resolveGraphConfig(
  env: Env,
  companyId: string,
  actor: string,
): Promise<{ ok: true; config: MicrosoftGraphConfig } | { ok: false; code: string; message: string }> {
  const companyToken = await acquireMicrosoftAppToken(env, { companyId, actor });
  if (companyToken.ok) {
    return { ok: true, config: { accessToken: companyToken.accessToken, tenantId: companyToken.tenantId } };
  }
  const outlook = await resolveOutlookGraphAccess(env, {
    companyId,
    mailboxAddress: ELVEX_INFO_MAILBOXES[0],
    actor,
  });
  if (outlook.ok) {
    return { ok: true, config: { accessToken: outlook.accessToken, tenantId: outlook.tenantId } };
  }
  return { ok: false, code: outlook.code || companyToken.code, message: outlook.message || companyToken.message };
}

export async function discoverKnowledgeIntakeTarget(
  env: Env,
  input: { companyId: string; actor?: string },
): Promise<KnowledgeIntakeTargetRow> {
  const actor = input.actor ?? "system:knowledge-intake";
  const existing = await getKnowledgeIntakeTarget(env.DB, input.companyId);
  if (existing?.status === "ready" && existing.drive_id && existing.root_folder_id) {
    return existing;
  }
  if (existing?.status === "disabled") return existing;

  const company = await getCompanyById(env.DB, input.companyId);
  const graph = await resolveGraphConfig(env, input.companyId, actor);
  if (!graph.ok) {
    return upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
      status: "unconfigured",
      last_error: `${graph.code}: ${graph.message}`,
      metadata: { reason: "LANDING_ZONE_GRAPH_UNAVAILABLE", code: graph.code },
    });
  }

  try {
    const sites = await listSites(graph.config, company?.name || "*");
    const site = preferCompanySite(sites, company?.name ?? null);
    if (!site?.id) {
      return upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
        status: "unconfigured",
        last_error: "No SharePoint site was discoverable for the knowledge intake library",
        metadata: { reason: "NO_SHAREPOINT_SITE", siteCount: sites.length },
      });
    }
    const drives = await listSiteDrives(graph.config, site.id);
    const drive = preferDocumentLibrary(drives);
    if (!drive?.id) {
      return upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
        status: "unconfigured",
        site_id: site.id,
        last_error: "No SharePoint document library was discoverable",
        metadata: { reason: "NO_DOCUMENT_LIBRARY", siteId: site.id },
      });
    }
    const rootFolderId = await ensureDriveFolderByPath(graph.config, drive.id, KNOWLEDGE_INTAKE_ROOT);
    return upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
      provider: "microsoft_365",
      site_id: site.id,
      drive_id: drive.id,
      root_folder_id: rootFolderId,
      root_folder_path: KNOWLEDGE_INTAKE_ROOT,
      web_url: drive.webUrl ?? site.webUrl,
      status: "ready",
      last_error: null,
      metadata: {
        siteName: site.displayName ?? site.name,
        driveName: drive.name,
        driveType: drive.driveType,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "landing zone discovery failed";
    return upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
      status: "error",
      last_error: message,
      metadata: { reason: "LANDING_ZONE_DISCOVER_FAILED" },
    });
  }
}

async function ensureChildFolder(
  config: MicrosoftGraphConfig,
  driveId: string,
  parentId: string,
  name: string,
): Promise<string> {
  const children = await listDriveChildren(config, driveId, parentId);
  const existing = children.find((child) => child.name === name && child.folder);
  if (existing?.id) return existing.id;
  try {
    const created = await graphPost<GraphDriveItem>(config, `/drives/${driveId}/items/${parentId}/children`, {
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    if (created.id) return created.id;
  } catch {
    const retry = await listDriveChildren(config, driveId, parentId);
    const found = retry.find((child) => child.name === name && child.folder);
    if (found?.id) return found.id;
  }
  throw new Error(`Could not create intake folder ${name}`);
}

async function ensureMailboxMonthFolder(
  config: MicrosoftGraphConfig,
  driveId: string,
  rootFolderId: string,
  mailboxAddress: string,
  receivedAt: Date,
  quarantine = false,
): Promise<string> {
  let parentId = rootFolderId;
  for (const segment of knowledgeIntakeFolderSegments(mailboxAddress, receivedAt, quarantine)) {
    parentId = await ensureChildFolder(config, driveId, parentId, segment);
  }
  return parentId;
}

export async function storeOriginalInKnowledgeIntake(
  env: Env,
  input: {
    companyId: string;
    mailboxAddress: string;
    filename: string;
    mimeType: string | null;
    bytes: ArrayBuffer;
    contentHash: string;
    attachmentId: string;
    receivedAt?: Date | null;
    actor?: string;
    quarantine?: boolean;
  },
): Promise<KnowledgeIntakeStoreResult> {
  const actor = input.actor ?? "system:knowledge-intake";
  const target = await discoverKnowledgeIntakeTarget(env, { companyId: input.companyId, actor });
  const storedFilename = collisionSafeIntakeFilename(input.filename, input.contentHash, input.attachmentId);
  const receivedAt = input.receivedAt ?? new Date();

  if (target.status === "ready" && target.drive_id && target.root_folder_id) {
    const graph = await resolveGraphConfig(env, input.companyId, actor);
    if (graph.ok) {
      try {
        const folderId = await ensureMailboxMonthFolder(
          graph.config,
          target.drive_id,
          target.root_folder_id,
          input.mailboxAddress,
          receivedAt,
          input.quarantine === true,
        );
        const item = await uploadBinaryFileToDrive(
          graph.config,
          target.drive_id,
          folderId,
          storedFilename,
          input.bytes,
          input.mimeType,
        );
        return {
          ok: true,
          via: "graph",
          storedItemId: item.id,
          storedUrl: item.webUrl,
          storedFilename,
          siteId: target.site_id,
          driveId: target.drive_id,
          folderId,
          landingZoneReady: true,
          warning: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "landing zone upload failed";
        await upsertKnowledgeIntakeTarget(env.DB, input.companyId, {
          last_error: message,
          metadata: { reason: "LANDING_ZONE_UPLOAD_FAILED" },
        });
        return {
          ok: true,
          via: "durable_fallback",
          storedItemId: `fallback:${input.contentHash}`,
          storedUrl: null,
          storedFilename,
          siteId: target.site_id,
          driveId: target.drive_id,
          folderId: target.root_folder_id,
          landingZoneReady: false,
          warning: `LANDING_ZONE_UPLOAD_FAILED: ${message}`,
        };
      }
    }
  }

  return {
    ok: true,
    via: "durable_fallback",
    storedItemId: `fallback:${input.contentHash}`,
    storedUrl: null,
    storedFilename,
    siteId: target.site_id,
    driveId: target.drive_id,
    folderId: target.root_folder_id,
    landingZoneReady: target.status === "ready",
    warning: target.last_error
      ? `LANDING_ZONE_GRAPH_UNAVAILABLE: ${target.last_error}`
      : "LANDING_ZONE_GRAPH_UNAVAILABLE",
  };
}
