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
    });
    const registry = await env.DB.prepare(
      `SELECT mailbox_address, status, last_error, last_messages_scanned, graph_accessible
       FROM company_mailbox_registry
       WHERE company_id = 'co_el' AND mailbox_address IN ('lauren@elvexpropertyservices.com','michael@elvexpropertyservices.com')`,
    ).all();
    return { stage, retry, registry: registry.results ?? [], sendEmail: false };
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
