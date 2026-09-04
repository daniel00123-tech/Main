/**
 * Progressive warehouse window planner.
 * 50-per-call is acceptable. 50-per-month-forever is not.
 * EL company MCP has no usable page/offset; subdivide month → week → day.
 */

import {
  COMPANY_MCP_RESULT_CAP,
  type WarehouseCheckpoint,
  type WarehouseCompleteness,
  type WarehouseMonthStatus,
  type WarehouseWindowGrain,
} from "./standard";

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function endOfMonth(isoDate: string): string {
  const next = addDays(startOfMonth(isoDate), 32);
  return addDays(startOfMonth(next), -1);
}

export function monthKey(isoDate: string | null | undefined): string | null {
  return isoDate && /^\d{4}-\d{2}/.test(isoDate) ? isoDate.slice(0, 7) : null;
}

export function monthsInRange(fromDate: string, toDate: string): string[] {
  const keys: string[] = [];
  let cursor = startOfMonth(fromDate);
  const last = startOfMonth(toDate);
  while (cursor <= last) {
    keys.push(cursor.slice(0, 7));
    cursor = startOfMonth(addDays(cursor, 32));
  }
  return keys;
}

export function windowHitsCap(count: number, cap = COMPANY_MCP_RESULT_CAP): boolean {
  return count >= cap;
}

export function windowIsComplete(count: number, cap = COMPANY_MCP_RESULT_CAP): boolean {
  return count < cap;
}

export function finerGrain(grain: WarehouseWindowGrain): WarehouseWindowGrain | null {
  if (grain === "month") return "week";
  if (grain === "week") return "day";
  return null;
}

export function calendarWindow(
  fromDate: string,
  historyTo: string,
  grain: WarehouseWindowGrain,
): { from: string; to: string } | null {
  if (fromDate > historyTo) return null;
  let to = fromDate;
  if (grain === "month") to = endOfMonth(fromDate);
  else if (grain === "week") to = addDays(fromDate, 6);
  const monthEnd = endOfMonth(fromDate);
  if (to > monthEnd) to = monthEnd;
  if (to > historyTo) to = historyTo;
  if (fromDate > to) return null;
  return { from: fromDate, to };
}

export function subdivideWindow(
  window: { from: string; to: string },
  grain: WarehouseWindowGrain,
): Array<{ from: string; to: string }> {
  const next = finerGrain(grain);
  if (!next) return [window];
  const out: Array<{ from: string; to: string }> = [];
  let cursor = window.from;
  while (cursor <= window.to) {
    const piece = calendarWindow(cursor, window.to, next);
    if (!piece) break;
    out.push(piece);
    cursor = addDays(piece.to, 1);
  }
  return out;
}

function emptyMonth(month: string, status: WarehouseMonthStatus["status"] = "NEVER_SYNCED"): WarehouseMonthStatus {
  return {
    month,
    status,
    recordsRetrieved: 0,
    lastCompletedWindow: null,
    nextWindowFrom: `${month}-01`,
    possiblyTruncated: false,
  };
}

export function inferMonthStatuses(
  invoices: Array<{ invoiceDate: string | null }>,
  historyFrom: string,
  historyTo: string,
  cap = COMPANY_MCP_RESULT_CAP,
): WarehouseMonthStatus[] {
  const counts = new Map<string, number>();
  for (const invoice of invoices) {
    const key = monthKey(invoice.invoiceDate);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return monthsInRange(historyFrom, historyTo).map((month) => {
    const recordsRetrieved = counts.get(month) ?? 0;
    if (recordsRetrieved >= cap) {
      return {
        month,
        status: "PARTIAL",
        recordsRetrieved,
        lastCompletedWindow: null,
        nextWindowFrom: `${month}-01`,
        possiblyTruncated: true,
      };
    }
    return {
      month,
      status: "COMPLETE",
      recordsRetrieved,
      lastCompletedWindow: `${month}-complete`,
      nextWindowFrom: null,
      possiblyTruncated: false,
    };
  });
}

export function firstIncompleteMonth(months: WarehouseMonthStatus[]): WarehouseMonthStatus | null {
  return months.find((row) => row.status !== "COMPLETE") ?? null;
}

export function summariseCompleteness(months: WarehouseMonthStatus[]): WarehouseCompleteness {
  if (!months.length) return "NEVER_SYNCED";
  if (months.every((row) => row.status === "COMPLETE")) return "COMPLETE";
  if (months.some((row) => row.status === "COMPLETE")) return "PARTIAL";
  if (months.some((row) => row.status === "PARTIAL" || row.status === "POSSIBLY_TRUNCATED")) return "PARTIAL";
  return "BACKFILLING";
}

export function recountMonthRecords(
  months: WarehouseMonthStatus[],
  invoices: Array<{ invoiceDate: string | null }>,
): WarehouseMonthStatus[] {
  const counts = new Map<string, number>();
  for (const invoice of invoices) {
    const key = monthKey(invoice.invoiceDate);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return months.map((row) => ({
    ...row,
    recordsRetrieved: counts.get(row.month) ?? row.recordsRetrieved,
  }));
}

export function seedProgressiveCheckpoint(
  checkpoint: WarehouseCheckpoint | null,
  invoices: Array<{ invoiceDate: string | null }>,
  historyFrom: string,
  historyTo: string,
): WarehouseCheckpoint {
  if (checkpoint?.months?.length && (checkpoint.backfillCursor || checkpoint.completeness === "COMPLETE")) {
    return {
      ...checkpoint,
      historyFrom: checkpoint.historyFrom ?? historyFrom,
      historyTo,
      months: recountMonthRecords(checkpoint.months, invoices),
    };
  }
  const months = inferMonthStatuses(invoices, historyFrom, historyTo);
  const incomplete = firstIncompleteMonth(months);
  const completeness = summariseCompleteness(months);
  return {
    mode: completeness === "COMPLETE" ? "incremental" : "backfill",
    invoicesUpdatedAfter: checkpoint?.invoicesUpdatedAfter ?? null,
    contactsUpdatedAfter: checkpoint?.contactsUpdatedAfter ?? null,
    paymentsUpdatedAfter: checkpoint?.paymentsUpdatedAfter ?? null,
    creditNotesUpdatedAfter: checkpoint?.creditNotesUpdatedAfter ?? null,
    historyFrom,
    historyTo,
    sourceTimestamp: checkpoint?.sourceTimestamp ?? null,
    backfillCursor: incomplete ? `${incomplete.month}-01` : null,
    windowGrain: incomplete?.status === "PARTIAL" || incomplete?.status === "POSSIBLY_TRUNCATED" ? "week" : "month",
    windowFrom: incomplete ? `${incomplete.month}-01` : null,
    lastCompletedWindow: checkpoint?.lastCompletedWindow ?? null,
    lastAttemptedWindow: null,
    completeness,
    months,
    contactsStatus: checkpoint?.contactsStatus ?? "BACKFILLING",
    contactPage: checkpoint?.contactPage ?? 1,
    contactsRetrieved: checkpoint?.contactsRetrieved ?? 0,
    completionEmailSent: checkpoint?.completionEmailSent ?? false,
    historicalComplete: completeness === "COMPLETE",
    recordsRetrieved: months.reduce((sum, row) => sum + row.recordsRetrieved, 0),
    invoiceLinesStatus: checkpoint?.invoiceLinesStatus ?? "unknown",
    paymentsStatus: checkpoint?.paymentsStatus ?? "unknown",
    creditNotesStatus: checkpoint?.creditNotesStatus ?? "unknown",
    paginationMode: checkpoint?.paginationMode ?? "window_subdivision",
  };
}

export function applyWindowResult(
  months: WarehouseMonthStatus[],
  window: { from: string; to: string },
  fetched: number,
  grain: WarehouseWindowGrain,
  cap = COMPANY_MCP_RESULT_CAP,
): {
  months: WarehouseMonthStatus[];
  nextCursor: string | null;
  nextGrain: WarehouseWindowGrain;
  possiblyTruncated: boolean;
} {
  const key = monthKey(window.from);
  const next = months.map((row) => ({ ...row }));
  let row = next.find((item) => item.month === key);
  if (!row && key) {
    row = emptyMonth(key, "BACKFILLING");
    next.push(row);
    next.sort((a, b) => a.month.localeCompare(b.month));
  }
  if (row) {
    row.lastCompletedWindow = `${window.from}:${window.to}`;
  }
  if (windowHitsCap(fetched, cap)) {
    const finer = finerGrain(grain);
    if (finer) {
      if (row) {
        row.status = "PARTIAL";
        row.nextWindowFrom = window.from;
        row.possiblyTruncated = false;
      }
      return { months: next, nextCursor: window.from, nextGrain: finer, possiblyTruncated: true };
    }
    if (row) {
      row.status = "POSSIBLY_TRUNCATED";
      row.nextWindowFrom = addDays(window.to, 1);
      row.possiblyTruncated = true;
    }
    return {
      months: next,
      nextCursor: addDays(window.to, 1),
      nextGrain: "day",
      possiblyTruncated: true,
    };
  }
  const advanced = addDays(window.to, 1);
  if (row && endOfMonth(window.from) <= window.to) {
    row.status = row.possiblyTruncated && grain === "day" ? "POSSIBLY_TRUNCATED" : "COMPLETE";
    if (row.status === "COMPLETE") row.possiblyTruncated = false;
    row.nextWindowFrom = null;
  } else if (row) {
    row.status = "BACKFILLING";
    row.nextWindowFrom = advanced;
  }
  let nextGrain: WarehouseWindowGrain = grain;
  if (advanced.slice(8, 10) === "01") {
    nextGrain = grain === "day" ? "week" : grain === "week" ? "month" : grain;
  }
  return { months: next, nextCursor: advanced, nextGrain, possiblyTruncated: Boolean(row?.possiblyTruncated) };
}

export function remainingIncompleteWindows(
  months: WarehouseMonthStatus[],
  historyTo: string,
  grain: WarehouseWindowGrain,
): number {
  let remaining = 0;
  for (const row of months) {
    if (row.status === "COMPLETE") continue;
    const from = row.nextWindowFrom ?? `${row.month}-01`;
    const to = historyTo < endOfMonth(from) ? historyTo : endOfMonth(from);
    if (from > to) continue;
    let cursor = from;
    let localGrain: WarehouseWindowGrain =
      row.status === "PARTIAL" || row.status === "POSSIBLY_TRUNCATED" ? "week" : grain;
    while (cursor <= to) {
      const win = calendarWindow(cursor, to, localGrain);
      if (!win) break;
      remaining += 1;
      cursor = addDays(win.to, 1);
    }
  }
  return remaining;
}

export function monthsTouchedByRange(
  months: WarehouseMonthStatus[],
  fromDate: string,
  toDate: string,
): WarehouseMonthStatus[] {
  const keys = new Set(monthsInRange(fromDate, toDate));
  return months.filter((row) => keys.has(row.month));
}

export function rangeCompleteness(
  months: WarehouseMonthStatus[],
  fromDate: string,
  toDate: string,
): WarehouseCompleteness {
  const touched = monthsTouchedByRange(months, fromDate, toDate);
  if (!touched.length) return "NEVER_SYNCED";
  return summariseCompleteness(touched);
}

export function planCatchupWindows(input: {
  cursor: string | null;
  grain: WarehouseWindowGrain;
  historyTo: string;
  currentMonthStart: string;
  budget: number;
}): Array<{ from: string; to: string; grain: WarehouseWindowGrain }> {
  if (!input.cursor || input.budget < 1) return [];
  const out: Array<{ from: string; to: string; grain: WarehouseWindowGrain }> = [];
  let cursor = input.cursor;
  let grain = input.grain;
  while (cursor && cursor <= input.historyTo && out.length < input.budget) {
    if (cursor >= input.currentMonthStart) break;
    const win = calendarWindow(cursor, input.historyTo < addDays(input.currentMonthStart, -1)
      ? input.historyTo
      : addDays(input.currentMonthStart, -1), grain);
    if (!win) break;
    out.push({ ...win, grain });
    cursor = addDays(win.to, 1);
    if (cursor.slice(8, 10) === "01") {
      grain = grain === "day" ? "week" : grain === "week" ? "month" : grain;
    }
  }
  return out;
}

export function historicalCatchupNeeded(checkpoint: WarehouseCheckpoint | null | undefined): boolean {
  if (!checkpoint) return true;
  if (checkpoint.backfillCursor) return true;
  if (checkpoint.completeness === "BACKFILLING" || checkpoint.completeness === "PARTIAL") return true;
  if (checkpoint.contactsStatus === "BACKFILLING" || checkpoint.contactsStatus === "PARTIAL") return true;
  if (checkpoint.months?.some((row) => row.status !== "COMPLETE")) return true;
  return false;
}
