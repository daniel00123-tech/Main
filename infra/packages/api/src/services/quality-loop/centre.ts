import { classifyApplyClass, classifyApplyTier, classifyRecurrence, type ApplyClass, type ApplyTier, type RecurrenceClass } from "./classify";
import { reconstructMissingProposals } from "./reconstruct";
import {
  getRunBundle,
  listQualityLoopOverview,
  recoverStaleApplying,
  listProposalFingerprintsAcrossRuns,
  listPatternsForRun,
} from "./store";
import type { QualityPattern } from "./patterns";

const APPLYING_STALE_MS = 2 * 60 * 1000;

export async function buildQualityCentre(
  db: D1Database,
  options?: { runId?: string | null },
) {
  await recoverStaleApplying(db, APPLYING_STALE_MS);
  const overview = await listQualityLoopOverview(db);
  const requestedId = options?.runId?.trim() || overview.latestRun?.id || null;
  if (requestedId) {
    const patterns = await listPatternsForRun(db, requestedId);
    await reconstructMissingProposals(db, requestedId, patterns);
  }
  const bundle = requestedId ? await getRunBundle(db, requestedId) : null;
  const prior = await listProposalFingerprintsAcrossRuns(db);
  const liveAck = await countCurrentAckNoFinal(db);
  const proposals = (bundle?.proposals ?? []).map((row) => enrichProposal(row, prior, liveAck));
  const failed = (bundle?.failedConversations ?? []).map(enrichFailure);
  return {
    ...overview,
    latest: bundle
      ? {
          ...bundle,
          failedConversations: failed,
          proposals,
          ackNoFinalAudit: {
            flaggedInRun: failed.filter((row) => row.flags.some((flag) => flag.category === "ack_no_final")).length,
            currentOpenAcks: liveAck,
            terminalWatchdog: "independent t5/t10/t15/t30/t60 — t60 forces a terminal reply",
            classification: liveAck > 0 ? "CURRENT" : "HISTORICAL",
            note:
              liveAck > 0
                ? "Production still has acknowledged turns without a terminal reply."
                : "No current ack-without-terminal inbound events. Flagged rows are historical quality labels; several also recorded a later final.",
          },
        }
      : null,
    selectedRunId: requestedId,
  };
}

function enrichProposal(
  row: ReturnType<typeof mapLike>,
  prior: Map<string, number>,
  liveAck: number,
) {
  const patch = row.patch as { patches?: Array<{ path: string; value: unknown }> };
  const paths = (patch?.patches ?? []).map((item) => item.path);
  const applyClass = classifyApplyClass({
    kind: row.kind,
    risk: row.risk,
    autoApplyable: row.autoApplyable,
    engineeringRequired: row.engineeringRequired,
    patchPaths: paths,
  });
  const applyTier = classifyApplyTier({
    kind: row.kind,
    risk: row.risk,
    autoApplyable: row.autoApplyable,
    engineeringRequired: row.engineeringRequired,
    patchPaths: paths,
  });
  const currentLive = row.fingerprint.includes("ack_no_final") && liveAck > 0;
  const recurrence = classifyRecurrence({
    fingerprint: row.fingerprint,
    priorOccurrences: prior.get(row.fingerprint) ?? 1,
    currentLive,
  });
  return {
    ...row,
    applyClass,
    applyTier,
    recurrence,
    customerProgressUnchanged: paths.some((path) => path.startsWith("thresholds.")),
  };
}

function enrichFailure(row: {
  id: string;
  companyId: string;
  interactionId: string | null;
  conversationKey: string;
  overallScore: number;
  confidence: number;
  failed: boolean;
  permissionDenialCorrect: boolean;
  flags: unknown;
  dimensions: unknown;
}) {
  const flags = Array.isArray(row.flags) ? (row.flags as Array<{ category?: string; evidence?: string; polarity?: string }>) : [];
  const latency = flags
    .filter((flag) => /latency|first_visible|user_wait|ack/i.test(flag.category ?? ""))
    .map((flag) => ({ stage: flag.category ?? "latency", evidence: flag.evidence ?? "" }));
  return { ...row, flags, latencyBreakdown: latency };
}

async function countCurrentAckNoFinal(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM whatsapp_inbound_events
       WHERE acknowledgement_sent_at IS NOT NULL
         AND (terminal_state IS NULL OR terminal_state = '')
         AND reply_sent_at IS NULL
         AND received_at >= datetime('now', '-2 days')`,
    )
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));
  return Number(row?.n ?? 0);
}

type mapLike = {
  id: string;
  runId: string;
  companyId: string | null;
  title: string;
  summary: string;
  kind: string;
  risk: string;
  autoApplyable: boolean;
  engineeringRequired: boolean;
  patch: unknown;
  evidence: unknown;
  fingerprint: string;
  status: string;
  pretest: unknown;
  createdAt: string;
  updatedAt: string;
};

export type EnrichedProposal = ReturnType<typeof enrichProposal>;
export type { ApplyClass, ApplyTier, RecurrenceClass };
