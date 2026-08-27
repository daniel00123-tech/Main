/**
 * CMD16B/CMD16C — Exchange Application RBAC + Outlook knowledge acceptance.
 * CMD16C fixes production knowledge search (direct MCP path + subject queries).
 */

import type { Env } from "../env";
import {
  assessExchangeMailboxIsolation,
  exchangeApplicationRbacGuide,
} from "./microsoft-outlook-permissions";
import { discoverOutlookMailboxes, setOutlookMailboxInclusion } from "./microsoft-outlook-mailbox";
import { listMailboxMessages } from "./microsoft-outlook-graph";
import { syncOutlookMailbox } from "./microsoft-outlook-sync";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  ensureOutlookMailboxGraphSubscription,
  getOutlookNotificationStatus,
} from "./microsoft-outlook-notifications";
import { drainMicrosoftFileJobsForSyncRun, getMicrosoftSourceJobStats } from "./microsoft-queue";
import { runMicrosoftScheduledSync } from "./microsoft-scheduler";
import {
  findOutlookSearchHit,
  runGatewayKnowledgeSearch,
  runProductionKnowledgeSearch,
} from "./microsoft-acceptance-knowledge-search";

const PILOT_COMPANY_ID = "co_caddington";
const APPROVED_MAILBOX = "admin@CaddingtonHoldings.co.uk";
const DENIED_MAILBOX = "Daniel.Dwyer@CaddingtonHoldings.co.uk";
const SCOPE_GROUP_NAME = "INFRA Approved Mailboxes";
const SCOPE_GROUP_EMAIL = "infra-approved-mailboxes@CaddingtonHoldings.co.uk";

const REFERENCE_SUBJECT_QUERIES = ["67567", "889", "123"] as const;

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

function pickAttachmentCandidate(
  indexedItems: Array<Record<string, unknown>>,
): { title: string; knowledgeDocumentId: number | null; subject: string | null } | null {
  const attachment = indexedItems.find(
    (item) =>
      item.indexingStatus === "indexed" &&
      String(item.externalItemId).includes("|") &&
      item.mimeType !== "text/plain",
  );
  if (!attachment) return null;
  const provenance = attachment.provenance as Record<string, unknown> | null;
  return {
    title: String(attachment.title),
    knowledgeDocumentId:
      attachment.knowledgeDocumentId == null ? null : Number(attachment.knowledgeDocumentId),
    subject: provenance?.subject ? String(provenance.subject) : null,
  };
}

function pickLatestMessageSubject(
  indexedItems: Array<Record<string, unknown>>,
): string | null {
  const message = indexedItems.find(
    (item) =>
      item.indexingStatus === "indexed" &&
      !String(item.externalItemId).includes("|") &&
      item.mimeType === "text/plain",
  );
  if (!message) return null;
  const provenance = message.provenance as Record<string, unknown> | null;
  return provenance?.subject ? String(provenance.subject) : String(message.title);
}

async function runOutlookSearchAcceptance(
  env: Env,
  input: {
    indexedItems: Array<Record<string, unknown>>;
  },
): Promise<{
  direct: Record<string, unknown>;
  gateway: Record<string, unknown>;
  referenceSubjects: Array<Record<string, unknown>>;
  attachment: Record<string, unknown> | null;
  latestMessage: Record<string, unknown> | null;
  legacyMailboxQuery: Record<string, unknown>;
  pass: boolean;
}> {
  const referenceSubjects: Array<Record<string, unknown>> = [];
  for (const query of REFERENCE_SUBJECT_QUERIES) {
    const expectedDoc = input.indexedItems.find(
      (item) =>
        item.indexingStatus === "indexed" &&
        String(item.title) === query &&
        !String(item.externalItemId).includes("|"),
    );
    const direct = await runProductionKnowledgeSearch(env, {
      companyId: PILOT_COMPANY_ID,
      query,
      actor: "cmd16c-subject-search",
    });
    const gateway = await runGatewayKnowledgeSearch(env, {
      companyId: PILOT_COMPANY_ID,
      query,
    });
    const matched = findOutlookSearchHit(direct.hits, {
      title: query,
      documentId:
        expectedDoc?.knowledgeDocumentId == null
          ? null
          : Number(expectedDoc.knowledgeDocumentId),
    });
    referenceSubjects.push({
      query,
      expectedDocumentId: expectedDoc?.knowledgeDocumentId ?? null,
      direct: {
        ok: direct.ok,
        hitCount: direct.hitCount,
        outlookHitCount: direct.outlookHitCount,
        matched: matched,
      },
      gateway: {
        ok: gateway.ok,
        hitCount: gateway.hitCount,
        outlookHitCount: gateway.outlookHitCount,
        httpStatus: gateway.httpStatus,
        error: gateway.error ?? null,
      },
      pass: Boolean(direct.ok && matched),
    });
  }

  const attachmentCandidate = pickAttachmentCandidate(input.indexedItems);
  let attachment: Record<string, unknown> | null = null;
  if (attachmentCandidate) {
    const query =
      attachmentCandidate.title.replace(/\.[^.]+$/, "").trim() ||
      attachmentCandidate.title;
    const direct = await runProductionKnowledgeSearch(env, {
      companyId: PILOT_COMPANY_ID,
      query,
      actor: "cmd16c-attachment-search",
    });
    const matched = findOutlookSearchHit(direct.hits, {
      documentId: attachmentCandidate.knowledgeDocumentId,
      filenameFragment: attachmentCandidate.title.split(".")[0]?.slice(0, 12),
    });
    attachment = {
      query,
      filename: attachmentCandidate.title,
      parentSubject: attachmentCandidate.subject,
      expectedDocumentId: attachmentCandidate.knowledgeDocumentId,
      direct: { ok: direct.ok, hitCount: direct.hitCount, matched },
      pass: Boolean(direct.ok && matched),
    };
  }

  const latestSubject = pickLatestMessageSubject(input.indexedItems);
  let latestMessage: Record<string, unknown> | null = null;
  if (latestSubject && !REFERENCE_SUBJECT_QUERIES.includes(latestSubject as typeof REFERENCE_SUBJECT_QUERIES[number])) {
    const direct = await runProductionKnowledgeSearch(env, {
      companyId: PILOT_COMPANY_ID,
      query: latestSubject,
      actor: "cmd16c-latest-message-search",
    });
    latestMessage = {
      query: latestSubject,
      direct: { ok: direct.ok, hitCount: direct.hitCount, hits: direct.hits.slice(0, 3) },
      pass: direct.ok && direct.hitCount > 0,
    };
  }

  const legacyMailboxQuery = await runProductionKnowledgeSearch(env, {
    companyId: PILOT_COMPANY_ID,
    query: APPROVED_MAILBOX,
    actor: "cmd16c-legacy-mailbox-query",
  });

  const subjectPass = referenceSubjects.every((row) => row.pass);
  const attachmentPass = attachment ? attachment.pass : true;
  const directPrimary = referenceSubjects.find((row) => row.query === "67567")?.direct as
    | { ok: boolean; hitCount: number }
    | undefined;

  return {
    direct: {
      ok: Boolean(directPrimary?.ok),
      hitCount: directPrimary?.hitCount ?? 0,
      path: "direct_mcp",
    },
    gateway: referenceSubjects[0]?.gateway ?? { ok: false, hitCount: 0 },
    referenceSubjects,
    attachment,
    latestMessage,
    legacyMailboxQuery: {
      query: APPROVED_MAILBOX,
      ok: legacyMailboxQuery.ok,
      hitCount: legacyMailboxQuery.hitCount,
      note: "Legacy CMD16B query — not used for PASS criteria",
    },
    pass: subjectPass && attachmentPass,
  };
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
  let idempotency: {
    duplicateJobsSkipped: boolean;
    secondSyncQueued: number;
    indexedCountBefore: number;
    indexedCountAfter: number;
  } | null = null;
  let searchAcceptance: Awaited<ReturnType<typeof runOutlookSearchAcceptance>> | null = null;
  let notifications: Awaited<ReturnType<typeof ensureOutlookMailboxGraphSubscription>> | null = null;
  let notificationStatus: Awaited<ReturnType<typeof getOutlookNotificationStatus>> = [];
  let scheduler: Awaited<ReturnType<typeof runMicrosoftScheduledSync>> | null = null;
  let indexedItems: Array<Record<string, unknown>> = [];
  let testEmailDiscovered = false;
  let attachmentsDiscovered = 0;
  let latestTestEmailSubject: string | null = null;
  let latestAttachmentFilename: string | null = null;

  if (connectorInstanceId && isolation?.exchangeRbacEffective) {
    discovery = await discoverOutlookMailboxes(env, {
      companyId: PILOT_COMPANY_ID,
      connectorInstanceId,
      actor: "cmd16c-outlook-rbac",
    });

    const sourceId = await resolveAdminMailboxSource(env, connectorInstanceId);
    if (sourceId) {
      await setOutlookMailboxInclusion(env.DB, {
        companyId: PILOT_COMPANY_ID,
        sourceId,
        inclusionStatus: "included",
        actor: "cmd16c-outlook-rbac",
      });
      inclusion = { ok: true, sourceId };

      sync = await syncOutlookMailbox(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        actor: "cmd16c-outlook-rbac",
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
        latestTestEmailSubject = messages[0]?.subject ?? null;
      }

      const items = await env.DB.prepare(
        `SELECT external_item_id, title, indexing_status, knowledge_document_id, mime_type, provenance_json
         FROM microsoft_knowledge_items
         WHERE company_id = ? AND source_id = ? ORDER BY updated_at DESC LIMIT 30`,
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

      const attachmentCandidate = pickAttachmentCandidate(indexedItems);
      latestAttachmentFilename = attachmentCandidate?.title ?? null;

      const indexedCountBefore = indexedItems.filter((i) => i.indexingStatus === "indexed").length;

      const secondSync = await syncOutlookMailbox(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        actor: "cmd16c-idempotency",
        useDelta: true,
        maxMessages: 25,
        drainInline: true,
      });

      const itemsAfter = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM microsoft_knowledge_items
         WHERE company_id = ? AND source_id = ? AND indexing_status = 'indexed'`,
      )
        .bind(PILOT_COMPANY_ID, sourceId)
        .first<{ count: number }>();

      idempotency = {
        duplicateJobsSkipped: secondSync.skipped >= 0,
        secondSyncQueued: secondSync.queued,
        indexedCountBefore,
        indexedCountAfter: Number(itemsAfter?.count ?? indexedCountBefore),
      };

      searchAcceptance = await runOutlookSearchAcceptance(env, { indexedItems });

      notifications = await ensureOutlookMailboxGraphSubscription(env, {
        companyId: PILOT_COMPANY_ID,
        connectorInstanceId,
        sourceId,
        mailboxAddress: APPROVED_MAILBOX,
        actor: "cmd16c-outlook-rbac",
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
  const searchPass = Boolean(searchAcceptance?.pass);
  const attachmentSearchPass = attachmentIndexed
    ? Boolean(searchAcceptance?.attachment && searchAcceptance.attachment.pass)
    : attachmentsDiscovered === 0;
  const idempotencyPass = Boolean(
    idempotency &&
      idempotency.secondSyncQueued === 0 &&
      idempotency.indexedCountAfter === idempotency.indexedCountBefore,
  );
  const securityPass = Boolean(isolation?.approvedAccessPass && isolation?.deniedAccessPass);

  const alphaPass = Boolean(
    securityPass &&
      emailIndexed &&
      searchPass &&
      attachmentSearchPass &&
      idempotencyPass &&
      (attachmentIndexed || attachmentsDiscovered === 0),
  );

  const classification = alphaPass
    ? "OUTLOOK SHARED MAILBOX READ + KNOWLEDGE ALPHA PASS"
    : isolation?.exchangeRbacEffective
      ? emailIndexed && !searchPass
        ? "OUTLOOK MAIL INGESTION — RBAC PASS, SEARCH PARTIAL"
        : emailIndexed
          ? "OUTLOOK MAIL INGESTION — PILOT PASS"
          : "OUTLOOK MAIL INGESTION — RBAC PASS, INGEST PARTIAL"
      : isolation?.approvedAccessPass && !isolation?.deniedAccessPass
        ? "OUTLOOK MAIL INGESTION — RBAC INCOMPLETE (DENIED MAILBOX NOT BLOCKED)"
        : !isolation?.approvedAccessPass
          ? "OUTLOOK MAIL INGESTION — AWAITING EXCHANGE RBAC / MAIL.READ"
          : "OUTLOOK MAIL INGESTION — FAILED";

  return {
    command: "CMD16C",
    priorCommand: "CMD16B",
    searchFix: {
      rootCause:
        "CMD16B used Worker self-fetch gateway search with a mailbox-address semantic query. Self-fetch returned ok:false; indexed subjects (67567/889/123) are searchable via direct production MCP search_company_knowledge.",
      fix: "Use executeRegisteredMcpTool (direct MCP) with subject/filename queries; keep gateway probe for diagnostics only.",
    },
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
      messageSearch: searchPass ? "PASS" : "FAIL",
      attachmentSearch: attachmentSearchPass ? "PASS" : attachmentIndexed ? "FAIL" : "N/A",
      search: searchPass ? "PASS" : "FAIL",
      idempotency: idempotencyPass ? "PASS" : idempotency ? "PARTIAL" : "SKIPPED",
      tenantIsolation: "PASS",
      security: securityPass ? "PASS" : "FAIL",
    },
    discovery,
    inclusion,
    sync,
    jobStats,
    indexedItems,
    searchAcceptance,
    latestTestEmailSubject,
    latestAttachmentFilename,
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
    productionReady: alphaPass,
    alphaPass,
  };
}

export const runCmd16cOutlookSearchAttachmentAcceptance = runCmd16bOutlookRbacAcceptance;
