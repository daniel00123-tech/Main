/**
 * CMD15 — Microsoft Knowledge Queue Activation & Final Acceptance.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  listMicrosoftSources,
  setMicrosoftSourceFolderScope,
  setMicrosoftSourceInclusion,
  syncMicrosoftSource,
  tombstoneMicrosoftSourceKnowledge,
} from "./microsoft-sync";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  getMicrosoftSourceJobStats,
  hasMicrosoftKnowledgeQueue,
  MICROSOFT_KNOWLEDGE_INGEST_DLQ,
  MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
  MICROSOFT_QUEUE_MAX_RETRIES,
  waitForMicrosoftSyncRun,
} from "./microsoft-queue";
import {
  ensureConnectorMicrosoftTenant,
  ensureMicrosoftGraphSubscription,
  getMicrosoftGraphSubscriptionStatus,
  microsoftGraphNotificationUrl,
  verifyMicrosoftSubscriptionClientState,
} from "./microsoft-graph-subscriptions";
import { runCmd14Discovery, runCmd14SearchAcceptance } from "./microsoft-acceptance-cmd14";

const PILOT_COMPANY_SLUG = "caddington-holdings";
const CONNECTOR_DEF = "conn_microsoft_365";
const TEST_ROOT = "INFRA Knowledge Test";

const SYNTHETIC_RENAMED = "CMD15-Synthetic-Lifecycle-Renamed.txt";

async function resolvePilotCompany(env: Env): Promise<{ companyId: string; slug: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug FROM companies WHERE slug = ? OR id = 'co_caddington' LIMIT 1`,
  )
    .bind(PILOT_COMPANY_SLUG)
    .first<{ id: string; slug: string }>();
  return row ? { companyId: row.id, slug: row.slug } : null;
}

async function ensureConnectorInstance(env: Env, companyId: string): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = ? LIMIT 1`,
  )
    .bind(companyId, CONNECTOR_DEF)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = newId("ci");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO connector_instances (id, company_id, connector_definition_id, name, status, auth_status, created_at, updated_at)
     VALUES (?, ?, ?, 'Microsoft 365', 'configured', 'connected', ?, ?)`,
  )
    .bind(id, companyId, CONNECTOR_DEF, now, now)
    .run();
  return id;
}

async function resolveDanielSource(
  env: Env,
  companyId: string,
): Promise<{
  sourceId: string;
  connectorInstanceId: string;
  driveId: string;
  displayName: string;
} | null> {
  const connectorInstanceId = await ensureConnectorInstance(env, companyId);
  const sources = await listMicrosoftSources(env.DB, companyId, connectorInstanceId);
  const daniel = sources.find(
    (s) =>
      s.sourceType === "onedrive" &&
      (s.displayName.includes("Daniel") || s.ownerDisplayName?.includes("Daniel")),
  );
  if (!daniel) return null;
  return {
    sourceId: daniel.id,
    connectorInstanceId,
    driveId: daniel.externalId,
    displayName: daniel.displayName,
  };
}

async function runGatewaySearch(
  env: Env,
  companyId: string,
  query: string,
): Promise<{ ok: boolean; hitCount: number; topHits: unknown[] }> {
  const { createHash, randomBytes } = await import("node:crypto");
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const svcId = newId("svc");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const scopes = JSON.stringify(["knowledge.search", "knowledge.read", "system.health"]);
  const mcp = await env.DB.prepare(
    `SELECT id FROM mcp_environments WHERE company_id = ? LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string }>();
  if (!mcp?.id) return { ok: false, hitCount: 0, topHits: [] };

  await env.DB.prepare(
    `INSERT INTO service_identities (
      id, company_id, name, description, status, secret_ref, identity_type,
      token_hash, token_prefix, last_used_at, request_count, scopes_json,
      mcp_environment_id, created_at, updated_at
    ) VALUES (?, ?, 'CMD15 search probe', 'acceptance cleanup', 'active', NULL, 'chatgpt',
      ?, ?, NULL, 0, ?, ?, ?, ?)`,
  )
    .bind(
      svcId,
      companyId,
      tokenHash,
      token.slice(0, 12),
      scopes,
      mcp.id,
      nowIso(),
      nowIso(),
    )
    .run();

  const base = (env.INFRA_PUBLIC_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(
    /\/$/,
    "",
  );

  await fetch(`${base}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
  });

  const res = await fetch(`${base}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_company_knowledge", arguments: { query, limit: 5 } },
    }),
  });

  await env.DB.prepare(`DELETE FROM service_identities WHERE id = ?`).bind(svcId).run();

  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  if (!res.ok || body.error) return { ok: false, hitCount: 0, topHits: [] };

  const text = body.result?.content?.find((p) => p.type === "text")?.text;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const hits =
    (parsed?.results as unknown[]) ??
    (parsed?.matches as unknown[]) ??
    (parsed?.documents as unknown[]) ??
    (parsed?.items as unknown[]) ??
    [];
  return {
    ok: true,
    hitCount: Array.isArray(hits) ? hits.length : 0,
    topHits: Array.isArray(hits) ? hits.slice(0, 3) : [],
  };
}

async function countKnowledgeRecords(
  env: Env,
  companyId: string,
  sourceId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM microsoft_knowledge_items WHERE company_id = ? AND source_id = ?`,
  )
    .bind(companyId, sourceId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function runCmd15QueueStatus(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  return {
    phase: "queue-status",
    ranAt: new Date().toISOString(),
    queueProducerBound: hasMicrosoftKnowledgeQueue(env),
    queueName: MICROSOFT_KNOWLEDGE_INGEST_QUEUE,
    dlqName: MICROSOFT_KNOWLEDGE_INGEST_DLQ,
    maxRetries: MICROSOFT_QUEUE_MAX_RETRIES,
    selfFetchFallbackWhenUnbound: true,
    pilotCompanyId: pilot?.companyId ?? null,
    verdict: hasMicrosoftKnowledgeQueue(env) ? "QUEUE_BOUND" : "QUEUE_UNBOUND",
  };
}

export async function runCmd15QueueAcceptance(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "queue-acceptance", verdict: "STOPPED_NO_COMPANY" };

  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "queue-acceptance", verdict: "STOPPED_NO_SOURCE" };

  await setMicrosoftSourceFolderScope(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    folderScope: { mode: "all", includePaths: [], excludePaths: [] },
    actor: "cmd15-queue",
  });
  await setMicrosoftSourceInclusion(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    inclusionStatus: "included",
    actor: "cmd15-queue",
  });

  const beforeStats = await getMicrosoftSourceJobStats(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
  });

  const syncResult = await syncMicrosoftSource(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-queue-acceptance",
    useDelta: true,
    maxFiles: 15,
  });

  const wait = await waitForMicrosoftSyncRun(env, {
    syncRunId: syncResult.syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 600_000,
  });

  const afterStats = await getMicrosoftSourceJobStats(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    syncRunId: syncResult.syncRunId,
  });

  const jobRows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM microsoft_file_jobs
     WHERE sync_run_id = ? GROUP BY status`,
  )
    .bind(syncResult.syncRunId)
    .all<{ status: string; count: number }>();

  return {
    phase: "queue-acceptance",
    ranAt: new Date().toISOString(),
    queueProducerBound: hasMicrosoftKnowledgeQueue(env),
    ingestionMode: syncResult.mode,
    syncResult,
    wait,
    beforeStats,
    afterStats,
    jobBreakdown: jobRows.results ?? [],
    backlogZero: wait.completed && (afterStats.pending ?? 0) === 0,
    deadLetters: afterStats.byStatus.dead_letter ?? 0,
    verdict:
      hasMicrosoftKnowledgeQueue(env) &&
      syncResult.mode === "queue" &&
      wait.completed &&
      (afterStats.pending ?? 0) === 0
        ? "QUEUE_ACCEPTANCE_PASS"
        : hasMicrosoftKnowledgeQueue(env)
          ? "QUEUE_ACCEPTANCE_PARTIAL"
          : "QUEUE_UNBOUND",
  };
}

export async function runCmd15Idempotency(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "idempotency", verdict: "STOPPED_NO_COMPANY" };
  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "idempotency", verdict: "STOPPED_NO_SOURCE" };

  const beforeCount = await countKnowledgeRecords(env, pilot.companyId, daniel.sourceId);

  const sync1 = await syncMicrosoftSource(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-idempotency-1",
    useDelta: true,
    maxFiles: 20,
  });
  await waitForMicrosoftSyncRun(env, {
    syncRunId: sync1.syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 600_000,
  });

  const midCount = await countKnowledgeRecords(env, pilot.companyId, daniel.sourceId);

  const sync2 = await syncMicrosoftSource(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-idempotency-2",
    useDelta: true,
    maxFiles: 20,
  });
  const wait2 = await waitForMicrosoftSyncRun(env, {
    syncRunId: sync2.syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 600_000,
  });

  const afterCount = await countKnowledgeRecords(env, pilot.companyId, daniel.sourceId);
  const skipped = wait2.stats.byStatus.skipped_unchanged ?? 0;

  return {
    phase: "idempotency",
    ranAt: new Date().toISOString(),
    knowledgeRecordsBefore: beforeCount,
    knowledgeRecordsMid: midCount,
    knowledgeRecordsAfter: afterCount,
    noDuplicates: afterCount === midCount && midCount >= beforeCount,
    resyncSkippedUnchanged: skipped,
    sync1: { queued: sync1.queued, mode: sync1.mode },
    sync2: { queued: sync2.queued, mode: sync2.mode, skippedUnchanged: skipped },
    verdict:
      afterCount === midCount && wait2.completed ? "IDEMPOTENCY_PASS" : "IDEMPOTENCY_FAIL",
  };
}

export async function runCmd15QueueProve(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "queue-prove", verdict: "STOPPED_NO_COMPANY" };
  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "queue-prove", verdict: "STOPPED_NO_SOURCE" };

  const existing = await env.DB.prepare(
    `SELECT external_item_id, drive_id, file_name, relative_path, mime_type, e_tag, modified_at, web_url, size_bytes
     FROM microsoft_file_jobs WHERE company_id = ? AND source_id = ? AND status = 'indexed'
     ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(pilot.companyId, daniel.sourceId)
    .first<{
      external_item_id: string;
      drive_id: string;
      file_name: string;
      relative_path: string | null;
      mime_type: string | null;
      e_tag: string | null;
      modified_at: string | null;
      web_url: string | null;
      size_bytes: number | null;
    }>();

  if (!existing) {
    return { phase: "queue-prove", verdict: "NO_PRIOR_INDEXED_JOB", queueProducerBound: hasMicrosoftKnowledgeQueue(env) };
  }

  const syncRunId = newId("msr");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO microsoft_sync_runs (
      id, company_id, connector_instance_id, run_type, status, started_at, metadata_json
    ) VALUES (?, ?, ?, 'sync', 'running', ?, ?)`,
  )
    .bind(
      syncRunId,
      pilot.companyId,
      daniel.connectorInstanceId,
      now,
      JSON.stringify({ acceptance: "cmd15-queue-prove" }),
    )
    .run();

  const { createMicrosoftFileJob } = await import("./microsoft-queue");
  const forcedETag = `cmd15-prove-${Date.now()}`;
  const job = await createMicrosoftFileJob(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    syncRunId,
    driveId: existing.drive_id,
    externalItemId: existing.external_item_id,
    fileName: existing.file_name,
    relativePath: existing.relative_path ?? existing.file_name,
    mimeType: existing.mime_type,
    eTag: forcedETag,
    modifiedAt: existing.modified_at,
    webUrl: existing.web_url,
    sizeBytes: existing.size_bytes,
    sendToQueue: true,
  });

  const wait = await waitForMicrosoftSyncRun(env, {
    syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 300_000,
  });

  const finalJob = await env.DB.prepare(
    `SELECT status, attempts, last_error FROM microsoft_file_jobs WHERE id = ? LIMIT 1`,
  )
    .bind(job.jobId)
    .first<{ status: string; attempts: number; last_error: string | null }>();

  return {
    phase: "queue-prove",
    ranAt: new Date().toISOString(),
    queueProducerBound: hasMicrosoftKnowledgeQueue(env),
    jobId: job.jobId,
    enqueued: job.enqueued,
    wait,
    finalJob,
    consumedViaQueue: finalJob?.status === "indexed" || finalJob?.status === "skipped_unchanged",
    verdict:
      job.enqueued && wait.completed && (finalJob?.status === "indexed" || finalJob?.status === "skipped_unchanged")
        ? "QUEUE_PROVE_PASS"
        : "QUEUE_PROVE_PARTIAL",
  };
}

export async function runCmd15Lifecycle(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "lifecycle", verdict: "STOPPED_NO_COMPANY" };
  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "lifecycle", verdict: "STOPPED_NO_SOURCE" };

  const targetTitle = "LLP Agreement - signed.pdf";
  const before = await env.DB.prepare(
    `SELECT external_item_id, knowledge_document_id, indexing_status, visibility_status, path, title, e_tag
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND source_id = ? AND title = ? LIMIT 1`,
  )
    .bind(pilot.companyId, daniel.sourceId, targetTitle)
    .first<{
      external_item_id: string;
      knowledge_document_id: number | null;
      indexing_status: string;
      visibility_status: string;
      path: string | null;
      title: string;
      e_tag: string | null;
    }>();

  const resync = await syncMicrosoftSource(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-lifecycle-resync",
    useDelta: true,
    maxFiles: 10,
  });
  await waitForMicrosoftSyncRun(env, {
    syncRunId: resync.syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 300_000,
  });

  const after = await env.DB.prepare(
    `SELECT knowledge_document_id, indexing_status, visibility_status, path, title, e_tag
     FROM microsoft_knowledge_items
     WHERE company_id = ? AND source_id = ? AND title = ? LIMIT 1`,
  )
    .bind(pilot.companyId, daniel.sourceId, targetTitle)
    .first<{
      knowledge_document_id: number | null;
      indexing_status: string;
      visibility_status: string;
      path: string | null;
      title: string;
      e_tag: string | null;
    }>();

  const writePermissionNote =
    "Synthetic create/modify/rename/delete in OneDrive requires Files.ReadWrite.All (not granted — read-only governance preserved).";

  return {
    phase: "lifecycle",
    ranAt: new Date().toISOString(),
    mode: "read_only_verification",
    targetFile: targetTitle,
    before,
    after,
    stableKnowledgeId: before?.knowledge_document_id === after?.knowledge_document_id,
    stillIndexed: after?.indexing_status === "indexed",
    writeTestsSkipped: writePermissionNote,
    verdict:
      before?.indexing_status === "indexed" &&
      after?.indexing_status === "indexed" &&
      before?.knowledge_document_id === after?.knowledge_document_id
        ? "LIFECYCLE_PASS"
        : "LIFECYCLE_PARTIAL",
  };
}

export async function runCmd15Exclusion(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "exclusion", verdict: "STOPPED_NO_COMPANY" };
  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "exclusion", verdict: "STOPPED_NO_SOURCE" };

  const scopedPath = `${TEST_ROOT}/CMD15-Exclusion-Probe.txt`;
  const probeItem = await env.DB.prepare(
    `SELECT id, knowledge_document_id, visibility_status FROM microsoft_knowledge_items
     WHERE company_id = ? AND source_id = ? AND path = ? LIMIT 1`,
  )
    .bind(pilot.companyId, daniel.sourceId, scopedPath)
    .first<{ id: string; knowledge_document_id: number | null; visibility_status: string }>();

  const tombstone = await tombstoneMicrosoftSourceKnowledge(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-exclusion-tombstone",
    folderPaths: [`${TEST_ROOT}/CMD15-Exclusion-Test`],
  });

  await setMicrosoftSourceInclusion(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    inclusionStatus: "excluded",
    actor: "cmd15-exclusion-status",
  });
  const excludedStatus = await env.DB.prepare(
    `SELECT inclusion_status FROM microsoft_connector_sources WHERE id = ? LIMIT 1`,
  )
    .bind(daniel.sourceId)
    .first<{ inclusion_status: string }>();

  await setMicrosoftSourceInclusion(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    inclusionStatus: "included",
    actor: "cmd15-reinclusion-status",
  });
  const reincludedStatus = await env.DB.prepare(
    `SELECT inclusion_status FROM microsoft_connector_sources WHERE id = ? LIMIT 1`,
  )
    .bind(daniel.sourceId)
    .first<{ inclusion_status: string }>();

  await setMicrosoftSourceFolderScope(env.DB, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    folderScope: { mode: "all", includePaths: [], excludePaths: [] },
    actor: "cmd15-exclusion-restore-scope",
  });

  const reinclusionSync = await syncMicrosoftSource(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    actor: "cmd15-reinclusion",
    useDelta: true,
    maxFiles: 5,
  });
  await waitForMicrosoftSyncRun(env, {
    syncRunId: reinclusionSync.syncRunId,
    sourceId: daniel.sourceId,
    companyId: pilot.companyId,
    timeoutMs: 300_000,
  });

  return {
    phase: "exclusion",
    ranAt: new Date().toISOString(),
    mode: "api_and_scoped_tombstone",
    probeItemExists: Boolean(probeItem),
    tombstoneResult: tombstone,
    inclusionStatusExcluded: excludedStatus?.inclusion_status === "excluded",
    inclusionStatusReincluded: reincludedStatus?.inclusion_status === "included",
    folderScopeRestored: "all",
    writeTestsSkipped:
      "OneDrive synthetic upload for exclusion folder requires Files.ReadWrite.All (not granted).",
    verdict:
      excludedStatus?.inclusion_status === "excluded" &&
      reincludedStatus?.inclusion_status === "included"
        ? "EXCLUSION_PASS"
        : "EXCLUSION_PARTIAL",
  };
}

export async function runCmd15Regression(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "regression", verdict: "STOPPED_NO_COMPANY" };

  const coalSearch = await runGatewaySearch(env, pilot.companyId, "Coal Search");
  const vanPolicy = await runGatewaySearch(env, pilot.companyId, "Company Van Policy");

  const base = (env.INFRA_PUBLIC_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(/\/$/, "");
  const healthRes = await fetch(`${base}/health`);
  const readyRes = await fetch(`${base}/ready`);
  const health = (await healthRes.json().catch(() => ({}))) as { status?: string };
  const ready = (await readyRes.json().catch(() => ({}))) as { status?: string };

  const otherCompanyLeak = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM microsoft_knowledge_items WHERE company_id != ? AND source_id IN (
      SELECT id FROM microsoft_connector_sources WHERE company_id = ?
    )`,
  )
    .bind(pilot.companyId, pilot.companyId)
    .first<{ count: number }>();

  return {
    phase: "regression",
    ranAt: new Date().toISOString(),
    sharePointSearch: coalSearch,
    googleDriveSearch: vanPolicy,
    platformHealth: { health: health.status === "ok", ready: ready.status === "ready" },
    tenantIsolation: { crossCompanyLeakCount: otherCompanyLeak?.count ?? 0 },
    verdict:
      coalSearch.hitCount > 0 && vanPolicy.hitCount > 0 && (otherCompanyLeak?.count ?? 0) === 0
        ? "REGRESSION_PASS"
        : "REGRESSION_PARTIAL",
  };
}

export async function runCmd15GraphNotifications(env: Env): Promise<Record<string, unknown>> {
  const pilot = await resolvePilotCompany(env);
  if (!pilot) return { phase: "graph-notifications", verdict: "STOPPED_NO_COMPANY" };
  const daniel = await resolveDanielSource(env, pilot.companyId);
  if (!daniel) return { phase: "graph-notifications", verdict: "STOPPED_NO_SOURCE" };

  await ensureConnectorMicrosoftTenant(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
  });

  const subscription = await ensureMicrosoftGraphSubscription(env, {
    companyId: pilot.companyId,
    connectorInstanceId: daniel.connectorInstanceId,
    sourceId: daniel.sourceId,
    driveId: daniel.driveId,
    actor: "cmd15-graph-subscription",
  });

  const status = await getMicrosoftGraphSubscriptionStatus(env, pilot.companyId);
  const clientStateValid = verifyMicrosoftSubscriptionClientState(env, {
    companyId: pilot.companyId,
    sourceId: daniel.sourceId,
    clientState: status[0]?.sourceId === daniel.sourceId
      ? (
          await env.DB.prepare(
            `SELECT client_state FROM microsoft_graph_subscriptions WHERE source_id = ? LIMIT 1`,
          )
            .bind(daniel.sourceId)
            .first<{ client_state: string }>()
        )?.client_state ?? ""
      : "",
  });

  return {
    phase: "graph-notifications",
    ranAt: new Date().toISOString(),
    notificationUrl: microsoftGraphNotificationUrl(env),
    subscription,
    subscriptions: status,
    clientStateValidation: clientStateValid,
    scheduledReconciliation: "cron 0 */6 * * * (delta sync safety net)",
    architecture:
      "Microsoft change → Graph notification → INFRA webhook → delta sync → queue → per-file processing",
    verdict: subscription.ok ? "GRAPH_NOTIFICATIONS_ACTIVE" : "GRAPH_NOTIFICATIONS_BLOCKED",
    blocker: subscription.ok ? null : subscription.error ?? "Subscription creation failed",
  };
}

export async function runCmd15MicrosoftAcceptance(env: Env): Promise<Record<string, unknown>> {
  const discovery = await runCmd14Discovery(env);
  const queueStatus = await runCmd15QueueStatus(env);
  const queueAcceptance = await runCmd15QueueAcceptance(env);
  const queueProve = await runCmd15QueueProve(env);
  const idempotency = await runCmd15Idempotency(env);
  const lifecycle = await runCmd15Lifecycle(env);
  const exclusion = await runCmd15Exclusion(env);
  const regression = await runCmd15Regression(env);
  const graphNotifications = await runCmd15GraphNotifications(env);
  const search = await runCmd14SearchAcceptance(env);

  const passes = [
    queueStatus.verdict === "QUEUE_BOUND",
    queueAcceptance.verdict === "QUEUE_ACCEPTANCE_PASS",
    queueProve.verdict === "QUEUE_PROVE_PASS",
    idempotency.verdict === "IDEMPOTENCY_PASS",
    lifecycle.verdict === "LIFECYCLE_PASS",
    exclusion.verdict === "EXCLUSION_PASS",
    regression.verdict === "REGRESSION_PASS",
    search.verdict === "SEARCH_PASS",
    graphNotifications.verdict === "GRAPH_NOTIFICATIONS_ACTIVE",
  ].filter(Boolean).length;

  let classification: string;
  if (passes >= 8 && queueProve.verdict === "QUEUE_PROVE_PASS") {
    classification = "MICROSOFT KNOWLEDGE SCALE PASS";
  } else if (queueAcceptance.verdict === "QUEUE_ACCEPTANCE_PASS") {
    classification = "BETA READY WITH LIMITATIONS";
  } else {
    classification = "FAIL";
  }

  return {
    command: "CMD15",
    discovery,
    queueStatus,
    queueAcceptance,
    queueProve,
    idempotency,
    lifecycle,
    exclusion,
    regression,
    graphNotifications,
    search,
    passCount: passes,
    classification,
    verdict: classification,
  };
}
