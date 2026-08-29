import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
} from "@infra/shared";

const store = vi.hoisted(() => ({
  listAutomationDefinitions: vi.fn(),
  getAutomationDefinition: vi.fn(),
  createAutomationDefinition: vi.fn(),
  updateAutomationDefinition: vi.fn(),
  getAutomationRun: vi.fn(),
}));

const controlPlane = vi.hoisted(() => ({
  getCompanyById: vi.fn(),
  listConnectorInstances: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

const emailConfig = vi.hoisted(() => ({
  getCompanyEmailConfig: vi.fn(),
}));

const runRequest = vi.hoisted(() => ({
  requestAutomationRun: vi.fn(),
}));

vi.mock("./store", () => store);
vi.mock("../control-plane", () => controlPlane);
vi.mock("../email/company-config", () => emailConfig);
vi.mock("./run-request", () => runRequest);
vi.mock("./permissions", () => ({
  ensureAutomationServiceIdentity: vi.fn(async () => "svc_aut"),
}));
vi.mock("../public-urls", () => ({
  portalOrigin: () => "https://infra-web.pages.dev",
}));

import {
  archiveAutomation,
  createAutomationFromPlan,
  findDuplicateAutomation,
  planAutomationCreation,
  runAutomationNow,
  setAutomationPaused,
} from "./control";
import type { Env } from "../../env";

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "aut_sales",
    companyId: "co_a",
    name: "Daily month-to-date sales",
    description: "sales",
    status: "active",
    triggerType: "schedule",
    schedule: { frequency: "daily", hour: 8, minute: 0 },
    timezone: "Europe/London",
    actionType: "internal",
    configuration: {
      handler: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      createdVia: "chatgpt",
      parameters: { recipientEmail: "ops@example.com" },
    },
    serviceIdentityId: "svc_aut",
    createdBy: "chatgpt:Company",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: "2026-08-29T07:00:00.000Z",
    failureCount: 0,
    maximumRetries: 3,
    ...overrides,
  };
}

function envWithPlans(plans: Map<string, Record<string, unknown>>): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM automation_control_plans")) {
                const id = String(binds[0]);
                const companyId = String(binds[1]);
                const row = plans.get(id);
                if (!row || row.company_id !== companyId) return null;
                return row;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO automation_control_plans")) {
                plans.set(String(binds[0]), {
                  id: binds[0],
                  company_id: binds[1],
                  kind: binds[2],
                  actor: binds[3],
                  source: binds[4],
                  spec_json: binds[5],
                  summary_json: binds[6],
                  confirmation_token: binds[7],
                  status: binds[8],
                  expires_at: binds[9],
                  consumed_automation_id: null,
                  created_at: binds[10],
                  updated_at: binds[11],
                });
              }
              if (sql.includes("UPDATE automation_control_plans")) {
                const row = plans.get(String(binds[2]));
                if (row) {
                  row.status = "consumed";
                  row.consumed_automation_id = binds[0];
                }
              }
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { DB: db as unknown as D1Database } as Env;
}

describe("automation control service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controlPlane.getCompanyById.mockResolvedValue({
      id: "co_a",
      slug: "acme",
      name: "Acme",
    });
    controlPlane.listConnectorInstances.mockResolvedValue([
      { connectorDefinitionId: "conn_xero", authStatus: "connected" },
      { connectorDefinitionId: "conn_google_drive", authStatus: "connected" },
    ]);
    controlPlane.recordAuditEvent.mockResolvedValue(undefined);
    emailConfig.getCompanyEmailConfig.mockResolvedValue({
      enabled: true,
      senderAddress: "admin@example.com",
      allowedTypes: ["XERO_SALES_REPORT", "DOCUMENT_ACTIVITY_REPORT"],
    });
    store.listAutomationDefinitions.mockResolvedValue([]);
    store.getAutomationDefinition.mockResolvedValue(null);
  });

  it("plans a valid automation without creating it", async () => {
    const env = envWithPlans(new Map());
    const plan = await planAutomationCreation(env, {
      companyId: "co_a",
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
      spec: {
        companyId: "co_a",
        name: "Daily month-to-date sales",
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        steps: [
          { type: "XERO_MONTH_TO_DATE_SALES" },
          { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" },
        ],
        recipientEmail: "ops@example.com",
      },
    });
    expect(plan.created).toBe(false);
    expect(plan.confirmationRequired).toBe(true);
    expect(plan.planId).toMatch(/^apl_/);
    expect(store.createAutomationDefinition).not.toHaveBeenCalled();
    expect(controlPlane.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "automation.planned" }),
    );
  });

  it("refuses create without confirmation and warns on duplicates", async () => {
    const plans = new Map<string, Record<string, unknown>>();
    const env = envWithPlans(plans);
    const planned = await planAutomationCreation(env, {
      companyId: "co_a",
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
      spec: {
        companyId: "co_a",
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        recipientEmail: "ops@example.com",
      },
    });

    await expect(
      createAutomationFromPlan(env, {
        companyId: "co_a",
        planId: planned.planId,
        confirmationToken: planned.confirmationToken,
        confirmed: false,
        actor: { label: "chatgpt:Acme", source: "chatgpt" },
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });

    store.listAutomationDefinitions.mockResolvedValue([definition()]);
    await expect(
      createAutomationFromPlan(env, {
        companyId: "co_a",
        planId: planned.planId,
        confirmationToken: planned.confirmationToken,
        confirmed: true,
        actor: { label: "chatgpt:Acme", source: "chatgpt" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_AUTOMATION" });
  });

  it("creates from a confirmed plan as configuration, not code", async () => {
    const env = envWithPlans(new Map());
    const planned = await planAutomationCreation(env, {
      companyId: "co_a",
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
      spec: {
        companyId: "co_a",
        templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "12:00",
          timezone: "Europe/London",
        },
        recipientEmail: "ops@example.com",
      },
    });
    const created = definition({
      id: "aut_docs",
      name: "Daily document activity",
      configuration: {
        handler: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
        templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
        createdVia: "chatgpt",
        parameters: { recipientEmail: "ops@example.com" },
      },
    });
    store.createAutomationDefinition.mockResolvedValue(created);
    store.updateAutomationDefinition.mockResolvedValue(created);

    const result = await createAutomationFromPlan(env, {
      companyId: "co_a",
      planId: planned.planId,
      confirmationToken: planned.confirmationToken,
      confirmed: true,
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
    });
    expect(result.automation.id).toBe("aut_docs");
    expect(store.createAutomationDefinition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionType: "internal",
        configuration: expect.objectContaining({
          createdVia: "chatgpt",
          templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
        }),
      }),
    );
    const config = store.createAutomationDefinition.mock.calls[0][1].configuration;
    expect(JSON.stringify(config)).not.toMatch(/function |eval\(|python/i);
  });

  it("isolates tenants when looking up duplicates", async () => {
    store.listAutomationDefinitions.mockResolvedValue([definition({ companyId: "co_a" })]);
    const match = await findDuplicateAutomation(
      {} as D1Database,
      "co_a",
      [
        XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        "daily",
        "8",
        "0",
        "Europe/London",
        "ops@example.com",
      ].join("|"),
    );
    expect(match?.id).toBe("aut_sales");
    store.listAutomationDefinitions.mockResolvedValue([]);
    const other = await findDuplicateAutomation(
      {} as D1Database,
      "co_ht",
      [
        XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        "daily",
        "8",
        "0",
        "Europe/London",
        "ops@example.com",
      ].join("|"),
    );
    expect(other).toBeNull();
  });

  it("pauses, resumes, and archives without deleting run history", async () => {
    const existing = definition();
    store.getAutomationDefinition.mockResolvedValue(existing);
    store.updateAutomationDefinition.mockImplementation(async (_db, input) => ({
      ...existing,
      ...input.patch,
      configuration: input.patch.configuration ?? existing.configuration,
    }));
    const env = envWithPlans(new Map());
    const paused = await setAutomationPaused(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      paused: true,
      actor: { label: "admin@test.com", source: "portal" },
    });
    expect(paused?.status).toBe("paused");
    const archived = await archiveAutomation(env, {
      companyId: "co_a",
      automationId: "aut_sales",
      actor: { label: "admin@test.com", source: "portal" },
    });
    expect(archived?.status).toBe("disabled");
    expect(archived?.configuration.archived).toBe(true);
    expect(controlPlane.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "automation.archived" }),
    );
  });

  it("runs now without changing schedule or paused state", async () => {
    const existing = definition({ status: "paused" });
    store.getAutomationDefinition.mockResolvedValue(existing);
    runRequest.requestAutomationRun.mockResolvedValue({
      runId: "aur_now",
      created: true,
      status: "queued",
      trigger: "mcp_manual",
      automationId: "aut_sales",
      automationName: "Daily month-to-date sales",
      scheduledFor: null,
      scheduleChanged: false,
      reusedExisting: false,
    });
    const result = await runAutomationNow(envWithPlans(new Map()), {
      companyId: "co_a",
      automationId: "aut_sales",
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
      triggerType: "mcp_manual",
    });
    expect(result.runId).toBe("aur_now");
    expect(result.scheduleUnchanged).toBe(true);
    expect(result.preserved.status).toBe("paused");
    expect(result.preserved.nextRunAt).toBe("2026-08-29T07:00:00.000Z");
    expect(result.preserved.timezone).toBe("Europe/London");
    expect(runRequest.requestAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        triggerType: "mcp_manual",
        automationId: "aut_sales",
      }),
    );
    expect(store.updateAutomationDefinition).not.toHaveBeenCalled();
  });

  it("treats portal-created and ChatGPT-created specs as the same engine configuration", async () => {
    const env = envWithPlans(new Map());
    const chatgpt = await planAutomationCreation(env, {
      companyId: "co_a",
      actor: { label: "chatgpt:Acme", source: "chatgpt" },
      spec: {
        companyId: "co_a",
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        recipientEmail: "ops@example.com",
      },
    });
    const portal = await planAutomationCreation(env, {
      companyId: "co_a",
      actor: { label: "admin@test.com", source: "portal" },
      spec: {
        companyId: "co_a",
        templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
        trigger: {
          type: "schedule",
          frequency: "daily",
          time: "08:00",
          timezone: "Europe/London",
        },
        recipientEmail: "ops@example.com",
      },
    });
    expect(chatgpt.spec.templateKey ?? chatgpt.summary.templateKey).toBe(
      portal.spec.templateKey ?? portal.summary.templateKey,
    );
    expect(chatgpt.spec.trigger).toEqual(portal.spec.trigger);
  });
});
