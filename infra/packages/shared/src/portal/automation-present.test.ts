import { describe, expect, it } from "vitest";
import {
  automationRunNowNeedsConfirmation,
  humanAutomationCustomerStatus,
  humanAutomationRunCustomerStatus,
  humanAutomationRunTrigger,
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
  it("maps queued, running, completed and failed distinctly", () => {
    expect(humanAutomationRunCustomerStatus("queued")).toBe("Queued");
    expect(humanAutomationRunCustomerStatus("running")).toBe("Running");
    expect(humanAutomationRunCustomerStatus("completed")).toBe("Completed");
    expect(humanAutomationRunCustomerStatus("failed")).toBe("Failed");
  });
});

describe("humanAutomationRunTrigger", () => {
  it("distinguishes scheduled, portal and MCP manual runs", () => {
    expect(humanAutomationRunTrigger("schedule")).toBe("Scheduled");
    expect(humanAutomationRunTrigger("portal_manual")).toBe("Run now (portal)");
    expect(humanAutomationRunTrigger("mcp_manual")).toBe("Run now (ChatGPT)");
  });
});

describe("automationRunNowNeedsConfirmation", () => {
  it("requires confirmation when a report email will be sent", () => {
    expect(
      automationRunNowNeedsConfirmation({
        recipientEmail: "ops@example.com",
        actionType: "internal",
      }),
    ).toBe(true);
  });
});
