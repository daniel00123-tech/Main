import { describe, expect, it } from "vitest";
import {
  buildScheduleIdempotencyKey,
  computeNextRunUtcIso,
  currentScheduleSlotUtcIso,
  formatScheduleLabel,
  getZonedParts,
  zonedLocalToUtcIso,
} from "./schedule";
import { validateAutomationConfiguration } from "./actions/index";
import {
  AUTOMATION_RUN_DLQ,
  AUTOMATION_RUN_QUEUE,
} from "./queue";
import { canManageAutomations, canViewAutomations } from "./permissions";
import type { SessionUser } from "../../auth/session";

describe("Automation schedule (timezone)", () => {
  it("computes Europe/London daily 08:00 with BST offset", () => {
    const schedule = { frequency: "daily" as const, hour: 8, minute: 0 };
    const next = computeNextRunUtcIso(
      schedule,
      "Europe/London",
      new Date("2026-06-15T06:00:00.000Z"),
    );
    const parts = getZonedParts(new Date(next), "Europe/London");
    expect(parts.hour).toBe(8);
    expect(parts.minute).toBe(0);
  });

  it("handles GMT to BST transition without storing fixed UTC hour", () => {
    const schedule = { frequency: "daily" as const, hour: 8, minute: 0 };
    const winter = computeNextRunUtcIso(
      schedule,
      "Europe/London",
      new Date("2026-01-15T07:00:00.000Z"),
    );
    const summer = computeNextRunUtcIso(
      schedule,
      "Europe/London",
      new Date("2026-06-15T06:00:00.000Z"),
    );
    const winterUtcHour = new Date(winter).getUTCHours();
    const summerUtcHour = new Date(summer).getUTCHours();
    expect(winterUtcHour).not.toBe(summerUtcHour);
    expect(getZonedParts(new Date(winter), "Europe/London").hour).toBe(8);
    expect(getZonedParts(new Date(summer), "Europe/London").hour).toBe(8);
  });

  it("builds deterministic idempotency keys", () => {
    const key = buildScheduleIdempotencyKey("aut_test", "2026-08-28T07:00:00.000Z");
    expect(key).toBe("aut_test|2026-08-28T07:00:00.000Z");
  });

  it("finds current schedule slot at or before now", () => {
    const schedule = { frequency: "hourly" as const, minute: 0 };
    const now = new Date("2026-08-28T09:37:00.000Z");
    const slot = currentScheduleSlotUtcIso(schedule, "UTC", now);
    expect(slot).toBe("2026-08-28T09:00:00.000Z");
  });

  it("formats schedule labels", () => {
    expect(
      formatScheduleLabel({ frequency: "weekdays", hour: 8, minute: 30 }, "Europe/London"),
    ).toContain("Weekdays");
  });

  it("converts zoned local time to UTC", () => {
    const iso = zonedLocalToUtcIso(
      { year: 2026, month: 1, day: 15, hour: 8, minute: 0 },
      "Europe/London",
    );
    expect(iso.endsWith("Z")).toBe(true);
  });
});

describe("Automation action validation", () => {
  it("requires non-empty AI prompt", () => {
    expect(validateAutomationConfiguration("ai_prompt", { prompt: "" })).toMatch(/prompt/i);
    expect(validateAutomationConfiguration("ai_prompt", { prompt: "Hello" })).toBeNull();
  });

  it("rejects URL injection in MCP tool names", () => {
    expect(validateAutomationConfiguration("mcp_tool", { toolName: "https://evil" })).toMatch(
      /Invalid tool name/,
    );
  });

  it("requires internal handler", () => {
    expect(validateAutomationConfiguration("internal", { handler: "noop" })).toBeNull();
  });

  it("requires a recipient for the daily sales email template", () => {
    expect(
      validateAutomationConfiguration("internal", {
        handler: "xero_month_to_date_sales_email",
      }),
    ).toMatch(/recipient/i);
    expect(
      validateAutomationConfiguration("internal", {
        handler: "xero_month_to_date_sales_email",
        parameters: { recipientEmail: "ops@example.com" },
      }),
    ).toBeNull();
  });
});

describe("Automation queue architecture", () => {
  it("defines stable queue names", () => {
    expect(AUTOMATION_RUN_QUEUE).toBe("automation-runs");
    expect(AUTOMATION_RUN_DLQ).toBe("automation-runs-dlq");
  });
});

describe("Automation permissions", () => {
  const adminUser: SessionUser = {
    id: "usr_admin",
    email: "admin@test.com",
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_a", role: "company_admin" }],
  };

  const viewerUser: SessionUser = {
    id: "usr_view",
    email: "view@test.com",
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_a", role: "office_staff" }],
  };

  const outsider: SessionUser = {
    id: "usr_out",
    email: "out@test.com",
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_b", role: "company_admin" }],
  };

  it("allows company admins to manage automations", () => {
    expect(canManageAutomations(adminUser, "co_a")).toBe(true);
    expect(canManageAutomations(viewerUser, "co_a")).toBe(false);
    expect(canManageAutomations(outsider, "co_a")).toBe(false);
  });

  it("allows supervisors to view automations", () => {
    expect(canViewAutomations(viewerUser, "co_a")).toBe(false);
    const supervisor: SessionUser = {
      ...viewerUser,
      memberships: [{ companyId: "co_a", role: "supervisor" }],
    };
    expect(canViewAutomations(supervisor, "co_a")).toBe(true);
  });
});
