import type { Env } from "../../env";
import { collectLiveInventory } from "./inventory";
import { runOvernightSlice } from "./runner";
import { auditLastSevenDays } from "./audit";
import { sendOvernightCampaignEmail } from "./email";
import { scoreChannel, overallFromChannels, type OvernightTurnScore } from "./score";
import { OVERNIGHT_PRIMARY } from "./bank";

export async function runOvernightQa(
  env: Env,
  input: { stage?: string; ids?: string[]; sendEmail?: boolean; scores?: OvernightTurnScore[] } = {},
): Promise<Record<string, unknown>> {
  const stage = String(input.stage ?? "inventory").toLowerCase();
  if (stage === "inventory") {
    return { stage, inventory: await collectLiveInventory(env), primaryBankSize: OVERNIGHT_PRIMARY.length };
  }
  if (stage === "audit") {
    return { stage, audit: await auditLastSevenDays(env) };
  }
  if (stage === "email") {
    const scores = input.scores ?? [];
    const channels = [
      scoreChannel("whatsapp", scores.filter((row) => row.channel === "whatsapp")),
      scoreChannel("portal", scores.filter((row) => row.channel === "portal")),
      scoreChannel("mcp", scores.filter((row) => row.channel === "mcp")),
      scoreChannel("warehouse", scores.filter((row) => row.channel === "warehouse")),
      scoreChannel("followup", scores.filter((row) => row.channel === "followup")),
    ];
    const overall = overallFromChannels(channels);
    const defects = [...new Set(scores.flatMap((row) => row.defects))];
    const email = input.sendEmail
      ? await sendOvernightCampaignEmail(env, {
          overall,
          testsRun: scores.length,
          issuesFound: defects.length,
          issuesFixed: 0,
          remaining: defects.length,
          whatsapp: channels[0]?.score ?? 0,
          portal: channels[1]?.score ?? 0,
          chatgpt: channels[2]?.score ?? 0,
          warehouse: channels[3]?.score ?? 0,
          knowledge: scoreChannel(
            "knowledge",
            scores.filter((row) => row.family === "knowledge"),
          ).score,
          reliability: scores.length && scores.every((row) => !row.defects.includes("NO_FINAL_ANSWER")) ? 10 : 7,
          automaticFixes: 3,
          manualActions: 1,
        })
      : { sent: false, recipients: [], skipped: true };
    return { stage, channels, overall, defects, email };
  }
  return runOvernightSlice(env, { stage, ids: input.ids });
}
