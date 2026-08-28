import { describe, expect, it } from "vitest";
import {
  deduplicateOperationalIncidents,
  formatIncidentOccurrenceSummary,
  worstOperationalState,
  worstOperationalSeverity,
} from "@infra/shared";

describe("operational incident deduplication", () => {
  it("groups repeated incidents in the same window", () => {
    const result = deduplicateOperationalIncidents([
      {
        id: "a1",
        severity: "WARNING",
        companyId: "co_caddington",
        companyName: "Caddington",
        subsystem: "microsoft",
        category: "PROVIDER",
        title: "Microsoft sync failed",
        summary: "Delta sync failed",
        recommendedAction: "Review logs",
        href: null,
        observedAt: "2026-08-28T10:00:00.000Z",
      },
      {
        id: "a2",
        severity: "WARNING",
        companyId: "co_caddington",
        companyName: "Caddington",
        subsystem: "microsoft",
        category: "PROVIDER",
        title: "Microsoft sync failed",
        summary: "Delta sync failed",
        recommendedAction: "Review logs",
        href: null,
        observedAt: "2026-08-28T10:30:00.000Z",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.occurrenceCount).toBe(2);
  });

  it("formats occurrence summary for repeated incidents", () => {
    const summary = formatIncidentOccurrenceSummary({
      id: "x",
      severity: "WARNING",
      companyId: null,
      companyName: null,
      subsystem: "platform",
      category: "INTERNAL",
      title: "Test",
      summary: "Failure",
      occurrenceCount: 5,
      firstObservedAt: "2026-08-28T08:00:00.000Z",
      lastObservedAt: "2026-08-28T10:00:00.000Z",
      recommendedAction: "Inspect",
      resolved: false,
      href: null,
    });
    expect(summary).toContain("5 occurrences");
  });
});

describe("operational health aggregation", () => {
  it("selects the worst state", () => {
    expect(worstOperationalState(["HEALTHY", "DEGRADED", "HEALTHY"])).toBe("DEGRADED");
    expect(worstOperationalState(["HEALTHY", "OUTAGE"])).toBe("OUTAGE");
  });

  it("selects the worst severity", () => {
    expect(worstOperationalSeverity(["INFO", "WARNING", "CRITICAL"])).toBe("CRITICAL");
  });
});
