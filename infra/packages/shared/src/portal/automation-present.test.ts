import { describe, expect, it } from "vitest";
import {
  humanAutomationCustomerStatus,
  humanAutomationRunCustomerStatus,
  humanAutomationSchedule,
} from "./automation-present";

describe("humanAutomationSchedule", () => {
  it("uses business language for weekday schedules", () => {
    expect(
      humanAutomationSchedule({
        triggerType: "schedule",
        schedule: { frequency: "weekdays", hour: 8, minute: 0 },
        timezone: "Europe/London",
      }),
        ).toBe("Every weekday at 08:00");
  });

  it("describes manual triggers", () => {
    expect(
      humanAutomationSchedule({ triggerType: "manual", schedule: undefined, timezone: "UTC" }),
    ).toBe("Runs when you start it");
  });
});

describe("humanAutomationCustomerStatus", () => {
  it("maps error to needs attention", () => {
    expect(humanAutomationCustomerStatus("error")).toBe("Needs attention");
  });

  it("maps archived status", () => {
    expect(humanAutomationCustomerStatus("archived")).toBe("Archived");
  });
});

describe("humanAutomationRunCustomerStatus", () => {
  it("maps queued to running for customers", () => {
    expect(humanAutomationRunCustomerStatus("queued")).toBe("Running");
  });
});
