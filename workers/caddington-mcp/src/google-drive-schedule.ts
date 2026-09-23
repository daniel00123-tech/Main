import type { Env } from "./db";
import { log } from "./logger";

export const GOOGLE_DRIVE_SCHEDULE_TIMEZONE = "Europe/London";
export const GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR = 12;
export const GOOGLE_DRIVE_SCHEDULE_LOCAL_MINUTE = 0;
/** Hourly UTC cron; London noon gate runs inside the scheduled handler. */
export const GOOGLE_DRIVE_CRON_EXPRESSION = "0 * * * *";

export interface GoogleDriveScheduleConfig {
  enabled: boolean;
  timezone: string;
  localHour: number;
  localMinute: number;
  lastScheduledScanDate: string | null;
}

export interface LondonLocalTimeParts {
  calendarDate: string;
  hour: number;
  minute: number;
}

export function getLondonLocalTimeParts(
  date: Date,
  timeZone = GOOGLE_DRIVE_SCHEDULE_TIMEZONE
): LondonLocalTimeParts {
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

export function isLondonScheduledSyncTime(
  date: Date,
  config: Pick<GoogleDriveScheduleConfig, "localHour" | "localMinute"> = {
    localHour: GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR,
    localMinute: GOOGLE_DRIVE_SCHEDULE_LOCAL_MINUTE,
  }
): boolean {
  const local = getLondonLocalTimeParts(date);
  return local.hour === config.localHour && local.minute === config.localMinute;
}

const CONNECTOR_CODE = "google_drive";

function defaultScheduleConfig(): GoogleDriveScheduleConfig {
  return {
    enabled: true,
    timezone: GOOGLE_DRIVE_SCHEDULE_TIMEZONE,
    localHour: GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR,
    localMinute: GOOGLE_DRIVE_SCHEDULE_LOCAL_MINUTE,
    lastScheduledScanDate: null,
  };
}

export function parseGoogleDriveScheduleConfig(
  parsed: Record<string, unknown>
): GoogleDriveScheduleConfig {
  const raw =
    parsed.scheduledSync && typeof parsed.scheduledSync === "object"
      ? (parsed.scheduledSync as Record<string, unknown>)
      : parsed;

  return {
    enabled: raw.enabled !== false,
    timezone:
      typeof raw.timezone === "string" && raw.timezone.trim()
        ? raw.timezone.trim()
        : GOOGLE_DRIVE_SCHEDULE_TIMEZONE,
    localHour:
      typeof raw.localHour === "number" ? raw.localHour : GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR,
    localMinute:
      typeof raw.localMinute === "number"
        ? raw.localMinute
        : GOOGLE_DRIVE_SCHEDULE_LOCAL_MINUTE,
    lastScheduledScanDate:
      typeof raw.lastScheduledScanDate === "string" && raw.lastScheduledScanDate.trim()
        ? raw.lastScheduledScanDate.trim()
        : null,
  };
}

async function loadConnectorConfigJson(
  env: Env
): Promise<Record<string, unknown>> {
  const row = await env.CADDINGTON_BUSINESS_DATA.prepare(
    "SELECT config_json FROM connector_config WHERE connector_code = ?"
  )
    .bind(CONNECTOR_CODE)
    .first<{ config_json: string | null }>();

  if (!row?.config_json) {
    return {};
  }

  try {
    return JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function loadGoogleDriveScheduleConfig(
  env: Env
): Promise<GoogleDriveScheduleConfig> {
  const parsed = await loadConnectorConfigJson(env);
  return parseGoogleDriveScheduleConfig(parsed);
}

export async function shouldRunScheduledGoogleDriveScan(
  env: Env,
  scheduledTimeMs: number
): Promise<{ run: boolean; reason: string; local: LondonLocalTimeParts }> {
  const schedule = await loadGoogleDriveScheduleConfig(env);
  const now = new Date(scheduledTimeMs);
  const local = getLondonLocalTimeParts(now, schedule.timezone);

  if (!schedule.enabled) {
    return { run: false, reason: "scheduled_sync_disabled", local };
  }

  if (
    !isLondonScheduledSyncTime(now, {
      localHour: schedule.localHour,
      localMinute: schedule.localMinute,
    })
  ) {
    return { run: false, reason: "outside_london_noon_window", local };
  }

  if (schedule.lastScheduledScanDate === local.calendarDate) {
    return { run: false, reason: "already_ran_today", local };
  }

  return { run: true, reason: "due", local };
}

export async function recordScheduledGoogleDriveScanDate(
  env: Env,
  calendarDate: string
): Promise<void> {
  const parsed = await loadConnectorConfigJson(env);
  const schedule = parseGoogleDriveScheduleConfig(parsed);
  const nextConfig = {
    ...parsed,
    scheduledSync: {
      ...schedule,
      lastScheduledScanDate: calendarDate,
    },
  };

  await env.CADDINGTON_BUSINESS_DATA.prepare(
    `INSERT INTO connector_config (connector_code, config_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(connector_code) DO UPDATE SET
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`
  )
    .bind(CONNECTOR_CODE, JSON.stringify(nextConfig))
    .run();

  log("info", "google_drive_scheduled_scan_date_recorded", {
    calendarDate,
  });
}

export function describeGoogleDriveScheduleHandling(): string {
  return (
    `Cron fires hourly at minute 0 UTC (${GOOGLE_DRIVE_CRON_EXPRESSION}). ` +
    `The scheduled handler checks Europe/London local time via Intl and only runs the metadata scan when local time is ${GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR}:${String(GOOGLE_DRIVE_SCHEDULE_LOCAL_MINUTE).padStart(2, "0")}, ` +
    `so the effective run time stays 12:00 PM UK local through GMT/BST transitions. ` +
    `A D1 daily lock (lastScheduledScanDate in London calendar date) prevents duplicate runs if the trigger fires more than once.`
  );
}

export function defaultGoogleDriveScheduleConfigForStatus(): GoogleDriveScheduleConfig {
  return defaultScheduleConfig();
}
