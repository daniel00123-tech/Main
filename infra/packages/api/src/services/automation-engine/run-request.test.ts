import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getAutomationDefinition: vi.fn(),
  createAutomationRun: vi.fn(),
  findActiveAutomationRun: vi.fn(),
  findAutomationRunByIdempotencyKey: vi.fn(),
  recordAutomationEvent: vi.fn(),
}));

const controlPlane = vi.hoisted(() => ({
  recordAuditEvent: vi.fn(),
}));

const queue = vi.hoisted(() => ({
  enqueueAutomationRun: vi.fn(),
  hasAutomationRunQueue: vi.fn(() => false),
  kickAutomationRunProcessor: vi.fn(),
}));

vi.mock("./store", () => store);
vi.mock("../control-plane", () => controlPlane);
vi.mock("./queue", () => queue);

import { requestAutomationRun } from "./run-request";
import type { Env } from "../../env";

const env = { DB: {} } as Env;

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "aut_sales",
    companyId: "co_a",
    name: "Daily month-to-date sales",
    status: "active",
    triggerType: "schedule",
    schedule: { frequency: "daily", hour: 8, minute: 0 },
    timezone: "Europe/London",
    nextRunAt: "2026-08-29T07:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "aur_1",
    companyId: "co_a",
    automationId: "aut_sales",
    status: "queued",
    triggerType: "portal_manual",
    idempotencyKey: null,
    ...overrides,
  };
}

describe("requestAutomationRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getAutomationDefinition.mockResolvedValue(definition());
    store.findActiveAutomationRun.mockResolvedValue(null);
    store.findAutomationRunByIdempotencyKey.mockResolvedValue(null);
    store.createAutomationRun.mockResolvedValue({ run: run(), created: true });
    store.recordAutomationEvent.mockResolvedValue(undefined);
    controlPlane.recordAuditEvent.mockResolvedValue(undefined);
    queue.kickAutomationRunProcessor.mockResolvedValue(undefined);
  });

  it("A: runs an active scheduled automation immediately", async () => {
    const result = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "admin@test.com",
      triggerType: "portal_manual",
      idempotencyKey: "click-1",
    });
    expect(result.created).toBe(true);
    expect(result.runId).toBe("aur_1");
    expect(result.status).toBe("queued");
    expect(result.trigger).toBe("portal_manual");
    expect(result.scheduleChanged).toBe(false);
    expect(result.scheduledFor).toBeNull();
    expect(store.createAutomationRun).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        triggerType: "portal_manual",
        idempotencyKey: "click-1",
      }),
    );
    expect(queue.kickAutomationRunProcessor).toHaveBeenCalled();
  });

  it("B: never mutates schedule, timezone, enabled state or next run", async () => {
    store.getAutomationDefinition.mockResolvedValue(
      definition({
        status: "active",
        timezone: "Europe/London",
        nextRunAt: "2026-08-29T07:00:00.000Z",
      }),
    );
    const result = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "admin@test.com",
      triggerType: "mcp_manual",
    });
    expect(result.scheduleChanged).toBe(false);
    expect(JSON.stringify(store)).not.toMatch(/updateAutomationDefinition/);
    expect(store.getAutomationDefinition).toHaveBeenCalledWith(env.DB, "co_a", "aut_sales");
  });

  it("C: allows a paused automation to run without resuming it", async () => {
    store.getAutomationDefinition.mockResolvedValue(definition({ status: "paused" }));
    const result = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "chatgpt:Caddington",
      triggerType: "mcp_manual",
    });
    expect(result.created).toBe(true);
    expect(result.scheduleChanged).toBe(false);
    expect(store.createAutomationRun).toHaveBeenCalled();
  });

  it("J: duplicate idempotency key returns the same run", async () => {
    store.findAutomationRunByIdempotencyKey.mockResolvedValue(
      run({ id: "aur_existing", status: "completed", idempotencyKey: "same-key" }),
    );
    const result = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "admin@test.com",
      triggerType: "portal_manual",
      idempotencyKey: "same-key",
    });
    expect(result.runId).toBe("aur_existing");
    expect(result.created).toBe(false);
    expect(result.reusedExisting).toBe(true);
    expect(store.createAutomationRun).not.toHaveBeenCalled();
    expect(queue.kickAutomationRunProcessor).not.toHaveBeenCalled();
  });

  it("K: portal double-click reuses the active run instead of creating a second", async () => {
    store.findActiveAutomationRun.mockResolvedValue(
      run({ id: "aur_active", status: "running", triggerType: "portal_manual" }),
    );
    const first = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "admin@test.com",
      triggerType: "portal_manual",
      idempotencyKey: "click-a",
    });
    const second = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "admin@test.com",
      triggerType: "portal_manual",
      idempotencyKey: "click-b",
    });
    expect(first.runId).toBe("aur_active");
    expect(second.runId).toBe("aur_active");
    expect(store.createAutomationRun).not.toHaveBeenCalled();
  });

  it("L: records portal_manual, mcp_manual and schedule triggers distinctly", async () => {
    for (const triggerType of ["portal_manual", "mcp_manual", "schedule"] as const) {
      store.createAutomationRun.mockResolvedValueOnce({
        run: run({ id: `aur_${triggerType}`, triggerType }),
        created: true,
      });
      const result = await requestAutomationRun(env, {
        companyId: "co_a",
        automationId: "aut_sales",
        initiatedBy: "tester",
        triggerType,
      });
      expect(result.trigger).toBe(triggerType);
      expect(store.createAutomationRun).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ triggerType }),
      );
    }
  });

  it("M: a manual run near the scheduled slot reuses the active concurrent run", async () => {
    store.findActiveAutomationRun.mockResolvedValue(
      run({ id: "aur_manual", status: "queued", triggerType: "mcp_manual" }),
    );
    const scheduled = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "system:automation-scheduler",
      triggerType: "schedule",
      idempotencyKey: "aut_sales|2026-08-29T07:00:00.000Z",
    });
    expect(scheduled.runId).toBe("aur_manual");
    expect(scheduled.created).toBe(false);
    expect(scheduled.reusedExisting).toBe(true);
    expect(store.createAutomationRun).not.toHaveBeenCalled();
  });

  it("O: scheduled execution still uses the same service", async () => {
    store.createAutomationRun.mockResolvedValue({
      run: run({ id: "aur_sched", triggerType: "schedule" }),
      created: true,
    });
    const result = await requestAutomationRun(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      initiatedBy: "system:automation-scheduler",
      triggerType: "schedule",
      idempotencyKey: "aut_sales|2026-08-29T07:00:00.000Z",
    });
    expect(result.trigger).toBe("schedule");
    expect(result.created).toBe(true);
    expect(controlPlane.recordAuditEvent).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ eventType: "automation.scheduled_run_created" }),
    );
  });

  it("rejects a disabled automation", async () => {
    store.getAutomationDefinition.mockResolvedValue(definition({ status: "disabled" }));
    await expect(
      requestAutomationRun(env, {
        companyId: "co_a",
        automationId: "aut_sales",
        initiatedBy: "admin@test.com",
        triggerType: "portal_manual",
      }),
    ).rejects.toThrow(/disabled/i);
  });
});
