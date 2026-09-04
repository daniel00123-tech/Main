import type { Env } from "../../env";
import { listQualityLoopRecipients, sendQualityLoopEmail } from "../quality-loop/email";
import { computeNextWarehouseSyncUtcIso, describeWarehouseSchedule } from "./schedule";
import type { WarehouseSource, WarehouseSyncRun } from "./standard";

export function warehouseLiveEmail(input: {
  source: WarehouseSource;
  run: WarehouseSyncRun | null;
  nextSync: string;
}): { subject: string; bodyText: string; bodyHtml: string } {
  const schedule = describeWarehouseSchedule();
  const rec = input.source.lastReconciliation;
  const counts = input.source.recordCounts;
  const subject = "INFRA — EL Xero Data Warehouse V1 — Live";
  const lines = [
    "INFRA Business Data Warehouse V1 is live for EL Xero.",
    "",
    `Status: ${input.source.status}`,
    `Historical period: ${input.source.historicalFrom ?? "n/a"} → ${input.source.historicalTo ?? "n/a"}`,
    `Invoices: ${counts.invoices}`,
    `Invoice lines: ${counts.invoiceLines}`,
    `Contacts: ${counts.contacts}`,
    `Payments: ${counts.payments}`,
    `Credit notes: ${counts.creditNotes}`,
    `Snapshots: ${counts.snapshots}`,
    `Last successful sync: ${input.source.lastSuccessfulSync ?? "n/a"}`,
    `Reconciliation: ${rec ? (rec.passed ? "PASSED" : `DIVERGED (${rec.divergence.join(", ")})`) : "n/a"}`,
    rec
      ? `MTD sales warehouse ${rec.mtdSalesWarehouse} vs live ${rec.mtdSalesLive}; invoices ${rec.invoiceCountWarehouse} vs ${rec.invoiceCountLive}`
      : "",
    `Schedule: Mon–Fri ${schedule.weekdayHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")}; Sat/Sun ${schedule.weekendHours.map((h) => `${String(h).padStart(2, "0")}:00`)} ${schedule.timezone} (${schedule.slotsPerWeek}/week)`,
    `Next scheduled sync: ${input.nextSync}`,
    "",
    "Sample analytics now available via warehouse tools:",
    "• monthly sales over a date range",
    "• overdue movement snapshots",
    "• top customers for a period",
    "• month-to-month comparison",
    "• outstanding as a proportion of invoiced value",
    "",
    "Current / right-now questions still use live Xero.",
    "Xero remains the system of record. Warehouse sync is AUTOMATION (0 EL 3p).",
    "",
    "Limitations:",
    "• Warehouse V1 stores Xero invoices, lines, contacts, payments, and credit notes only.",
    "• Incremental sync uses If-Modified-Since; voided/deleted stay marked not current.",
    "• Degraded warehouse falls back to live Xero and is not served as authoritative.",
    input.run?.failureCode ? `• Latest run code: ${input.run.failureCode}` : "",
  ].filter(Boolean);
  const bodyText = lines.join("\n");
  const bodyHtml = `<div style="font-family:Georgia,serif;line-height:1.45"><h1>EL Xero Data Warehouse V1</h1><pre style="white-space:pre-wrap">${bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</pre></div>`;
  return { subject, bodyText, bodyHtml };
}

export function warehouseBackfillCompleteEmail(input: {
  source: WarehouseSource;
  run: WarehouseSyncRun | null;
  nextSync: string;
}): { subject: string; bodyText: string; bodyHtml: string } {
  const counts = input.source.recordCounts;
  const months = input.source.checkpoint?.months ?? [];
  const complete = months.filter((row) => row.status === "COMPLETE");
  const subject = "INFRA — EL Xero Warehouse Historical Backfill Complete";
  const lines = [
    "INFRA EL Xero warehouse historical backfill has reached COMPLETE.",
    "",
    `Date range: ${input.source.historicalFrom ?? "n/a"} → ${input.source.historicalTo ?? "n/a"}`,
    `Invoices stored: ${counts.invoices}`,
    `Contacts stored: ${counts.contacts} (${input.source.checkpoint?.contactsStatus ?? "unknown"})`,
    `Invoice lines: ${counts.invoiceLines} (${input.source.checkpoint?.invoiceLinesStatus ?? "unknown"})`,
    `Payments: ${counts.payments} (${input.source.checkpoint?.paymentsStatus ?? "unknown"})`,
    `Credit notes: ${counts.creditNotes} (${input.source.checkpoint?.creditNotesStatus ?? "unknown"})`,
    `Months complete: ${complete.map((row) => row.month).join(", ") || "n/a"}`,
    `Completeness: ${input.source.checkpoint?.completeness ?? input.source.status}`,
    `Proof: every month window returned fewer than the 50-row company-MCP cap, or was subdivided until that was proven.`,
    `Last successful sync: ${input.source.lastSuccessfulSync ?? "n/a"}`,
    `Next scheduled sync: ${input.nextSync}`,
    "",
    "Limitations:",
    "• Completeness is against the authorised company-MCP Xero path, not a native Xero page dump.",
    "• Invoice lines / payments / credit notes are included only when that path actually returned them.",
    "• Current-month figures still reconcile against live Xero; warehouse remains AUTOMATION / 0 EL 3p.",
    "• This email is sent once. Incremental sync continues on the existing London schedule.",
  ];
  const bodyText = lines.join("\n");
  const bodyHtml = `<div style="font-family:Georgia,serif;line-height:1.45"><h1>EL Xero Warehouse Historical Backfill Complete</h1><pre style="white-space:pre-wrap">${bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</pre></div>`;
  return { subject, bodyText, bodyHtml };
}

export async function sendWarehouseBackfillCompleteEmail(
  env: Env,
  input: { source: WarehouseSource; run: WarehouseSyncRun | null },
): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const content = warehouseBackfillCompleteEmail({
    source: input.source,
    run: input.run,
    nextSync: computeNextWarehouseSyncUtcIso(),
  });
  const result = await sendQualityLoopEmail(env, env.DB, {
    ...content,
    recipients,
    eventType: "warehouse.backfill_complete",
    resourceId: input.run?.syncId ?? "warehouse_v12_complete",
  });
  return { sent: result.sent, recipients, error: result.error };
}

export async function sendWarehouseLiveEmail(
  env: Env,
  input: { source: WarehouseSource; run: WarehouseSyncRun | null },
): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = await listQualityLoopRecipients(env.DB, env);
  const content = warehouseLiveEmail({
    source: input.source,
    run: input.run,
    nextSync: computeNextWarehouseSyncUtcIso(),
  });
  const result = await sendQualityLoopEmail(env, env.DB, {
    ...content,
    recipients,
    eventType: "warehouse.live_notice",
    resourceId: input.run?.syncId ?? "warehouse_v1",
  });
  return { sent: result.sent, recipients, error: result.error };
}
