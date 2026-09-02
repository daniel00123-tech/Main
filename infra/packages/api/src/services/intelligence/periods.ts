/**
 * Natural-language business periods → civil dates.
 * Intelligence path only. Europe/London. Does not change Xero OAuth or Action Engine.
 */

export const INTELLIGENCE_PERIOD_TZ = "Europe/London";

export type CivilDate = { year: number; month: number; day: number };

export type ResolvedPeriod = {
  fromDate: string;
  toDate: string;
  label: string;
  comparisonRequested: boolean;
  comparisonSupported: boolean;
  comparison?: { fromDate: string; toDate: string; label: string };
  pnl?: { periods: number; timeframe: "MONTH" | "QUARTER" | "YEAR" };
};

export type BusinessSystemArgs = {
  fromDate: string;
  toDate: string;
  periodLabel: string;
  comparisonRequested?: boolean;
  comparisonSupported?: boolean;
  comparisonFromDate?: string;
  comparisonToDate?: string;
  comparisonLabel?: string;
  periods?: number;
  timeframe?: "MONTH" | "QUARTER" | "YEAR";
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCivilDate(date: CivilDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function londonCivilParts(now: Date, timeZone = INTELLIGENCE_PERIOD_TZ): CivilDate & { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(date: CivilDate, delta: number): CivilDate {
  const utc = Date.UTC(date.year, date.month - 1, date.day + delta);
  const next = new Date(utc);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function weekdayMonday0(date: CivilDate): number {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (utc.getUTCDay() + 6) % 7;
}

function startOfWeek(date: CivilDate): CivilDate {
  return addDays(date, -weekdayMonday0(date));
}

function endOfWeek(date: CivilDate): CivilDate {
  return addDays(startOfWeek(date), 6);
}

function startOfMonth(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: 1 };
}

function endOfMonth(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: daysInMonth(date.year, date.month) };
}

function addMonths(date: CivilDate, delta: number): CivilDate {
  const monthIndex = date.month - 1 + delta;
  const year = date.year + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const dim = daysInMonth(year, month + 1);
  return { year, month: month + 1, day: Math.min(date.day, dim) };
}

function quarterStartMonth(month: number): number {
  return Math.floor((month - 1) / 3) * 3 + 1;
}

function startOfQuarter(date: CivilDate): CivilDate {
  return { year: date.year, month: quarterStartMonth(date.month), day: 1 };
}

function endOfQuarter(date: CivilDate): CivilDate {
  const month = quarterStartMonth(date.month) + 2;
  return { year: date.year, month, day: daysInMonth(date.year, month) };
}

function startOfYear(date: CivilDate): CivilDate {
  return { year: date.year, month: 1, day: 1 };
}

function endOfYear(date: CivilDate): CivilDate {
  return { year: date.year, month: 12, day: 31 };
}

function range(from: CivilDate, to: CivilDate, label: string): Omit<ResolvedPeriod, "comparisonRequested" | "comparisonSupported"> {
  return { fromDate: formatCivilDate(from), toDate: formatCivilDate(to), label };
}

const MONTH_NAMES: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function parseExplicitCivilDate(token: string): CivilDate | null {
  const value = String(token ?? "").trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
      return { year, month, day };
    }
    return null;
  }
  const uk = value.match(/^(\d{1,2})[/.\\-](\d{1,2})[/.\\-](\d{4})$/);
  if (uk) {
    const day = Number(uk[1]);
    const month = Number(uk[2]);
    const year = Number(uk[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)) {
      return { year, month, day };
    }
  }
  return null;
}

function parseNamedDate(value: string, fallbackYear: number): CivilDate | null {
  const match =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i.exec(
      value,
    );
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTH_NAMES[match[2].toLowerCase()];
  const year = match[3] ? Number(match[3]) : fallbackYear;
  if (!month || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function extractExplicitDates(text: string, fallbackYear: number): CivilDate[] {
  const found: CivilDate[] = [];
  const seen = new Set<string>();
  const push = (date: CivilDate | null) => {
    if (!date) return;
    const key = formatCivilDate(date);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(date);
  };
  for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\\-]\d{1,2}[/.\\-]\d{4})\b/g)) {
    push(parseExplicitCivilDate(match[1]));
  }
  for (const match of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/gi,
  )) {
    push(parseNamedDate(match[0], fallbackYear));
  }
  return found;
}

function findExplicitPeriod(hay: string): Omit<ResolvedPeriod, "comparisonRequested" | "comparisonSupported"> | null {
  const rangeMatch = hay.match(
    /(?:from|between)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\\-]\d{1,2}[/.\\-]\d{4})\s+(?:to|and|-)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\\-]\d{1,2}[/.\\-]\d{4})/i,
  );
  if (rangeMatch) {
    const from = parseExplicitCivilDate(rangeMatch[1]);
    const to = parseExplicitCivilDate(rangeMatch[2]);
    if (from && to) return range(from, to, `${formatCivilDate(from)} to ${formatCivilDate(to)}`);
  }
  const named = hay.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(\d{4})\b/i,
  );
  if (named) {
    const month = MONTH_NAMES[named[2].toLowerCase().replace(".", "")];
    const day = Number(named[1]);
    const year = Number(named[3]);
    if (month && day >= 1 && day <= daysInMonth(year, month)) {
      const civil = { year, month, day };
      return range(civil, civil, formatCivilDate(civil));
    }
  }
  const single = hay.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\\-]\d{1,2}[/.\\-]\d{4})\b/);
  if (single) {
    const civil = parseExplicitCivilDate(single[1]);
    if (civil) return range(civil, civil, formatCivilDate(civil));
  }
  return null;
}

export function resolveBusinessPeriod(
  text: string,
  now = new Date(),
  timeZone = INTELLIGENCE_PERIOD_TZ,
): ResolvedPeriod {
  const today = londonCivilParts(now, timeZone);
  const civil: CivilDate = { year: today.year, month: today.month, day: today.day };
  const hay = String(text ?? "")
    .toLowerCase()
    .replace(/_/g, " ");
  const comparisonRequested = /\b(compar(e|ed|ing)|versus|vs\.?|against|this (month|week|quarter|year) (and|with|vs) last)\b/i.test(
    hay,
  );

  let primary = range(startOfMonth(civil), civil, "this month");
  let comparison: ResolvedPeriod["comparison"];
  let pnl: ResolvedPeriod["pnl"];

  const explicit = findExplicitPeriod(hay);
  const namedPeriod = /\b(this|last|past|previous|yesterday|today)\s+(week|month|quarter|year|7 days|30 days|90 days)\b/.test(
    hay,
  ) || /\b(yesterday|last week|last month|last quarter|last year|this week|this month|this quarter|this year|past 7 days|past 30 days|past 90 days)\b/.test(
    hay,
  );

  if (explicit && !namedPeriod) {
    primary = explicit;
  } else if (explicit && /\btoday\b/.test(hay) && !/\bthis (week|month|quarter|year)\b/.test(hay)) {
    primary = explicit;
  } else if (/\b(past|last|previous) 90 days\b/.test(hay)) {
    primary = range(addDays(civil, -89), civil, "past 90 days");
  } else if (/\b(past|last|previous) 30 days\b/.test(hay)) {
    primary = range(addDays(civil, -29), civil, "past 30 days");
  } else if (/\b(past|last|previous) 7 days\b/.test(hay)) {
    primary = range(addDays(civil, -6), civil, "past 7 days");
  } else if (/\byesterday\b/.test(hay)) {
    const y = addDays(civil, -1);
    primary = range(y, y, "yesterday");
  } else if (/\btoday\b/.test(hay) && !/\bthis (week|month|quarter|year)\b/.test(hay)) {
    primary = range(civil, civil, "today");
  } else if (/\blast year\b/.test(hay)) {
    const prev = { year: civil.year - 1, month: 1, day: 1 };
    primary = range(startOfYear(prev), endOfYear(prev), "last year");
    pnl = { periods: 1, timeframe: "YEAR" };
  } else if (/\bthis year\b/.test(hay)) {
    primary = range(startOfYear(civil), civil, "this year");
    pnl = { periods: 1, timeframe: "YEAR" };
  } else if (/\blast quarter\b/.test(hay)) {
    const prev = addMonths(startOfQuarter(civil), -3);
    primary = range(startOfQuarter(prev), endOfQuarter(prev), "last quarter");
    pnl = { periods: 1, timeframe: "QUARTER" };
  } else if (/\bthis quarter\b/.test(hay)) {
    primary = range(startOfQuarter(civil), civil, "this quarter");
    pnl = { periods: 1, timeframe: "QUARTER" };
  } else if (/\bthis week\b/.test(hay)) {
    primary = range(startOfWeek(civil), civil, "this week");
  } else if (/\blast week\b/.test(hay)) {
    const prev = addDays(startOfWeek(civil), -7);
    primary = range(prev, endOfWeek(prev), "last week");
  } else if (/\bthis month\b/.test(hay)) {
    primary = range(startOfMonth(civil), civil, "this month");
    pnl = { periods: 1, timeframe: "MONTH" };
  } else if (/\blast month\b/.test(hay)) {
    const prev = addMonths(startOfMonth(civil), -1);
    primary = range(startOfMonth(prev), endOfMonth(prev), "last month");
    pnl = { periods: 1, timeframe: "MONTH" };
  } else {
    const explicit = extractExplicitDates(hay, civil.year);
    if (explicit.length >= 2) {
      const ordered = [...explicit].sort((a, b) => formatCivilDate(a).localeCompare(formatCivilDate(b)));
      const start = ordered[0];
      const end = ordered[ordered.length - 1];
      primary = range(start, end, `${formatCivilDate(start)} to ${formatCivilDate(end)}`);
    } else if (explicit.length === 1) {
      primary = range(explicit[0], explicit[0], formatCivilDate(explicit[0]));
    } else {
      primary = range(startOfMonth(civil), civil, "this month");
      pnl = { periods: 1, timeframe: "MONTH" };
    }
  }

  if (comparisonRequested) {
    if (primary.label === "this month" || /\bthis month\b/.test(hay)) {
      const prev = addMonths(startOfMonth(civil), -1);
      comparison = { ...range(startOfMonth(prev), endOfMonth(prev), "last month") };
      pnl = { periods: 2, timeframe: "MONTH" };
    } else if (primary.label === "this quarter") {
      const prev = addMonths(startOfQuarter(civil), -3);
      comparison = { ...range(startOfQuarter(prev), endOfQuarter(prev), "last quarter") };
      pnl = { periods: 2, timeframe: "QUARTER" };
    } else if (primary.label === "this year") {
      const prev = { year: civil.year - 1, month: 1, day: 1 };
      comparison = { ...range(startOfYear(prev), endOfYear(prev), "last year") };
      pnl = { periods: 2, timeframe: "YEAR" };
    } else if (primary.label === "this week") {
      const prev = addDays(startOfWeek(civil), -7);
      comparison = { ...range(prev, endOfWeek(prev), "last week") };
    }
  }

  return {
    ...primary,
    comparisonRequested,
    comparisonSupported: Boolean(comparison && pnl && (pnl.periods ?? 1) >= 2),
    comparison,
    pnl,
  };
}

export function businessSystemArgs(toolName: string | null | undefined, period: ResolvedPeriod): BusinessSystemArgs {
  const args: BusinessSystemArgs = {
    fromDate: period.fromDate,
    toDate: period.toDate,
    periodLabel: period.label,
  };
  if (period.comparisonRequested) {
    args.comparisonRequested = true;
    args.comparisonSupported = Boolean(
      toolName === "xero_profit_and_loss" && period.comparison && period.pnl && period.pnl.periods >= 2,
    );
    if (period.comparison) {
      args.comparisonFromDate = period.comparison.fromDate;
      args.comparisonToDate = period.comparison.toDate;
      args.comparisonLabel = period.comparison.label;
    }
  }
  if (toolName === "xero_profit_and_loss" && period.pnl) {
    args.periods = period.pnl.periods;
    args.timeframe = period.pnl.timeframe;
  }
  return args;
}

export function needsBusinessDates(toolName: string | null | undefined): boolean {
  return (
    toolName === "xero_sales_summary" ||
    toolName === "xero_profit_and_loss" ||
    toolName === "xero_search_invoices" ||
    toolName === "xero_top_customers" ||
    toolName === "xero_list_overdue_invoices" ||
    toolName === "xero_top_suppliers" ||
    toolName === "xero_list_payments" ||
    toolName === "xero_list_bank_transactions"
  );
}

export function withResolvedBusinessDates(
  toolName: string,
  args: Record<string, unknown>,
  text: string,
  now = new Date(),
): Record<string, unknown> {
  if (!needsBusinessDates(toolName)) return args;
  const hasDates = String(args.fromDate ?? "").trim() && String(args.toDate ?? "").trim();
  if (hasDates) return args;
  if (
    args.unpaidOnly === true ||
    args.outstanding === true ||
    args.overdue === true ||
    args.overdueOnly === true
  ) {
    return args;
  }
  const periodText = [
    text,
    typeof args.period === "string" ? args.period.replace(/_/g, " ") : "",
    typeof args.query === "string" ? args.query : "",
  ]
    .filter((value) => value && value.trim())
    .join(" ");
  const period = resolveBusinessPeriod(periodText, now);
  return { ...args, ...businessSystemArgs(toolName, period) };
}
