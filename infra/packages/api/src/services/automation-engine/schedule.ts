/**
 * Timezone-aware schedule computation for Automation Engine V1.
 * Uses Intl for Europe/London BST/GMT transitions without external dependencies.
 */

import type { AutomationSchedule } from "@infra/shared";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function parseAutomationSchedule(raw: string | null | undefined): AutomationSchedule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AutomationSchedule;
    if (!parsed?.frequency) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")) % 24,
    minute: Number(pick("minute")),
    weekday: WEEKDAY_MAP[pick("weekday")] ?? 0,
  };
}

function getTimezoneOffsetMs(instant: Date, timeZone: string): number {
  const utc = new Date(instant.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(instant.toLocaleString("en-US", { timeZone }));
  return local.getTime() - utc.getTime();
}

/** Convert civil local time in `timeZone` to UTC ISO string. */
export function zonedLocalToUtcIso(
  input: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): string {
  let utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  for (let i = 0; i < 2; i++) {
    const offset = getTimezoneOffsetMs(new Date(utcGuess), timeZone);
    utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0) - offset;
  }
  return new Date(utcGuess).toISOString();
}

function matchesSchedule(parts: ZonedParts, schedule: AutomationSchedule): boolean {
  const minute = schedule.minute ?? 0;
  const hour = schedule.hour ?? 0;
  switch (schedule.frequency) {
    case "hourly":
      return parts.minute === minute;
    case "daily":
      return parts.hour === hour && parts.minute === minute;
    case "weekdays":
      return parts.weekday >= 1 && parts.weekday <= 5 && parts.hour === hour && parts.minute === minute;
    case "weekly":
      return parts.weekday === (schedule.dayOfWeek ?? 1) && parts.hour === hour && parts.minute === minute;
    case "monthly":
      return parts.day === (schedule.dayOfMonth ?? 1) && parts.hour === hour && parts.minute === minute;
    default:
      return false;
  }
}

function addLocalCandidate(parts: ZonedParts, schedule: AutomationSchedule): ZonedParts {
  const next = { ...parts };
  switch (schedule.frequency) {
    case "hourly":
      next.minute = schedule.minute ?? 0;
      if (parts.minute >= (schedule.minute ?? 0)) {
        next.hour = parts.hour + 1;
        if (next.hour >= 24) {
          next.hour = 0;
          next.day += 1;
        }
      }
      break;
    case "daily":
    case "weekdays":
    case "weekly":
    case "monthly": {
      next.hour = schedule.hour ?? 0;
      next.minute = schedule.minute ?? 0;
      next.day += 1;
      break;
    }
  }
  return next;
}

export function buildScheduleIdempotencyKey(automationId: string, slotUtcIso: string): string {
  return `${automationId}|${slotUtcIso}`;
}

/**
 * Compute the next UTC run instant strictly after `afterUtc`.
 */
export function computeNextRunUtcIso(
  schedule: AutomationSchedule,
  timeZone: string,
  afterUtc: Date = new Date(),
): string {
  let cursor = new Date(afterUtc.getTime() + 60_000);
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const parts = getZonedParts(cursor, timeZone);
    if (matchesSchedule(parts, schedule)) {
      return zonedLocalToUtcIso(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: parts.hour,
          minute: parts.minute,
        },
        timeZone,
      );
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error("Unable to compute next run within search horizon");
}

/** Slot key for the schedule occurrence at or before now (for idempotency). */
export function currentScheduleSlotUtcIso(
  schedule: AutomationSchedule,
  timeZone: string,
  nowUtc: Date = new Date(),
): string | null {
  let cursor = new Date(nowUtc.getTime() - 24 * 60 * 60_000);
  let lastMatch: string | null = null;
  while (cursor <= nowUtc) {
    const parts = getZonedParts(cursor, timeZone);
    if (matchesSchedule(parts, schedule)) {
      lastMatch = zonedLocalToUtcIso(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: parts.hour,
          minute: parts.minute,
        },
        timeZone,
      );
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return lastMatch;
}

export function formatScheduleLabel(schedule: AutomationSchedule, timezone: string): string {
  const minute = String(schedule.minute ?? 0).padStart(2, "0");
  const hour = String(schedule.hour ?? 0).padStart(2, "0");
  switch (schedule.frequency) {
    case "hourly":
      return `Hourly at :${minute} (${timezone})`;
    case "daily":
      return `Daily at ${hour}:${minute} (${timezone})`;
    case "weekdays":
      return `Weekdays at ${hour}:${minute} (${timezone})`;
    case "weekly":
      return `Weekly (day ${schedule.dayOfWeek ?? 1}) at ${hour}:${minute} (${timezone})`;
    case "monthly":
      return `Monthly (day ${schedule.dayOfMonth ?? 1}) at ${hour}:${minute} (${timezone})`;
    default:
      return schedule.frequency;
  }
}
