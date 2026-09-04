import { describe, expect, it } from "vitest";
import { computeNextRunUtcIso } from "./schedule";

describe("knowledge activity schedule timezone", () => {
  it("keeps 08:00 Europe/London on GMT and BST rather than a fixed UTC hour", () => {
    const schedule = { frequency: "daily" as const, hour: 8, minute: 0 };
    expect(computeNextRunUtcIso(schedule, "Europe/London", new Date("2026-01-04T00:00:00.000Z"))).toBe(
      "2026-01-04T08:00:00.000Z",
    );
    expect(computeNextRunUtcIso(schedule, "Europe/London", new Date("2026-07-04T00:00:00.000Z"))).toBe(
      "2026-07-04T07:00:00.000Z",
    );
  });
});
