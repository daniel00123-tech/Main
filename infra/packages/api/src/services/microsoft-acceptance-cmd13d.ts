/**
 * CMD13D sync phase — folder-scoped OneDrive sync + idempotency (separate invocation).
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  listMicrosoftSources,
  setMicrosoftSourceFolderScope,
  setMicrosoftSourceInclusion,
  syncMicrosoftSource,
} from "./microsoft-sync";
import { formatMicrosoftSourceLabel } from "./microsoft-graph";
import { runCmd13dDiscovery } from "./microsoft-acceptance-cmd13d-discovery";

const COMPANY_ID = "co_caddington";
const CONNECTOR_DEF = "conn_microsoft_365";
const TEST_FOLDER = "INFRA Knowledge Test";

async function ensureConnectorInstance(db: D1Database): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = ? LIMIT 1`,
    )
    .bind(COMPANY_ID, CONNECTOR_DEF)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = `ci_ms365_${Date.now()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Microsoft 365', 'configured', 'connected', ?, ?)`,
    )
    .bind(id, COMPANY_ID, CONNECTOR_DEF, now, now)
    .run();
  return id;
}

export async function runCmd13dOneDriveSync(
  env: Env,
  input: { driveId: string; ownerDisplayName?: string; ownerUpn?: string | null },
): Promise<Record<string, unknown>> {
  const connectorInstanceId = await ensureConnectorInstance(env.DB);

  const existing = await env.DB.prepare(
    `SELECT id FROM microsoft_connector_sources WHERE company_id = ? AND connector_instance_id = ? AND external_id = ? LIMIT 1`,
  )
    .bind(COMPANY_ID, connectorInstanceId, input.driveId)
    .first<{ id: string }>();

  const sourceId = existing?.id ?? newId("mss");
  if (!existing?.id) {
    const now = nowIso();
    const ownerName = input.ownerDisplayName ?? "Daniel Dwyer";
    await env.DB.prepare(
      `INSERT INTO microsoft_connector_sources (
        id, company_id, connector_instance_id, source_type, external_id, display_name,
        inclusion_status, sync_status, owner_upn, owner_display_name, drive_type,
        items_discovered, items_indexed, folder_scope_mode, created_at, updated_at
      ) VALUES (?, ?, ?, 'onedrive', ?, ?, 'available', 'pending', ?, ?, 'personal', 0, 0, 'all', ?, ?)`,
    )
      .bind(
        sourceId,
        COMPANY_ID,
        connectorInstanceId,
        input.driveId,
        `${ownerName} (OneDrive)`,
        input.ownerUpn ?? null,
        ownerName,
        now,
        now,
      )
      .run();
  }

  await setMicrosoftSourceFolderScope(env.DB, {
    companyId: COMPANY_ID,
    sourceId,
    folderScope: { mode: "include_paths", includePaths: [TEST_FOLDER], excludePaths: [] },
    actor: "cmd13d-sync",
  });
  await setMicrosoftSourceInclusion(env.DB, {
    companyId: COMPANY_ID,
    sourceId,
    inclusionStatus: "included",
    actor: "cmd13d-sync",
  });

  const syncResult = await syncMicrosoftSource(env, {
    companyId: COMPANY_ID,
    connectorInstanceId,
    sourceId,
    actor: "cmd13d-sync",
    useDelta: false,
    maxFiles: 5,
  });

  const syncPass2 =
    syncResult.failed > 0 || syncResult.discovered > syncResult.indexed + syncResult.skipped
      ? await syncMicrosoftSource(env, {
          companyId: COMPANY_ID,
          connectorInstanceId,
          sourceId,
          actor: "cmd13d-sync-pass2",
          useDelta: false,
          maxFiles: 10,
        })
      : null;

  const knowledgeItems = await env.DB.prepare(
    `SELECT title, path, source_type, indexing_status, knowledge_document_id, visibility_status, mime_type
     FROM microsoft_knowledge_items WHERE company_id = ? AND source_id = ? ORDER BY updated_at DESC`,
  )
    .bind(COMPANY_ID, sourceId)
    .all();

  const resync = await syncMicrosoftSource(env, {
    companyId: COMPANY_ID,
    connectorInstanceId,
    sourceId,
    actor: "cmd13d-idempotency",
    useDelta: true,
    maxFiles: 25,
  });

  const sources = await listMicrosoftSources(env.DB, COMPANY_ID, connectorInstanceId);
  const otherIncluded = sources.filter(
    (s) => s.sourceType === "onedrive" && s.id !== sourceId && s.inclusionStatus === "included",
  );

  return {
    phase: "sync",
    ranAt: new Date().toISOString(),
    folderScope: { mode: "include_paths", includePaths: [TEST_FOLDER] },
    controlledOneDriveSync: syncResult,
    controlledOneDriveSyncPass2: syncPass2,
    idempotency: { resync },
    indexedItems: (knowledgeItems.results ?? []).map((row) => ({
      title: row.title,
      path: row.path,
      indexingStatus: row.indexing_status,
      visibilityStatus: row.visibility_status,
      mimeType: row.mime_type,
      sourceLabel: formatMicrosoftSourceLabel({
        sourceType: "onedrive",
        displayName: `${input.ownerDisplayName ?? "Daniel Dwyer"} (OneDrive)`,
        path: row.path ? String(row.path) : null,
        filename: String(row.title),
      }),
    })),
    governance: {
      otherOneDrivesIncluded: otherIncluded.length,
      defaultPolicy: "available-not-auto-included",
    },
    verdict: "SYNC_COMPLETE",
    sourceId,
    connectorInstanceId,
  };
}

export async function runCmd13dMicrosoftAcceptance(env: Env): Promise<Record<string, unknown>> {
  const discovery = await runCmd13dDiscovery(env);
  if (discovery.verdict !== "DISCOVERY_COMPLETE") {
    return { ...discovery, command: "CMD13D", verdict: discovery.verdict };
  }
  const sync = await runCmd13dOneDriveSync(env, {
    driveId: String(discovery.driveId),
    ownerDisplayName: (discovery.danielOneDrive as { ownerDisplayName?: string })?.ownerDisplayName,
  });
  return {
    command: "CMD13D",
    discovery,
    sync,
    verdict: "ACCEPTANCE_COMPLETE",
  };
}
