export function normalizeXeroDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const dotnet = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(raw);
  if (dotnet) {
    const ms = Number(dotnet[1]);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function resolveEffectiveDate(effectiveDate?: string): string {
  return normalizeXeroDate(effectiveDate) ?? todayIso();
}

export function isBeforeIsoDate(a: string, b: string): boolean {
  return a.localeCompare(b) < 0;
}

export function isOnOrAfterIsoDate(a: string, b: string): boolean {
  return a.localeCompare(b) >= 0;
}

export function isOnOrBeforeIsoDate(a: string, b: string): boolean {
  return a.localeCompare(b) <= 0;
}

export function daysBetweenIso(earlier: string, later: string): number {
  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  const end = Date.parse(`${later}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

export function toXeroDateTimeClause(isoDate: string): string {
  return `DateTime(${isoDate.replace(/-/g, ",")})`;
}

export function startOfMonth(iso = todayIso()): string {
  return `${iso.slice(0, 7)}-01`;
}

export function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function previousMonthRange(iso = todayIso()): { from: string; to: string } {
  const thisStart = startOfMonth(iso);
  const prevStart = addMonths(thisStart, -1);
  const prevEnd = addMonths(thisStart, 0);
  const to = new Date(`${prevEnd}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() - 1);
  return { from: prevStart, to: to.toISOString().slice(0, 10) };
}

export function rollingRange(months: number, iso = todayIso()): { from: string; to: string } {
  return { from: addMonths(startOfMonth(iso), -(months - 1)), to: iso };
}

export function endOfMonth(iso = todayIso()): string {
  const nextMonthStart = addMonths(startOfMonth(iso), 1);
  const last = new Date(`${nextMonthStart}T00:00:00.000Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return last.toISOString().slice(0, 10);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthLabel(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const year = iso.slice(0, 4);
  return `${MONTH_NAMES[month - 1] ?? iso.slice(0, 7)} ${year}`;
}

export function managementPeriod(
  from?: string | null,
  to?: string | null,
  today = todayIso()
): { from: string; to: string; label: string; isMonthToDate: boolean } {
  const end = normalizeXeroDate(to) ?? today;
  const start = normalizeXeroDate(from) ?? startOfMonth(end);
  const monthEnd = endOfMonth(end);
  const isMonthToDate = start === startOfMonth(end) && end < monthEnd;
  const label =
    start === startOfMonth(end) && (end === monthEnd || isMonthToDate)
      ? `${monthLabel(end)}${isMonthToDate ? " month-to-date" : ""}`
      : `${start} to ${end}`;
  return { from: start, to: end, label, isMonthToDate };
}
