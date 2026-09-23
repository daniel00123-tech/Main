import { describe, expect, it } from "vitest";
import { overheadActiveInPeriod, summariseOverheads } from "./platform-overheads";

describe("platform overheads", () => {
  it("does not treat overheads as tenant-allocated", () => {
    const items = [
      {
        id: "oh_1",
        provider: "Cursor",
        description: "Development",
        monthlyCostCents: 3200,
        currency: "GBP",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: null,
        category: "development_tooling",
        createdBy: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(overheadActiveInPeriod(items[0]!, "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z")).toBe(true);
    expect(summariseOverheads(items, "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z")).toEqual({
      monthlyCostCents: 3200,
      activeCount: 1,
      currency: "GBP",
    });
  });
});
