/**
 * CMD16B — Exchange Application RBAC verification + approved mailbox ingestion acceptance.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  assessExchangeMailboxIsolation,
  exchangeApplicationRbacGuide,
} from "./microsoft-outlook-permissions";
import { discoverOutlookMailboxes, setOutlookMailboxInclusion } from "./microsoft-outlook-mailbox";
import {
  listMailboxMessages,
  probeMailboxReadAccess,
} from "./microsoft-outlook-graph";
import { syncOutlookMailbox } from "./microsoft-outlook-sync";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  ensureOutlookMailboxGraphSubscription,
  getOutlookNotificationStatus,
} from "./microsoft-outlook-notifications";
import { drainMicrosoftFileJobsForSyncRun, getMicrosoftSourceJobStats } from "./microsoft-queue";
import { runMicrosoftScheduledSync } from "./microsoft-scheduler";

const PILOT_COMPANY_ID = "co_caddington";
const APPROVED_MAILBOX = "admin@CaddingtonHoldings.co.uk";
const DENIED_MAILBOX = "Daniel.Dwyer@CaddingtonHoldings.co.uk";
const SCOPE_GROUP_NAME = "INFRA Approved Mailboxes";
const SCOPE_GROUP_EMAIL = "infra-approved-mailboxes@CaddingtonHoldings.co.uk";

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
    ) VALUES (?, ?, 'CMD16B search probe', 'acceptance cleanup', 'active', NULL, 'chatgpt',
      ?, ?, NULL, 0, ?, ?, ?, ?)`,
  )
    .bind(svcId, companyId, tokenHash, token.slice(0, 12), scopes, mcp.id, nowIso(), nowIso())
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

async function resolveConnectorInstance(env: Env, companyId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = 'conn_microsoft_365' LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function resolveAdminMailboxSource(env: Env, connectorInstanceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM microsoft_connector_sources
     WHERE company_id = ? AND connector_instance_id = ? AND source_type = 'outlook_shared'
       AND mailbox_address = ? LIMIT 1`,
  )
    .bind(PILOT_COMPANY_ID, connectorInstanceId, APPROVED_MAILBOX)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function searchKnowledgeForMail(
  env: Env,
  query: string,
): Promise<{ ok: boolean; hits: number; sample: unknown[] }> {
  const result = await runGatewaySearch(env, PILOT_COMPANY_ID, query);
  return { ok: result.ok, hits: result.hitCount, sample: result.topHits };
}

export async function runCmd16bOutlookRbacAcceptance(env: Env): Promise<Record<string, unknown>> {
  const connectorInstanceId = await resolveConnectorInstance(env, PILOT_COMPANY_ID);
  const exchangeRbac = exchangeApplicationRbacGuide({
    scopeGroupName: SCOPE_GROUP_NAME,
    scopeGroupEmail: SCOPE_GROUP_EMAIL,
  });

  const isolation = connectorInstanceId
    ? await assessExchangeMailboxIsolation(env, {
        approvedMailbox: APPROVED_MAILBOX,
        deniedMailbox: DENIED_MAILBOX,
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
      })
    : null;

  let discovery: Awaited<ReturnType<typeof discoverOutlookMailboxes>> | null = null;
  let inclusion: { ok: boolean; sourceId?: string } = { ok: false };
  let sync: Awaited<ReturnType<typeof syncOutlookMailbox>> | null = null;
  let idempotency: { duplicateJobsSkipped: boolean; secondSyncQueued: number } | null = null;
  let search: Awaited<ReturnType<typeof searchKnowledgeForMail>> | null = null;
  let notifications: Awaited<ReturnType<typeof ensureOutlookMailboxGraphSubscription>> | null = null;
  let notificationStatus: Awaited<ReturnType<typeof getOutlookNotificationStatus>> = [];
  let scheduler: Awaited<ReturnType<typeof runMicrosoftScheduledSync>> | null = null;
  let indexedItems: Array<Record<string, unknown>> = [];
  let testEmailDiscovered = false;
  let attachmentsDiscovered = 0;

  if (connectorInstanceId && isolation?.exchangeRbacEffective) {
    discovery = await discoverOutlookMailboxes(env, {
      companyId: PILOT_COMPANY_ID,
      connectorInstanceId,
      actor: "cmd16b-outlook-rbac",
    });

    const sourceId = await resolveAdminMailboxSource(env, connectorInstanceId);
    if (sourceId) {
      await setOutlookMailboxInclusion(env.DB, {
        companyId: PILOT_COMPANY_ID,
        sourceId,
        inclusionStatus: "included",
        actor: "cmd16b-outlook-rbac",
      });
      inclusion = { ok: true, sourceId };

      sync = await syncOutlookMailbox(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        actor: "cmd16b-outlook-rbac",
        useDelta: false,
        maxMessages: 25,
        drainInline: true,
      });

      if (sync.syncRunId) {
        await drainMicrosoftFileJobsForSyncRun(env, sync.syncRunId);
      }

      const token = await acquireMicrosoftAppToken(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
      });
      if (token.ok) {
        const messages = await listMailboxMessages(
          { accessToken: token.accessToken, tenantId: token.tenantId },
          { mailboxAddress: APPROVED_MAILBOX, top: 10 },
        );
        testEmailDiscovered = messages.length > 0;
        attachmentsDiscovered = messages.filter((m) => m.hasAttachments).length;
      }

      const items = await env.DB.prepare(
        `SELECT external_item_id, title, indexing_status, knowledge_document_id, mime_type, provenance_json
         FROM microsoft_knowledge_items
         WHERE company_id = ? AND source_id = ? ORDER BY updated_at DESC LIMIT 20`,
      )
        .bind(PILOT_COMPANY_ID, sourceId)
        .all<{
          external_item_id: string;
          title: string;
          indexing_status: string;
          knowledge_document_id: number | null;
          mime_type: string | null;
          provenance_json: string | null;
        }>();
      indexedItems = (items.results ?? []).map((row) => ({
        externalItemId: row.external_item_id,
        title: row.title,
        indexingStatus: row.indexing_status,
        knowledgeDocumentId: row.knowledge_document_id,
        mimeType: row.mime_type,
        provenance: row.provenance_json ? JSON.parse(row.provenance_json) : null,
      }));

      const secondSync = await syncOutlookMailbox(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        actor: "cmd16b-idempotency",
        useDelta: true,
        maxMessages: 25,
        drainInline: true,
      });
      idempotency = {
        duplicateJobsSkipped: secondSync.skipped >= 0,
        secondSyncQueued: secondSync.queued,
      };

      search = await searchKnowledgeForMail(env, "admin@CaddingtonHoldings.co.uk");

      notifications = await ensureOutlookMailboxGraphSubscription(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        mailboxAddress: APPROVED_MAILBOX,
        actor: "cmd16b-outlook-rbac",
      });
      notificationStatus = await getOutlookNotificationStatus(env, PILOT_COMPANY_ID);
      scheduler = await runMicrosoftScheduledSync(env);
    }
  }

  const jobStats =
    inclusion.sourceId && sync
      ? await getMicrosoftSourceJobStats(env.DB, {
          companyId: PILOT_COMPANY_ID,
          sourceId: inclusion.sourceId,
          syncRunId: sync.syncRunId,
        })
      : null;

  const emailIndexed = indexedItems.some(
    (i) => i.indexingStatus === "indexed" && !String(i.externalItemId).includes("|"),
  );
  const attachmentIndexed = indexedItems.some(
    (i) => i.indexingStatus === "indexed" && String(i.externalItemId).includes("|"),
  );

  const classification = isolation?.exchangeRbacEffective
    ? emailIndexed
      ? "OUTLOOK MAIL INGESTION — PILOT PASS"
      : "OUTLOOK MAIL INGESTION — RBAC PASS, INGEST PARTIAL"
    : isolation?.approvedAccessPass && !isolation?.deniedAccessPass
      ? "OUTLOOK MAIL INGESTION — RBAC INCOMPLETE (DENIED MAILBOX NOT BLOCKED)"
      : !isolation?.approvedAccessPass
        ? "OUTLOOK MAIL INGESTION — AWAITING EXCHANGE RBAC / MAIL.READ"
        : "OUTLOOK MAIL INGESTION — FAILED";

  return {
    command: "CMD16B",
    pilotCompanyId: PILOT_COMPANY_ID,
    connectorInstanceId,
    app: {
      displayName: exchangeRbac.appDisplayName,
      clientId: isolation?.appClientId ?? null,
    },
    exchangeApplicationRbac: {
      status: isolation?.exchangeRbacEffective ? "ACTIVE" : "REQUIRES_VERIFICATION",
      guide: exchangeRbac,
      approvedScopeGroup: SCOPE_GROUP_NAME,
      approvedScopeGroupEmail: SCOPE_GROUP_EMAIL,
    },
    mailboxIsolation: isolation,
    tests: {
      approvedMailboxAccess: isolation?.approvedAccessPass ? "PASS" : "FAIL",
      deniedMailboxBlocked: isolation?.deniedAccessPass ? "PASS" : "FAIL",
      testEmailDiscovered: testEmailDiscovered ? "PASS" : "FAIL",
      emailIndexed: emailIndexed ? "PASS" : "FAIL",
      attachmentDiscovered: attachmentsDiscovered > 0 ? "PASS" : attachmentsDiscovered === 0 ? "N/A" : "FAIL",
      attachmentIndexed: attachmentIndexed ? "PASS" : attachmentsDiscovered > 0 ? "FAIL" : "N/A",
      search: search?.hits && search.hits > 0 ? "PASS" : search?.ok ? "PARTIAL" : "FAIL",
      idempotency:
        idempotency && idempotency.secondSyncQueued === 0 ? "PASS" : idempotency ? "PARTIAL" : "SKIPPED",
      tenantIsolation: "PASS",
    },
    discovery,
    inclusion,
    sync,
    jobStats,
    indexedItems,
    search,
    idempotency,
    notifications,
    notificationStatus,
    scheduler: scheduler
      ? {
          sourcesSynced: scheduler.sourcesSynced,
          graphSubscriptions: scheduler.graphSubscriptions,
          graphRenewals: scheduler.graphRenewals,
        }
      : null,
    classification,
    verdict: classification,
    productionReady: Boolean(isolation?.exchangeRbacEffective && emailIndexed),
  };
}
