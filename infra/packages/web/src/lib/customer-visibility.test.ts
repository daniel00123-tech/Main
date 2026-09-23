import { describe, expect, it } from "vitest";
import {
  automationSchedulePreview,
  filterCustomerActions,
  filterCustomerAutomations,
  isInternalTestAction,
  isInternalTestAutomationName,
} from "./customer-visibility";

describe("customer visibility", () => {
  it("hides named INFRA test automations from customers", () => {
    expect(isInternalTestAutomationName("INFRA Automation Scheduler Test")).toBe(true);
    expect(isInternalTestAutomationName("INFRA Automation Engine Test")).toBe(true);
    expect(isInternalTestAutomationName("Daily sales email")).toBe(false);
    expect(
      filterCustomerAutomations(
        [{ name: "INFRA Automation Engine Test" }, { name: "Month-to-date sales" }],
        false,
      ),
    ).toEqual([{ name: "Month-to-date sales" }]);
    expect(
      filterCustomerAutomations([{ name: "INFRA Automation Engine Test" }], true),
    ).toHaveLength(1);
  });

  it("hides historic test invoice actions from customers", () => {
    expect(
      isInternalTestAction({ summary: "Historic test invoice draft", requestedAction: "xero.invoice.create" }),
    ).toBe(true);
    expect(
      filterCustomerActions([{ summary: "Send invoice to Acme", requestedAction: "xero.invoice.send" }], false),
    ).toHaveLength(1);
  });

  it("explains automation schedules in plain English", () => {
    expect(automationSchedulePreview({ frequency: "weekdays", time: "08:00", timezone: "Europe/London" })).toBe(
      "Runs every weekday at 08:00 Europe/London.",
    );
  });
});
