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

export function resolveBusinessPeriod(
  text: string,
  now = new Date(),
  timeZone = INTELLIGENCE_PERIOD_TZ,
): ResolvedPeriod {
  const today = londonCivilParts(now, timeZone);
  const civil: CivilDate = { year: today.year, month: today.month, day: today.day };
  const hay = String(text ?? "").toLowerCase();
  const comparisonRequested = /\b(compar(e|ed|ing)|versus|vs\.?|against|this (month|week|quarter|year) (and|with|vs) last)\b/i.test(
    hay,
  );

  let primary = range(startOfMonth(civil), civil, "this month");
  let comparison: ResolvedPeriod["comparison"];
  let pnl: ResolvedPeriod["pnl"];

  if (/\b(past|last|previous) 90 days\b/.test(hay)) {
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
    primary = range(startOfMonth(civil), civil, "this month");
    pnl = { periods: 1, timeframe: "MONTH" };
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
    toolName === "xero_search_invoices"
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
  const period = resolveBusinessPeriod(text, now);
  return { ...args, ...businessSystemArgs(toolName, period) };
}
