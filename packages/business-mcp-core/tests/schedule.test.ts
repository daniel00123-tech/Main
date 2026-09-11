import { describe, expect, it } from "vitest";
import {
  getLocalTimeParts,
  isScheduledSyncTime,
  parseScheduledSyncConfig,
  shouldRunScheduledSync,
} from "../src/connectors/schedule";
import { HOURLY_UTC_CRON_EXPRESSION } from "../src/version";

describe("connector schedule", () => {
  it("uses hourly UTC cron constant", () => {
    expect(HOURLY_UTC_CRON_EXPRESSION).toBe("0 * * * *");
  });

  it("detects 12:00 Europe/London during GMT", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    const config = {
      timezone: "Europe/London",
      localHour: 12,
      localMinute: 0,
      enabled: true,
      lastScheduledScanDate: null,
    };
    expect(isScheduledSyncTime(date, config)).toBe(true);
    expect(getLocalTimeParts(date, "Europe/London")).toMatchObject({
      calendarDate: "2026-01-15",
      hour: 12,
      minute: 0,
    });
  });

  it("detects 12:00 Europe/London during BST", () => {
    const date = new Date("2026-08-24T11:00:00.000Z");
    const config = {
      timezone: "Europe/London",
      localHour: 12,
      localMinute: 0,
      enabled: true,
      lastScheduledScanDate: null,
    };
    expect(isScheduledSyncTime(date, config)).toBe(true);
  });

  it("respects daily lock", () => {
    const config = {
      enabled: true,
      timezone: "Europe/London",
      localHour: 12,
      localMinute: 0,
      lastScheduledScanDate: "2026-08-24",
    };
    const result = shouldRunScheduledSync(
      config,
      new Date("2026-08-24T11:00:00.000Z").getTime()
    );
    expect(result.run).toBe(false);
    expect(result.reason).toBe("already_ran_today");
  });

  it("parses scheduledSync config", () => {
    const config = parseScheduledSyncConfig({
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
