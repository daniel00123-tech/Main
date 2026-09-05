import type { Env } from "../../env";
import { listQualityLoopRecipients, sendQualityLoopEmail } from "../quality-loop/email";

export async function sendTargetedQualityEmail(
  env: Env,
  input: {
    starting: number;
    final: number;
    telemetry: string;
    knowledge: string;
    outlook: string;
    mixed: string;
    issuesFixed: string[];
    remaining: string[];
    manual: string[];
  },
): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const lines = [
    `Starting score: ${input.starting}/10`,
    `Final score: ${input.final}/10`,
    "",
    `Telemetry: ${input.telemetry}`,
    `Knowledge: ${input.knowledge}`,
    `Outlook: ${input.outlook}`,
    `Mixed tools: ${input.mixed}`,
    "",
    "Issues fixed:",
    ...input.issuesFixed.map((row) => `- ${row}`),
    "",
    "Remaining blockers:",
    ...(input.remaining.length ? input.remaining.map((row) => `- ${row}`) : ["- None that block day-to-day use"]),
    "",
    "Manual actions:",
    ...(input.manual.length ? input.manual.map((row) => `- ${row}`) : ["- None"]),
  ];
  const result = await sendQualityLoopEmail(env, env.DB, {
    subject: "INFRA — Targeted Quality Repair Campaign Complete",
    bodyText: lines.join("\n"),
    bodyHtml: `<p>${lines.map((line) => (line ? escapeHtml(line) : "<br/>")).join("<br/>")}</p>`,
    recipients,
    eventType: "targeted_quality.complete",
    resourceId: `targeted_quality_${new Date().toISOString().slice(0, 10)}`,
  });
  return { sent: result.sent, recipients, error: result.error };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
