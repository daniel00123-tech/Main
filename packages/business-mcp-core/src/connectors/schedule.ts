import { HOURLY_UTC_CRON_EXPRESSION } from "../version";

export interface ScheduledSyncConfig {
  enabled: boolean;
  timezone: string;
  localHour: number;
  localMinute: number;
  lastScheduledScanDate: string | null;
}

export interface LocalTimeParts {
  calendarDate: string;
  hour: number;
  minute: number;
}

export function getLocalTimeParts(
  date: Date,
  timeZone: string
): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    calendarDate: `${lookup.year}-${lookup.month}-${lookup.day}`,
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
  };
}

export function isScheduledSyncTime(
  date: Date,
  config: Pick<ScheduledSyncConfig, "localHour" | "localMinute" | "timezone">
): boolean {
  const local = getLocalTimeParts(date, config.timezone);
  return local.hour === config.localHour && local.minute === config.localMinute;
}

export function parseScheduledSyncConfig(
  parsed: Record<string, unknown>,
  defaults?: Partial<ScheduledSyncConfig>
): ScheduledSyncConfig {
  const raw =
    parsed.scheduledSync && typeof parsed.scheduledSync === "object"
      ? (parsed.scheduledSync as Record<string, unknown>)
      : parsed;

  return {
    enabled: raw.enabled !== false,
    timezone:
      typeof raw.timezone === "string" && raw.timezone.trim()
        ? raw.timezone.trim()
        : (defaults?.timezone ?? "Europe/London"),
    localHour:
      typeof raw.localHour === "number"
        ? raw.localHour
        : (defaults?.localHour ?? 12),
    localMinute:
      typeof raw.localMinute === "number"
        ? raw.localMinute
        : (defaults?.localMinute ?? 0),
    lastScheduledScanDate:
      typeof raw.lastScheduledScanDate === "string" &&
      raw.lastScheduledScanDate.trim()
        ? raw.lastScheduledScanDate.trim()
        : null,
  };
}

export function shouldRunScheduledSync(
  schedule: ScheduledSyncConfig,
  scheduledTimeMs: number
): { run: boolean; reason: string; local: LocalTimeParts } {
  const now = new Date(scheduledTimeMs);
  const local = getLocalTimeParts(now, schedule.timezone);

  if (!schedule.enabled) {
    return { run: false, reason: "scheduled_sync_disabled", local };
  }

  if (!isScheduledSyncTime(now, schedule)) {
    return { run: false, reason: "outside_scheduled_window", local };
  }

  if (schedule.lastScheduledScanDate === local.calendarDate) {
    return { run: false, reason: "already_ran_today", local };
  }

  return { run: true, reason: "due", local };
}

export function describeTimezoneScheduleHandling(
  schedule: Pick<ScheduledSyncConfig, "timezone" | "localHour" | "localMinute">,
  cronExpression = HOURLY_UTC_CRON_EXPRESSION
): string {
  const minute = String(schedule.localMinute).padStart(2, "0");
  return (
    `Cron fires hourly at minute 0 UTC (${cronExpression}). ` +
    `The scheduled handler checks ${schedule.timezone} local time via Intl and only runs when local time is ${schedule.localHour}:${minute}, ` +
    `handling DST transitions automatically. ` +
    `A daily lock (lastScheduledScanDate in local calendar date) prevents duplicate runs.`
  );
}

export function withRecordedScanDate(
  existingConfig: Record<string, unknown>,
  schedule: ScheduledSyncConfig,
  calendarDate: string
): Record<string, unknown> {
  return {
    ...existingConfig,
    scheduledSync: {
      ...schedule,
      lastScheduledScanDate: calendarDate,
    },
  };
}
