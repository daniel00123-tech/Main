/** Parse Xero /.NET JSON dates, ISO strings, and Date objects to YYYY-MM-DD. */
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

export function compareIsoDateOnly(a: string, b: string): number {
  return a.localeCompare(b);
}

export function isBeforeIsoDate(a: string, b: string): boolean {
  return compareIsoDateOnly(a, b) < 0;
}

export function isOnOrAfterIsoDate(a: string, b: string): boolean {
  return compareIsoDateOnly(a, b) >= 0;
}

export function isOnOrBeforeIsoDate(a: string, b: string): boolean {
  return compareIsoDateOnly(a, b) <= 0;
}

export function isWithinIsoDateRange(
  value: string,
  startDate: string,
  endDate: string,
): boolean {
  return isOnOrAfterIsoDate(value, startDate) && isOnOrBeforeIsoDate(value, endDate);
}

export function daysBetweenIso(earlier: string, later: string): number {
  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  const end = Date.parse(`${later}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

export function resolveEffectiveDate(effectiveDate?: string): string {
  const normalized = effectiveDate ? normalizeXeroDate(effectiveDate) : null;
  if (normalized) return normalized;
  return new Date().toISOString().slice(0, 10);
}

export function toXeroDateTimeClause(isoDate: string): string {
  return `DateTime(${isoDate.replace(/-/g, ",")})`;
}
