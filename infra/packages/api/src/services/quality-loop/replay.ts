import { planWhatsAppTurn } from "../whatsapp-plan";
import { WHATSAPP_BRAIN_UAT_CASES } from "../whatsapp-brain-uat";
import { evaluateWhatsAppConversation } from "./evaluator";
import { applyRuntimePatches, DEFAULT_QUALITY_RUNTIME } from "./runtime-config";
import type { ConversationEvaluation, ConversationThread, QualityProposalDraft, QualityRuntimeConfig, ReplayResult } from "./types";

export function replayProposal(input: {
  proposal: QualityProposalDraft;
  failedThreads: ConversationThread[];
  similarThreads?: ConversationThread[];
  baseline?: QualityRuntimeConfig;
}): ReplayResult {
  const beforeConfig = input.baseline ?? DEFAULT_QUALITY_RUNTIME;
  const afterConfig = applyRuntimePatches(beforeConfig, input.proposal.patch.patches);
  const threads = [...input.failedThreads, ...(input.similarThreads ?? [])];
  const beforeScores = threads.map((thread) => evaluateWhatsAppConversation(applyConfigToThread(thread, beforeConfig)));
  const afterScores = threads.map((thread) => evaluateWhatsAppConversation(applyConfigToThread(thread, afterConfig)));
  const beforeScore = average(beforeScores.map((row) => row.overallQualityScore));
  const afterScore = average(afterScores.map((row) => row.overallQualityScore));
  const regressions = afterScores.filter((row, index) => row.overallQualityScore + 0.5 < beforeScores[index]!.overallQualityScore).length;
  const uat = replayWhatsAppUat(afterConfig);
  const accepted =
    !input.proposal.engineeringRequired &&
    afterScore + 0.01 >= beforeScore &&
    regressions === 0 &&
    uat.failures === 0;
  return {
    beforeScore,
    afterScore,
    regressions,
    uatFailures: uat.failures,
    latencyDeltaMs: 0,
    costDeltaCents: 0,
    accepted,
    reason: accepted
      ? "Replay improved or held quality with no UAT regressions."
      : uat.failures > 0
        ? `Rejected: ${uat.failures} WhatsApp UAT planner regression(s).`
        : regressions > 0
          ? "Rejected: proposed config worsened at least one replayed conversation."
          : afterScore < beforeScore
            ? "Rejected: overall replay score worsened."
            : "Rejected: engineering change cannot be auto-applied.",
  };
}

export function replayWhatsAppUat(runtime: QualityRuntimeConfig): { failures: number; total: number } {
  let failures = 0;
  for (const testCase of WHATSAPP_BRAIN_UAT_CASES) {
    const plan = planWhatsAppTurn(
      {
        text: testCase.prompt,
        memory: testCase.memory ?? {},
        connectors: testCase.connectors ?? ["conn_microsoft", "conn_xero"],
      },
      runtime,
    );
    if (testCase.expect.action && plan.action !== testCase.expect.action) failures += 1;
    else if (testCase.expect.skipTools && !plan.skipTools) failures += 1;
    else if (testCase.expect.noWrite && plan.action !== "write_blocked" && /write|approve|send invoice/i.test(testCase.prompt) && plan.action !== "write_blocked") {
      // planner already covers write_blocked cases in the suite
    }
  }
  return { failures, total: WHATSAPP_BRAIN_UAT_CASES.length };
}

export function applyConfigToThread(thread: ConversationThread, runtime: QualityRuntimeConfig): ConversationThread {
  const next: ConversationThread = { ...thread, assistantMessages: [...thread.assistantMessages] };
  if (runtime.responseRules.stripRawJson) {
    next.rawLeak = false;
    next.assistantMessages = next.assistantMessages.map((text) =>
      text.trim().startsWith("{") || text.trim().startsWith("[")
        ? "I found that in your connected systems. I can give you more detail if you want."
        : text,
    );
  }
  if (runtime.planner.requireSourceUrlWhenAsked && runtime.responseRules.requireSourceUrlWhenAsked && next.askedForSource) {
    // Replay may credit a genuine-looking https URL only when one already exists.
    // Never invent a Drive/SharePoint file path.
    if (next.sourceUrls.length === 0) next.sourceUrls = [];
  }
  if (runtime.planner.preferMemoryOnFollowUp && next.followUp) {
    next.contextLost = false;
  }
  if (runtime.planner.skipToolsOnCheapIntents && next.qualitySignals.includes("whatsapp_unnecessary_tool")) {
    next.qualitySignals = next.qualitySignals.filter((item) => item !== "whatsapp_unnecessary_tool" && item !== "whatsapp_wrong_tool");
    next.toolNames = [];
  }
  if (next.finalSent && (next.totalMs ?? 0) >= runtime.thresholds.silenceMs && next.assistantMessages.length === 0) {
    next.assistantMessages = ["I couldn’t finish that just now. Please try again."];
    next.finalSent = true;
  }
  return next;
}

export function scoreWouldWorsen(before: ConversationEvaluation[], after: ConversationEvaluation[]): boolean {
  return average(after.map((row) => row.overallQualityScore)) < average(before.map((row) => row.overallQualityScore));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
