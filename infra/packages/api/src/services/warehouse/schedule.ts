/**
 * DST-safe EL Xero warehouse schedule.
 * Europe/London local civil time is authoritative. UTC offsets are derived, never hardcoded.
 */

import { getZonedParts, zonedLocalToUtcIso } from "../automation-engine/schedule";
import {
  WAREHOUSE_SLOTS_PER_WEEK,
  WAREHOUSE_TIMEZONE,
  WAREHOUSE_WEEKDAY_HOURS,
  WAREHOUSE_WEEKEND_HOURS,
} from "./standard";

export type WarehouseSlot = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  localIso: string;
  utcIso: string;
};

function hoursForWeekday(weekday: number): readonly number[] {
  return weekday >= 1 && weekday <= 5 ? WAREHOUSE_WEEKDAY_HOURS : WAREHOUSE_WEEKEND_HOURS;
}

export function isWarehouseLocalSlot(parts: {
  weekday: number;
  hour: number;
  minute: number;
}): boolean {
  if (parts.minute !== 0) return false;
  return hoursForWeekday(parts.weekday).includes(parts.hour);
}

export function warehouseSlotsPerWeek(): number {
  return WAREHOUSE_SLOTS_PER_WEEK;
}

function slotFromParts(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}): WarehouseSlot {
  const utcIso = zonedLocalToUtcIso(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
    },
    WAREHOUSE_TIMEZONE,
  );
  const localIso = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:00`;
  return { ...parts, localIso, utcIso };
}

function addLocalDays(parts: {
  year: number;
  month: number;
  day: number;
}, days: number): { year: number; month: number; day: number; weekday: number } {
  const utc = zonedLocalToUtcIso(
    { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0 },
    WAREHOUSE_TIMEZONE,
  );
  const shifted = new Date(Date.parse(utc) + days * 24 * 60 * 60 * 1000);
  const next = getZonedParts(shifted, WAREHOUSE_TIMEZONE);
  return { year: next.year, month: next.month, day: next.day, weekday: next.weekday };
}

/** Next warehouse slot strictly after `afterUtc`. */
export function computeNextWarehouseSyncUtcIso(
  afterUtc: Date = new Date(),
  timeZone = WAREHOUSE_TIMEZONE,
): string {
  return computeNextWarehouseSlot(afterUtc, timeZone).utcIso;
}

export function computeNextWarehouseSlot(
  afterUtc: Date = new Date(),
  timeZone = WAREHOUSE_TIMEZONE,
): WarehouseSlot {
  let cursor = new Date(afterUtc.getTime() + 60_000);
  for (let i = 0; i < 60 * 24 * 21; i++) {
    const parts = getZonedParts(cursor, timeZone);
    if (isWarehouseLocalSlot(parts)) {
      return slotFromParts(parts);
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error("Unable to compute next warehouse slot within search horizon");
}

/** Slot at or immediately before now, if we are inside the catch-up window. */
export function currentWarehouseSlot(
  nowUtc: Date = new Date(),
  options?: { catchUpMinutes?: number; timeZone?: string },
): WarehouseSlot | null {
  const timeZone = options?.timeZone ?? WAREHOUSE_TIMEZONE;
  const catchUpMinutes = options?.catchUpMinutes ?? 90;
  const parts = getZonedParts(nowUtc, timeZone);
  if (isWarehouseLocalSlot(parts)) return slotFromParts(parts);

  for (const hour of [...hoursForWeekday(parts.weekday)].reverse()) {
    if (hour > parts.hour) continue;
    const candidate = slotFromParts({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute: 0,
      weekday: parts.weekday,
    });
    const ageMin = (nowUtc.getTime() - Date.parse(candidate.utcIso)) / 60_000;
    if (ageMin >= 0 && ageMin <= catchUpMinutes) return candidate;
  }

  const previous = addLocalDays(parts, -1);
  const prevHours = hoursForWeekday(previous.weekday);
  const hour = prevHours[prevHours.length - 1];
  const candidate = slotFromParts({
    year: previous.year,
    month: previous.month,
    day: previous.day,
    hour,
    minute: 0,
    weekday: previous.weekday,
  });
  const ageMin = (nowUtc.getTime() - Date.parse(candidate.utcIso)) / 60_000;
  if (ageMin >= 0 && ageMin <= catchUpMinutes) return candidate;
  return null;
}

export function listWarehouseSlotsForLocalWeek(anchorUtc: Date, timeZone = WAREHOUSE_TIMEZONE): WarehouseSlot[] {
  const parts = getZonedParts(anchorUtc, timeZone);
  const mondayOffset = parts.weekday === 0 ? -6 : 1 - parts.weekday;
  const monday = addLocalDays(parts, mondayOffset);
  const slots: WarehouseSlot[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addLocalDays(monday, i);
    for (const hour of hoursForWeekday(day.weekday)) {
      slots.push(
        slotFromParts({
          year: day.year,
          month: day.month,
          day: day.day,
          hour,
          minute: 0,
          weekday: day.weekday,
        }),
      );
    }
  }
  return slots;
}

export function warehouseScheduleIdempotencyKey(
  companyId: string,
  connector: string,
  slotUtcIso: string,
): string {
  return `${companyId}|${connector}|${slotUtcIso}`;
}

export function describeWarehouseSchedule(): {
  timezone: string;
  weekdayHours: readonly number[];
  weekendHours: readonly number[];
  slotsPerWeek: number;
  overnight: false;
  extraWeekend: false;
  hourly: false;
} {
  return {
    timezone: WAREHOUSE_TIMEZONE,
    weekdayHours: WAREHOUSE_WEEKDAY_HOURS,
    weekendHours: WAREHOUSE_WEEKEND_HOURS,
    slotsPerWeek: WAREHOUSE_SLOTS_PER_WEEK,
    overnight: false,
    extraWeekend: false,
    hourly: false,
  };
}
