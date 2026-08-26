import { describe, expect, it } from "vitest";
import { isActionAllowed } from "./role-presets";

describe("company role presets", () => {
  it("allows engineer to read assigned schedule but not book jobs", () => {
    expect(isActionAllowed("engineer", "bigchange.engineers.schedule.read")).toBe(true);
    expect(isActionAllowed("engineer", "bigchange.jobs.book_engineer")).toBe(false);
  });

  it("allows office staff to book engineers and create POs", () => {
    expect(isActionAllowed("office_staff", "bigchange.jobs.book_engineer")).toBe(true);
    expect(isActionAllowed("office_staff", "bigchange.purchase_orders.create")).toBe(true);
  });

  it("denies office staff invoice creation", () => {
    expect(isActionAllowed("office_staff", "bigchange.invoices.create")).toBe(false);
  });

  it("allows manager to create invoices", () => {
    expect(isActionAllowed("manager", "bigchange.invoices.create")).toBe(true);
  });
});
