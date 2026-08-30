import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { sendCloudflareEmail } from "../email/providers/cloudflare-email";
import type { QualityLoopKind, QualityLoopMetrics } from "./types";

export function qualityReviewSubject(date: string): string {
  return `Infra AI Quality Review — ${date}`;
}

export function qualityReviewEmail(input: {
  date: string;
  kind: QualityLoopKind;
  cadence: string;
  periodFrom: string;
  periodTo: string;
  metrics: QualityLoopMetrics;
  failures: Array<{ companyLabel: string; category: string; snippet: string; interactionId?: string | null }>;
  patterns: Array<{ title: string; count: number; rootCause: string }>;
  proposals: Array<{ title: string; risk: string; autoApplyable: boolean; engineeringRequired: boolean }>;
  reviewUrl: string;
}): { subject: string; bodyText: string; bodyHtml: string } {
  const subject = qualityReviewSubject(input.date);
  const failureLines = input.failures.slice(0, 8).map(
    (row) => `• ${row.companyLabel}: ${row.category} — ${row.snippet}${row.interactionId ? ` (see ${row.interactionId})` : ""}`,
  );
  const patternLines = input.patterns.slice(0, 8).map((row) => `• ${row.title} (${row.count}) — ${row.rootCause}`);
  const proposalLines = input.proposals.slice(0, 8).map((row) => {
    const gate = row.engineeringRequired
      ? "ENGINEERING CHANGE REQUIRED"
      : row.autoApplyable
        ? `${row.risk.toUpperCase()} — can auto-apply after approval`
        : `${row.risk.toUpperCase()} — report only`;
    return `• ${row.title} (${gate})`;
  });
  const bodyText = [
    `INFRA AI quality review (${input.kind})`,
    `Cadence: ${input.cadence}`,
    `Period: ${input.periodFrom} → ${input.periodTo}`,
    "",
    "Executive summary",
    `${input.metrics.conversationsAnalysed} WhatsApp conversations analysed · quality ${input.metrics.qualityAverage.toFixed(1)} · failed ${(input.metrics.failedRate * 100).toFixed(0)}% · rephrase ${(input.metrics.rephraseRate * 100).toFixed(0)}%`,
    `Ack ${fmtMs(input.metrics.ackLatencyMs)} · final ${fmtMs(input.metrics.finalLatencyMs)} · evaluator overhead ${input.metrics.evaluatorCostCents}p`,
    "",
    "Focused failures (not the good chats)",
    ...(failureLines.length ? failureLines : ["None flagged this period."]),
    "",
    "Patterns",
    ...(patternLines.length ? patternLines : ["No repeating failure patterns."]),
    "",
    "Proposed improvements",
    ...(proposalLines.length ? proposalLines : ["No new proposals."]),
    "",
    `Review & approve (login required — this link does not apply changes): ${input.reviewUrl}`,
    "Full message bodies stay in authenticated Interaction detail.",
  ].join("\n");

  const bodyHtml = `
    <div style="font-family:Georgia,serif;color:#1b1916;line-height:1.45">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b6258">Infra AI Quality Review</p>
      <h1 style="margin:0 0 12px;font-size:22px">${escapeHtml(subject)}</h1>
      <p style="margin:0 0 16px">${escapeHtml(input.cadence)} · ${escapeHtml(input.periodFrom.slice(0, 10))} to ${escapeHtml(input.periodTo.slice(0, 10))}</p>
      <p><strong>${input.metrics.conversationsAnalysed}</strong> conversations · quality <strong>${input.metrics.qualityAverage.toFixed(1)}</strong> · failed <strong>${(input.metrics.failedRate * 100).toFixed(0)}%</strong></p>
      <h2 style="font-size:16px">Focused failures</h2>
      ${listHtml(failureLines, "None flagged this period.")}
      <h2 style="font-size:16px">Patterns</h2>
      ${listHtml(patternLines, "No repeating failure patterns.")}
      <h2 style="font-size:16px">Proposed improvements</h2>
      ${listHtml(proposalLines, "No new proposals.")}
      <p style="margin:24px 0">
        <a href="${escapeHtml(input.reviewUrl)}" style="display:inline-block;background:#1b1916;color:#f6f1e8;padding:12px 18px;text-decoration:none;border-radius:999px">Review &amp; Approve Improvements</a>
      </p>
      <p style="font-size:13px;color:#6b6258">Clicking this email does not apply changes. Approval requires a logged-in platform-admin session. Full bodies stay in Interaction detail.</p>
    </div>
  `;
  return { subject, bodyText, bodyHtml };
}

export function qualityConfirmationEmail(input: { date: string; titles: string[]; applied: boolean }): {
  subject: string;
  bodyText: string;
  bodyHtml: string;
} {
  const subject = `Infra AI Quality Review — ${input.date} (approved)`;
  const bodyText = [
    input.applied
      ? "Approved improvements were accepted and will canary/validate before promotion."
      : "Approval recorded. High-risk or engineering items remain report-only.",
    ...input.titles.map((title) => `• ${title}`),
  ].join("\n");
  return {
    subject,
    bodyText,
    bodyHtml: `<p>${escapeHtml(bodyText).replace(/\n/g, "<br/>")}</p>`,
  };
}

export function qualityRollbackEmail(input: { date: string; reason: string; version: number }): {
  subject: string;
  bodyText: string;
  bodyHtml: string;
} {
  const subject = `Infra AI Quality Review — ${input.date} (rolled back)`;
  const bodyText = `Automatic rollback of quality runtime v${input.version}.\nReason: ${input.reason}\nNo WhatsApp end-user runtime remains on the canary config.`;
  return {
    subject,
    bodyText,
    bodyHtml: `<p>Automatic rollback of quality runtime <strong>v${input.version}</strong>.</p><p>Reason: ${escapeHtml(input.reason)}</p>`,
  };
}

export async function listQualityLoopRecipients(db: D1Database, env: Env): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT email FROM users WHERE is_platform_admin = 1 AND status = 'active'`)
    .all<{ email: string }>();
  const emails = new Set((rows.results ?? []).map((row) => row.email.trim().toLowerCase()).filter(Boolean));
  const bootstrap = env.INITIAL_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrap) emails.add(bootstrap);
  if (emails.size === 0) emails.add("daniel.dwyer123@gmail.com");
  return [...emails];
}

export async function sendQualityLoopEmail(
  env: Env,
  db: D1Database,
  input: { subject: string; bodyText: string; bodyHtml: string; recipients: string[]; eventType: string; resourceId: string },
): Promise<{ sent: boolean; error?: string }> {
  let sent = false;
  let error: string | undefined;
  for (const recipient of input.recipients) {
    const result = await sendCloudflareEmail(env, {
      toEmail: recipient,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
    });
    if (result.ok) sent = true;
    else error = result.message;
  }
  await recordAuditEvent(db, {
    companyId: null,
    eventType: input.eventType,
    actor: "system:quality-loop",
    resourceType: "quality_loop_run",
    resourceId: input.resourceId,
    detail: { recipients: input.recipients.length, sent, error: error ?? null },
  });
  return { sent, error };
}

function fmtMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value)}ms`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function listHtml(lines: string[], empty: string): string {
  if (!lines.length) return `<p>${escapeHtml(empty)}</p>`;
  return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^•\s*/, ""))}</li>`).join("")}</ul>`;
}
