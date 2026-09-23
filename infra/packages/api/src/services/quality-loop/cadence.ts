import type { QualityLoopKind, QualityLoopPhase } from "./types";
export const QUALITY_LOOP_TIMEZONE = "Europe/London";
export const PHASE1_DAYS = 60;
export const DAILY_HOUR = 8;
export const WEEKLY_WEEKDAY = 5; // Friday, ISO 1=Mon … 7=Sun → JS getUTCDay 5=Friday

export interface QualityLoopCadenceState {
  activatedAt: string;
  phase: QualityLoopPhase;
  lastRunAt?: string | null;
  lastPeriodFrom?: string | null;
  lastPeriodTo?: string | null;
  lastCadence?: string | null;
  baselineCompletedAt?: string | null;
}

export interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun … 6=Sat
  isoDate: string;
}

export function londonParts(at: Date | string | number): LondonParts {
  const date = at instanceof Date ? at : new Date(at);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: QUALITY_LOOP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday ?? ""] ?? date.getUTCDay(),
    isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function resolvePhase(activatedAt: string, now: Date | string | number, phase1Days = PHASE1_DAYS): QualityLoopPhase {
  const start = new Date(activatedAt).getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) return "daily";
  const elapsedDays = (current - start) / 86_400_000;
  return elapsedDays >= phase1Days ? "weekly" : "daily";
}

export function previousCompleteLondonDay(now: Date | string | number): { from: string; to: string } {
  const parts = londonParts(now);
  const todayStart = londonDateUtc(parts.year, parts.month, parts.day, 0, 0);
  const from = new Date(todayStart.getTime() - 86_400_000);
  return { from: from.toISOString(), to: todayStart.toISOString() };
}

export function previousCompleteLondonWeek(now: Date | string | number): { from: string; to: string } {
  const parts = londonParts(now);
  const todayStart = londonDateUtc(parts.year, parts.month, parts.day, 0, 0);
  const from = new Date(todayStart.getTime() - 7 * 86_400_000);
  return { from: from.toISOString(), to: todayStart.toISOString() };
}

function londonDateUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = londonParts(guess);
  const offsetMs =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess - offsetMs);
}

export function shouldRunCadence(
  state: QualityLoopCadenceState,
  now: Date | string | number,
): { run: boolean; kind: QualityLoopKind; phase: QualityLoopPhase; period: { from: string; to: string } } {
  const phase = resolvePhase(state.activatedAt, now);
  const parts = londonParts(now);
  const inWindow = parts.hour === DAILY_HOUR && parts.minute < 15;
  if (!inWindow) {
    return { run: false, kind: phase, phase, period: phase === "weekly" ? previousCompleteLondonWeek(now) : previousCompleteLondonDay(now) };
  }
  if (phase === "weekly" && parts.weekday !== WEEKLY_WEEKDAY) {
    return { run: false, kind: "weekly", phase, period: previousCompleteLondonWeek(now) };
  }
  const period = phase === "weekly" ? previousCompleteLondonWeek(now) : previousCompleteLondonDay(now);
  if (state.lastPeriodFrom === period.from && state.lastPeriodTo === period.to) {
    return { run: false, kind: phase, phase, period };
  }
  return { run: true, kind: phase, phase, period };
}

export function cadenceDescription(phase: QualityLoopPhase): string {
  if (phase === "weekly") {
    return "Weekly Friday 08:00 Europe/London (auto-changed after 60 days)";
  }
  return "Daily 08:00 Europe/London, auto-changes to weekly after 60 days";
}
