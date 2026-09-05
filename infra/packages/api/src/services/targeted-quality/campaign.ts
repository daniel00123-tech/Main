import type { Env } from "../../env";
import { collectLiveInventory } from "../overnight-qa/inventory";
import { backfillRecentCustomerInteractions } from "../daily-improvement/audit";
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
