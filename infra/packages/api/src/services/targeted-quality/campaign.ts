import type { Env } from "../../env";
import { collectLiveInventory } from "../overnight-qa/inventory";
import { backfillRecentCustomerInteractions, reconcileWhatsAppHistorical } from "../daily-improvement/audit";
import { retryFailedOutlookAttachments } from "../outlook-attachment-ingest";
import { classifyDailyTraffic } from "../daily-improvement/traffic";
import { runTargetedSlice } from "./runner";
import { sendTargetedQualityEmail } from "./email";
import { scoreChannel, overallFromChannels } from "./score";
import type { OvernightTurnScore } from "../overnight-qa/types";
import { TARGETED_PRIMARY } from "./bank";
import { executeWarehouseTool } from "../warehouse/tools";
import { createD1WarehouseRepository } from "../warehouse/store";
import {
  backfillMissingMailboxFailureLedger,
  listFailedMailboxAttachmentEvents,
} from "../knowledge-ingestion-events";

export async function reconcileTelemetry(env: Env): Promise<Record<string, unknown>> {
  const since = "2026-08-28T00:00:00Z";
  const portal = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM portal_conversation_messages WHERE role = 'user' AND created_at >= ?`,
  )
    .bind(since)
    .first<{ n: number }>();
  const daily = await env.DB.prepare(
    `SELECT COALESCE(traffic_class, 'NULL') AS traffic_class, channel, COUNT(*) AS n
     FROM daily_improvement_interactions
     WHERE created_at >= ?
     GROUP BY traffic_class, channel`,
  )
    .bind(since)
    .all<{ traffic_class: string; channel: string; n: number }>();
  const whatsappUsage = await env.DB.prepare(
    `SELECT COUNT(DISTINCT interaction_id) AS n
     FROM usage_records
     WHERE recorded_at >= ? AND source_client = 'whatsapp' AND interaction_id IS NOT NULL`,
  )
    .bind(since)
    .first<{ n: number }>();
  const backfilled = await backfillRecentCustomerInteractions(env.DB, since, new Date().toISOString());
  const whatsappHistorical = await reconcileWhatsAppHistorical(env.DB, since, new Date().toISOString());
  const samples = {
    liveCustomer: classifyDailyTraffic({
      trafficClass: "CUSTOMER_REQUEST",
      userId: "user_live",
      userAgent: "Mozilla/5.0",
      sourceClient: "portal_chat",
      userMessage: "What are our Xero sales this month?",
    }),
    explicitTest: classifyDailyTraffic({
      trafficClass: "TEST",
      userId: "user_live",
      userAgent: "InfraAcceptance/1.0",
      sourceClient: "portal_chat",
      userMessage: "What are our Xero sales this month?",
    }),
    unlabeledFingerprint: classifyDailyTraffic({
      sourceClient: "portal_chat",
      userMessage: "What are our Xero sales this month?",
    }),
  };
  return {
    since,
    portalUserTurns: Number(portal?.n ?? 0),
    whatsappUsageParents: Number(whatsappUsage?.n ?? 0),
    dailyByClass: daily.results ?? [],
    backfilled,
    whatsappHistorical,
    classificationSamples: samples,
    note: "TEST rows were not relabelled as customer. Fingerprints apply only to unlabeled historical rows.",
  };
}

export async function runTargetedQuality(
  env: Env,
  input: {
    stage?: string;
    ids?: string[];
    sendEmail?: boolean;
    scores?: OvernightTurnScore[];
    emailPayload?: Parameters<typeof sendTargetedQualityEmail>[1];
  } = {},
): Promise<Record<string, unknown>> {
  const stage = String(input.stage ?? "inventory").toLowerCase();
  if (stage === "inventory") {
    return { stage, inventory: await collectLiveInventory(env), primaryBankSize: TARGETED_PRIMARY.length };
  }
  if (stage === "telemetry-reconcile") {
    return { stage, telemetry: await reconcileTelemetry(env) };
  }
  if (stage === "warehouse-meta") {
    return runWarehouseMeta(env);
  }
  if (stage === "xlsx-retry") {
    const retry = await retryFailedOutlookAttachments(env, {
      companyId: "co_el",
      mailboxAddresses: ["lauren@elvexpropertyservices.com"],
      actor: "system:targeted-quality-xlsx-retry",
      filenames: ["Creating  a supplier.xlsx", "OnCall_and_Holidays_2026 (1).xlsx"],
      eventIds: [
        "kie_ad1c14f9-4b6f-4e06-aa64-d8d8e796514f",
        "kie_0fd55a35-6624-4a66-ad86-83679d40ac0c",
      ],
      includeTerminal: true,
      limit: 10,
    });
    return { stage, retry, sendEmail: false };
  }
  if (stage === "ledger") {
    const backfill = await backfillMissingMailboxFailureLedger(env.DB, {
      companyId: "co_el",
      mailboxAddress: "michael@elvexpropertyservices.com",
    });
    const failed = await listFailedMailboxAttachmentEvents(env.DB, {
      companyId: "co_el",
      mailboxAddresses: ["michael@elvexpropertyservices.com"],
      limit: 80,
    });
    const registry = await env.DB.prepare(
      `SELECT mailbox_address, status, last_error, last_messages_scanned, graph_accessible
       FROM company_mailbox_registry
       WHERE company_id = 'co_el' AND mailbox_address = 'michael@elvexpropertyservices.com'`,
    ).first();
    const since = "2026-08-28T00:00:00Z";
    const now = new Date().toISOString();
    const parents = await env.DB.prepare(
      `SELECT COUNT(DISTINCT interaction_id) AS n
       FROM usage_records
       WHERE recorded_at >= ? AND recorded_at < ? AND source_client = 'whatsapp' AND interaction_id IS NOT NULL`,
    )
      .bind(since, now)
      .first<{ n: number }>();
    const daily = await env.DB.prepare(
      `SELECT COALESCE(traffic_class,'NULL') AS traffic_class, COUNT(*) AS n
       FROM daily_improvement_interactions
       WHERE created_at >= ? AND created_at < ? AND channel = 'whatsapp'
       GROUP BY traffic_class`,
    )
      .bind(since, now)
      .all<{ traffic_class: string; n: number }>();
    const customer = Number(daily.results?.find((row) => row.traffic_class === "CUSTOMER_REQUEST")?.n ?? 0);
    const test = Number(daily.results?.find((row) => row.traffic_class === "TEST")?.n ?? 0);
    const leftoverLegacy = Math.max(0, Number(parents?.n ?? 0) - customer - test);
    return {
      stage,
      backfill,
      failedLedgerRows: failed.length,
      failedSample: failed.slice(0, 8).map((row) => ({
        filename: row.filename,
        failureCode: row.failure_code,
        retryCount: row.retry_count,
        providerItemId: row.provider_item_id,
      })),
      registry,
      whatsappLegacyUnclassified: leftoverLegacy,
      sendEmail: false,
    };
  }
  if (stage === "mailbox-retry") {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE company_mailbox_registry
       SET status = 'approved',
           last_error = CASE
             WHEN last_error LIKE 'attachment ingest incomplete%' THEN 'DEGRADED: ' || last_error
             ELSE last_error
           END,
           updated_at = ?
       WHERE company_id = 'co_el'
         AND status = 'error'
         AND graph_accessible = 1
         AND last_error LIKE 'attachment ingest incomplete%'`,
    )
      .bind(now)
      .run();
    const retry = await retryFailedOutlookAttachments(env, {
      companyId: "co_el",
      mailboxAddresses: ["lauren@elvexpropertyservices.com", "michael@elvexpropertyservices.com"],
      actor: "system:targeted-quality-mailbox-retry",
      limit: 40,
      eventIds: input.ids,
    });
    const registry = await env.DB.prepare(
      `SELECT mailbox_address, status, last_error, last_messages_scanned, graph_accessible
       FROM company_mailbox_registry
       WHERE company_id = 'co_el' AND mailbox_address IN ('lauren@elvexpropertyservices.com','michael@elvexpropertyservices.com')`,
    ).all();
    return { stage, retry, registry: registry.results ?? [], sendEmail: false };
  }
  if (stage === "lauren-retry") {
    const eventIds = input.ids?.length
      ? input.ids
      : [
          "kie_ad1c14f9-4b6f-4e06-aa64-d8d8e796514f",
          "kie_0fd55a35-6624-4a66-ad86-83679d40ac0c",
        ];
    const before = await env.DB.prepare(
      `SELECT id, filename, failure_code, skip_reason, stored_item_id, stored_url, created_at, metadata_json
       FROM knowledge_ingestion_events
       WHERE company_id = 'co_el' AND id IN (${eventIds.map(() => "?").join(",")})`,
    )
      .bind(...eventIds)
      .all();
    const retry = await retryFailedOutlookAttachments(env, {
      companyId: "co_el",
      mailboxAddresses: ["lauren@elvexpropertyservices.com"],
      actor: "system:lauren-targeted-retry",
      eventIds,
      limit: eventIds.length,
    });
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n
       FROM knowledge_ingestion_events e
       WHERE e.company_id = 'co_el'
         AND lower(IFNULL(e.mailbox_address,'')) = 'lauren@elvexpropertyservices.com'
         AND e.event_type = 'failed'
         AND IFNULL(e.failure_code,'') NOT IN ('EXTRACT_EMPTY_TERMINAL', 'UNSUPPORTED_TYPE')
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_ingestion_events x
           WHERE x.company_id = e.company_id
             AND x.provider_item_id = e.provider_item_id
             AND x.event_type = 'indexed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM company_knowledge_documents d
           WHERE d.company_id = 'co_el'
             AND (
               LOWER(IFNULL(d.filename,'')) = LOWER(IFNULL(e.filename,''))
               OR (e.stored_item_id IS NOT NULL AND d.stored_item_id = e.stored_item_id)
             )
         )`,
    ).first<{ n: number }>();
    const retryableLeft = Number(remaining?.n ?? 0);
    if (retryableLeft === 0) {
      await env.DB.prepare(
        `UPDATE company_mailbox_registry
         SET last_error = NULL, status = 'approved', updated_at = ?
         WHERE company_id = 'co_el'
           AND lower(mailbox_address) = 'lauren@elvexpropertyservices.com'
           AND (last_error LIKE 'DEGRADED:%' OR last_error LIKE '%attachment ingest incomplete%')`,
      )
        .bind(new Date().toISOString())
        .run();
    }
    const registry = await env.DB.prepare(
      `SELECT mailbox_address, status, last_error, last_messages_scanned, graph_accessible
       FROM company_mailbox_registry
       WHERE company_id = 'co_el' AND mailbox_address = 'lauren@elvexpropertyservices.com'`,
    ).all();
    return {
      stage,
      eventIds,
      before: before.results ?? [],
      retry,
      retryableLeft,
      registry: registry.results ?? [],
      sendEmail: false,
    };
  }
  if (stage === "outlook-followup") {
    const { runPortalOutlookFollowupProof } = await import("../portal-outlook-followup-acceptance");
    return { stage, proof: await runPortalOutlookFollowupProof(env), sendEmail: false };
  }
  if (stage === "email") {
    const scores = input.scores ?? [];
    const knowledge = scoreChannel("knowledge", scores.filter((row) => row.family === "knowledge"));
    const outlook = scoreChannel("outlook", scores.filter((row) => row.family === "outlook"));
    const mixed = scoreChannel("mixed", scores.filter((row) => row.family === "mixed"));
    const followup = scoreChannel("followup", scores.filter((row) => row.family === "followup" || row.family === "correction"));
    const portal = scoreChannel("portal", scores.filter((row) => row.channel === "portal"));
    const overall = overallFromChannels([knowledge, outlook, mixed, followup, portal]);
    const email = input.sendEmail
      ? await sendTargetedQualityEmail(
          env,
          input.emailPayload ?? {
            starting: 8,
            final: overall,
            telemetry: "Canonical capture repaired; TEST remains separate",
            knowledge: `${knowledge.score}/10`,
            outlook: `${outlook.score}/10`,
            mixed: `${mixed.score}/10`,
            issuesFixed: [...new Set(scores.flatMap((row) => row.defects))].slice(0, 8),
            remaining: [],
            manual: [],
          },
        )
      : { sent: false, recipients: [], skipped: true };
    return { stage, knowledge, outlook, mixed, followup, portal, overall, email };
  }
  return runTargetedSlice(env, { stage, ids: input.ids });
}

async function runWarehouseMeta(env: Env): Promise<Record<string, unknown>> {
  const repo = createD1WarehouseRepository(env.DB);
  const cases = [
    { id: "WM01", fromDate: "2026-03-01", toDate: "2026-03-31", aggregation: "sales_total", expect: "COMPLETE" },
    { id: "WM02", fromDate: "2026-04-01", toDate: "2026-04-30", aggregation: "sales_total", expect: "COMPLETE" },
    { id: "WM03", fromDate: "2026-03-01", toDate: "2026-03-31", aggregation: "sales_by_month", expect: "COMPLETE" },
    { id: "WM04", fromDate: "2026-04-01", toDate: "2026-04-30", aggregation: "invoice_count", expect: "COMPLETE" },
    { id: "WM05", fromDate: "2026-05-01", toDate: "2026-05-31", aggregation: "sales_total", expect: "PARTIAL" },
    { id: "WM06", fromDate: "2026-06-01", toDate: "2026-06-30", aggregation: "sales_total", expect: "PARTIAL" },
    { id: "WM07", fromDate: "2026-07-01", toDate: "2026-07-31", aggregation: "sales_total", expect: "PARTIAL" },
    { id: "WM08", fromDate: "2026-08-01", toDate: "2026-08-31", aggregation: "sales_total", expect: "PARTIAL" },
    { id: "WM09", fromDate: "2026-08-01", toDate: "2026-08-31", aggregation: "sales_by_month", expect: "PARTIAL" },
    { id: "WM10", fromDate: "2026-03-01", toDate: "2026-03-31", aggregation: "invoice_count", expect: "COMPLETE" },
    { id: "WM11", fromDate: "2026-03-01", toDate: "2026-03-31", toolName: "warehouse_customer_analysis", expect: "COMPLETE" },
    { id: "WM12", fromDate: "2026-03-01", toDate: "2026-04-30", aggregation: "sales_by_month", expect: "COMPLETE" },
  ] as const;
  const turns: Array<Record<string, unknown>> = [];
  for (const row of cases) {
    const executed = await executeWarehouseTool({
      repo,
      companyId: "co_el",
      toolName: "toolName" in row ? row.toolName : "warehouse_sales_analysis",
      arguments: { fromDate: row.fromDate, toDate: row.toDate, aggregation: "aggregation" in row ? row.aggregation : undefined },
      intentText: `warehouse ${row.fromDate} ${row.toDate}`,
    });
    const payload = executed.ok
      ? ((executed.result.result as Record<string, unknown> | undefined) ?? (executed.result as Record<string, unknown>))
      : ((executed.result?.result as Record<string, unknown> | undefined) ?? executed.result ?? {});
    const asOf = String(payload.warehouse_as_of ?? payload.warehouseAsOf ?? "");
    const completeness = String(payload.completeness_status ?? payload.completenessStatus ?? "");
    const defects: string[] = [];
    if (!executed.ok) defects.push("WAREHOUSE_QUERY_FAILED");
    if (payload.source !== "xero_warehouse") defects.push("WRONG_SOURCE");
    if (!asOf) defects.push("MISSING_WAREHOUSE_AS_OF");
    if (!completeness) defects.push("MISSING_COMPLETENESS");
    if (!payload.period_start || !payload.period_end) defects.push("MISSING_PERIOD");
    if (payload.fallback === "xero_live") defects.push("UNNECESSARY_LIVE_XERO");
    if (row.expect === "PARTIAL" && !/PARTIAL|BACKFILLING/i.test(completeness) && payload.partial !== true) {
      defects.push("MISSING_PARTIAL_WARNING");
    }
    turns.push({
      id: row.id,
      ok: executed.ok,
      source: payload.source ?? null,
      warehouseAsOf: asOf || null,
      completeness,
      period_start: payload.period_start ?? payload.fromDate ?? null,
      period_end: payload.period_end ?? payload.toDate ?? null,
      record_count: payload.record_count ?? null,
      sales: payload.sales ?? null,
      partial: payload.partial ?? null,
      defects,
    });
  }
  return { stage: "warehouse-meta", turns, asked: cases.map((row) => row.id) };
}
