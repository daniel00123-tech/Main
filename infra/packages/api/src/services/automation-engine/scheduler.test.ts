import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  listDueAutomations: vi.fn(),
  findActiveAutomationRun: vi.fn(),
  claimDueAutomation: vi.fn(),
}));

const schedule = vi.hoisted(() => ({
  buildScheduleIdempotencyKey: vi.fn(
    (id: string, slot: string) => `${id}|${slot}`,
  ),
  computeNextRunUtcIso: vi.fn(() => "2026-08-30T07:00:00.000Z"),
  currentScheduleSlotUtcIso: vi.fn(() => "2026-08-29T07:00:00.000Z"),
}));

const runRequest = vi.hoisted(() => ({
  requestAutomationRun: vi.fn(),
}));

vi.mock("./store", () => store);
vi.mock("./schedule", () => schedule);
vi.mock("./run-request", () => runRequest);

import { runAutomationScheduler } from "./scheduler";
import type { Env } from "../../env";

const env = { DB: {} } as Env;

const due = {
  id: "aut_sales",
  companyId: "co_a",
  name: "Daily month-to-date sales",
  status: "active",
  triggerType: "schedule",
  schedule: { frequency: "daily", hour: 8, minute: 0 },
  timezone: "Europe/London",
  nextRunAt: "2026-08-29T07:00:00.000Z",
};

describe("automation scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.listDueAutomations.mockResolvedValue([due]);
    store.findActiveAutomationRun.mockResolvedValue(null);
    store.claimDueAutomation.mockResolvedValue(true);
    runRequest.requestAutomationRun.mockResolvedValue({
      runId: "aur_sched",
      created: true,
      status: "queued",
      trigger: "schedule",
      scheduleChanged: false,
    });
  });

  it("O: still claims due automations and uses the shared run service", async () => {
    const result = await runAutomationScheduler(env, {
      now: new Date("2026-08-29T07:00:00.000Z"),
    });
    expect(result.claimed).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(runRequest.requestAutomationRun).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        companyId: "co_a",
        automationId: "aut_sales",
        triggerType: "schedule",
        initiatedBy: "system:automation-scheduler",
        idempotencyKey: "aut_sales|2026-08-29T07:00:00.000Z",
      }),
    );
  });

  it("M: skips claiming when a manual run is already queued or running", async () => {
    store.findActiveAutomationRun.mockResolvedValue({
      id: "aur_manual",
      status: "running",
      triggerType: "portal_manual",
    });
    const result = await runAutomationScheduler(env, {
      now: new Date("2026-08-29T07:00:00.000Z"),
    });
    expect(result.skippedDuplicate).toBe(1);
    expect(store.claimDueAutomation).not.toHaveBeenCalled();
    expect(runRequest.requestAutomationRun).not.toHaveBeenCalled();
  });
});
