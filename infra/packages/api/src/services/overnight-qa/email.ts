import type { Env } from "../../env";
import { listQualityLoopRecipients, sendQualityLoopEmail } from "../quality-loop/email";

export async function sendOvernightCampaignEmail(
  env: Env,
  input: {
    overall: number;
    testsRun: number;
    issuesFound: number;
    issuesFixed: number;
    remaining: number;
    whatsapp: number;
    portal: number;
    chatgpt: number;
    warehouse: number;
    knowledge: number;
    reliability: number;
    automaticFixes: number;
    manualActions: number;
  },
): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const lines = [
    `Overall score: ${input.overall}/10`,
    `Tests run: ${input.testsRun}`,
    `Issues found: ${input.issuesFound}`,
    `Issues fixed: ${input.issuesFixed}`,
    `Remaining issues: ${input.remaining}`,
    "",
    `WhatsApp: ${input.whatsapp}/10`,
    `Portal Chat: ${input.portal}/10`,
    `ChatGPT MCP: ${input.chatgpt}/10`,
    `Warehouse routing: ${input.warehouse}/10`,
    `Knowledge: ${input.knowledge}/10`,
    `Reliability: ${input.reliability}/10`,
    "",
    `Automatic fixes deployed: ${input.automaticFixes}`,
    `Remaining manual actions: ${input.manualActions}`,
    "",
    "This was a read-only TEST campaign. It did not change tariffs, roles, or OpenAI rollout policy.",
  ];
  const bodyText = lines.join("\n");
  const bodyHtml = `<p>${lines.map((line) => (line ? escapeHtml(line) : "<br/>")).join("<br/>")}</p>`;
  const result = await sendQualityLoopEmail(env, env.DB, {
    subject: "INFRA — Overnight Quality & Reliability Campaign — Complete",
    bodyText,
    bodyHtml,
    recipients,
    eventType: "overnight_qa.complete",
    resourceId: `overnight_qa_${new Date().toISOString().slice(0, 10)}`,
  });
  return { sent: result.sent, recipients, error: result.error };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
