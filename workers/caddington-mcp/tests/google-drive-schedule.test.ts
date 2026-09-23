import { describe, expect, it } from "vitest";
import {
  GOOGLE_DRIVE_CRON_EXPRESSION,
  GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR,
  getLondonLocalTimeParts,
  isLondonScheduledSyncTime,
  parseGoogleDriveScheduleConfig,
} from "../src/google-drive-schedule";

describe("Google Drive schedule", () => {
  it("uses hourly UTC cron for London noon gating", () => {
    expect(GOOGLE_DRIVE_CRON_EXPRESSION).toBe("0 * * * *");
    expect(GOOGLE_DRIVE_SCHEDULE_LOCAL_HOUR).toBe(12);
  });

  it("detects 12:00 Europe/London during GMT", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    expect(isLondonScheduledSyncTime(date)).toBe(true);
    expect(getLondonLocalTimeParts(date)).toMatchObject({
      calendarDate: "2026-01-15",
      hour: 12,
      minute: 0,
    });
  });

  it("detects 12:00 Europe/London during BST", () => {
    const date = new Date("2026-08-24T11:00:00.000Z");
    expect(isLondonScheduledSyncTime(date)).toBe(true);
    expect(getLondonLocalTimeParts(date)).toMatchObject({
      calendarDate: "2026-08-24",
      hour: 12,
      minute: 0,
    });
  });

  it("does not run at other UTC hours that are not London noon", () => {
    expect(isLondonScheduledSyncTime(new Date("2026-08-24T12:00:00.000Z"))).toBe(
      false
    );
    expect(isLondonScheduledSyncTime(new Date("2026-01-15T11:00:00.000Z"))).toBe(
      false
    );
  });

  it("parses scheduledSync config from connector_config", () => {
    const config = parseGoogleDriveScheduleConfig({
      scheduledSync: {
        enabled: true,
        timezone: "Europe/London",
        localHour: 12,
        localMinute: 0,
        lastScheduledScanDate: "2026-08-24",
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.lastScheduledScanDate).toBe("2026-08-24");
  });
});
