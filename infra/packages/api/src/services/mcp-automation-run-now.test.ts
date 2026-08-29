import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_CONTROL_TOOLS } from "./mcp-automation-tools";

const store = vi.hoisted(() => ({
  findAutomationsByName: vi.fn(),
  getAutomationDefinition: vi.fn(),
  getAutomationRun: vi.fn(),
  listAutomationDefinitions: vi.fn(),
  listLatestAutomationRuns: vi.fn(),
}));

const control = vi.hoisted(() => ({
  runAutomationNow: vi.fn(),
  AutomationControlError: class AutomationControlError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: 400 | 403 | 404 | 409 = 400,
      readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "AutomationControlError";
    }
  },
  managementUrlForCompany: () => "https://infra-web.pages.dev/portal/acme/automations",
  applyValidatedUpdate: vi.fn(),
  archiveAutomation: vi.fn(),
  createAutomationFromPlan: vi.fn(),
  planAutomationCreation: vi.fn(),
  setAutomationPaused: vi.fn(),
  updateAutomationFromPlan: vi.fn(),
}));

const controlPlane = vi.hoisted(() => ({
  getCompanyById: vi.fn(),
}));

vi.mock("./automation-engine/store", () => store);
vi.mock("./automation-engine/control", () => control);
vi.mock("./control-plane", () => controlPlane);

import {
  executeAutomationControlTool,
  resolveAutomationForManualRun,
} from "./mcp-automation-tools";
import type { Env } from "../env";
import type { GatewayActor } from "./gateway";

const env = { DB: {} } as Env;

const chatgpt: GatewayActor = {
  type: "service",
  identity: {
    id: "svc_1",
    companyId: "co_a",
    name: "Company ChatGPT",
    description: null,
    identityType: "chatgpt",
    status: "active",
    tokenPrefix: "infra",
    hasToken: true,
    scopes: ["automation.read", "automation.manage"],
    mcpEnvironmentId: null,
    lastUsedAt: null,
    requestCount: 0,
    createdAt: "t",
    updatedAt: "t",
  },
};

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: "aut_sales",
    companyId: "co_a",
    name: "Daily month-to-date sales",
    description: "Morning sales email",
    status: "active",
    triggerType: "schedule",
    schedule: { frequency: "daily", hour: 8, minute: 0 },
    timezone: "Europe/London",
    actionType: "internal",
    configuration: {
      templateKey: "xero_month_to_date_sales_email",
      parameters: { recipientEmail: "ops@example.com" },
    },
    nextRunAt: "2026-08-29T07:00:00.000Z",
    lastRunAt: "2026-08-28T07:05:00.000Z",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("MCP automation Run now", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controlPlane.getCompanyById.mockResolvedValue({ id: "co_a", slug: "acme", name: "Acme" });
    store.listLatestAutomationRuns.mockResolvedValue(new Map());
    store.getAutomationRun.mockResolvedValue({
      id: "aur_1",
      automationId: "aut_sales",
      status: "queued",
      triggerType: "mcp_manual",
      initiatedBy: "chatgpt:Company ChatGPT",
      createdAt: "2026-08-29T06:00:00.000Z",
      startedAt: null,
      completedAt: null,
      resultSummary: null,
      errorCode: null,
      errorMessage: null,
    });
    control.runAutomationNow.mockResolvedValue({
      runId: "aur_1",
      created: true,
      status: "queued",
      trigger: "mcp_manual",
      automationId: "aut_sales",
      automationName: "Daily month-to-date sales",
      scheduledFor: null,
      scheduleChanged: false,
      reusedExisting: false,
      scheduleUnchanged: true,
      preserved: {
        status: "active",
        timezone: "Europe/London",
        nextRunAt: "2026-08-29T07:00:00.000Z",
        schedule: { frequency: "daily", hour: 8, minute: 0 },
      },
    });
  });

  it("N: production catalogue includes automation-control tools", () => {
    expect(AUTOMATION_CONTROL_TOOLS).toEqual(
      expect.arrayContaining([
        "automation_list",
        "automation_run_now",
        "automation_get_run",
      ]),
    );
  });

  it("D: lists active and paused automations accurately", async () => {
    store.listAutomationDefinitions.mockResolvedValue([
      automation(),
      automation({
        id: "aut_docs",
        name: "Daily document activity",
        status: "paused",
        nextRunAt: null,
      }),
    ]);
    const all = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_list",
      arguments: { status: "all" },
      actor: chatgpt,
    });
    expect(all.status).toBe(200);
    const listed = all.body.automations as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      automationId: "aut_sales",
      name: "Daily month-to-date sales",
      enabled: true,
      paused: false,
      timezone: "Europe/London",
      nextRun: "2026-08-29T07:00:00.000Z",
      manualRunSupported: true,
    });
    expect(listed[1]).toMatchObject({
      automationId: "aut_docs",
      enabled: false,
      paused: true,
      manualRunSupported: true,
    });

    const active = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_list",
      arguments: { status: "active" },
      actor: chatgpt,
    });
    expect((active.body.automations as unknown[]).length).toBe(1);
    const paused = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_list",
      arguments: { status: "paused" },
      actor: chatgpt,
    });
    expect((paused.body.automations as Array<{ name: string }>)[0].name).toBe(
      "Daily document activity",
    );
  });

  it("E: runs by automation ID as mcp_manual", async () => {
    store.getAutomationDefinition.mockResolvedValue(automation());
    const result = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_run_now",
      arguments: { automation_id: "aut_sales" },
      actor: chatgpt,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      automationId: "aut_sales",
      automationName: "Daily month-to-date sales",
      runId: "aur_1",
      trigger: "mcp_manual",
      scheduleChanged: false,
      scheduleUnchanged: true,
    });
    expect(control.runAutomationNow).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        companyId: "co_a",
        automationId: "aut_sales",
        triggerType: "mcp_manual",
      }),
    );
  });

  it("F: runs by unique automation name", async () => {
    store.findAutomationsByName.mockResolvedValue([automation()]);
    const result = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_run_now",
      arguments: { automation_name: "daily month-to-date sales" },
      actor: chatgpt,
    });
    expect(result.status).toBe(200);
    expect(result.body.runId).toBe("aur_1");
    expect(store.findAutomationsByName).toHaveBeenCalledWith(
      env.DB,
      "co_a",
      "daily month-to-date sales",
    );
  });

  it("G: ambiguous names require clarification and do not execute", async () => {
    store.findAutomationsByName.mockResolvedValue([
      automation({ id: "aut_1" }),
      automation({ id: "aut_2", status: "paused" }),
    ]);
    const result = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_run_now",
      arguments: { name: "Daily month-to-date sales" },
      actor: chatgpt,
    });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("AMBIGUOUS_NAME");
    expect(result.body.candidates).toHaveLength(2);
    expect(control.runAutomationNow).not.toHaveBeenCalled();
  });

  it("H: unknown automation returns not found", async () => {
    store.getAutomationDefinition.mockResolvedValue(null);
    store.findAutomationsByName.mockResolvedValue([]);
    const byId = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_run_now",
      arguments: { automationId: "aut_missing" },
      actor: chatgpt,
    });
    expect(byId.status).toBe(404);
    expect(byId.body.code).toBe("NOT_FOUND");
    const byName = await resolveAutomationForManualRun(env, "co_a", {
      automation_name: "No such report",
    });
    expect("error" in byName && byName.error.body.code).toBe("NOT_FOUND");
    expect(control.runAutomationNow).not.toHaveBeenCalled();
  });

  it("I: cross-tenant IDs resolve only inside the authenticated company", async () => {
    store.getAutomationDefinition.mockResolvedValue(null);
    const result = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_run_now",
      arguments: { automationId: "aut_other_tenant" },
      actor: chatgpt,
    });
    expect(result.status).toBe(404);
    expect(store.getAutomationDefinition).toHaveBeenCalledWith(
      env.DB,
      "co_a",
      "aut_other_tenant",
    );
    expect(control.runAutomationNow).not.toHaveBeenCalled();
  });

  it("returns run status for automation_get_run", async () => {
    store.getAutomationRun.mockResolvedValue({
      id: "aur_1",
      automationId: "aut_sales",
      status: "failed",
      triggerType: "mcp_manual",
      initiatedBy: "chatgpt:Company ChatGPT",
      createdAt: "t",
      startedAt: "t",
      completedAt: "t",
      resultSummary: null,
      errorCode: "EMAIL_DELIVERY_FAILED",
      errorMessage: "Report generated, email not sent",
    });
    const result = await executeAutomationControlTool(env, {
      companyId: "co_a",
      toolName: "automation_get_run",
      arguments: { run_id: "aur_1" },
      actor: chatgpt,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      runId: "aur_1",
      status: "failed",
      trigger: "mcp_manual",
      errorCode: "EMAIL_DELIVERY_FAILED",
    });
  });
});
