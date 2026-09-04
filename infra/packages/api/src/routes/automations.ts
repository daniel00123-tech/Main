/**
 * Automation Engine API routes.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { loadSession, requireAuth, type AuthVariables } from "../auth/middleware";
import { getCompanyBySlug, recordAuditEvent } from "../services/control-plane";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_SCHEDULE_FREQUENCIES,
  AUTOMATION_TEMPLATES,
  AUTOMATION_TRIGGER_TYPES,
  automationCreatedViaOf,
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  getAutomationTemplate,
  isArchivedAutomation,
  isValidRecipientEmail,
  type AutomationActionType,
  type AutomationSchedule,
  type AutomationTriggerType,
} from "@infra/shared";
import {
  createAutomationDefinition,
  getAutomationDefinition,
  getAutomationRun,
  listAutomationDefinitions,
  listAutomationRunSteps,
  listAutomationRuns,
  updateAutomationDefinition,
} from "../services/automation-engine/store";
import {
  canManageAutomations,
  canViewAutomations,
  ensureAutomationServiceIdentity,
} from "../services/automation-engine/permissions";
import { validateAutomationConfiguration } from "../services/automation-engine/actions/index";
import { computeNextRunUtcIso, formatScheduleLabel } from "../services/automation-engine/schedule";
import { requestAutomationRun } from "../services/automation-engine/run-request";
import { provisionTemplateAutomation } from "../services/automation-engine/provision-template";
import { provisionElKnowledgeActivityAutomation } from "../services/automation-engine/provision-el-knowledge-activity";
import {
  archiveAutomation,
  createAutomationFromPlan,
  planAutomationCreation,
  runAutomationNow,
  AutomationControlError,
} from "../services/automation-engine/control";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const automations = new Hono<AppEnv>();

async function resolveCompany(c: Context<AppEnv>) {
  const slug = c.req.param("slug");
  if (!slug) return null;
  const company = await getCompanyBySlug(c.env.DB, slug);
  if (!company) return null;
  const user = c.get("user");
  if (!canViewAutomations(user, company.id)) return null;
  return company;
}

function sanitiseName(name: string): string {
  return name.trim().slice(0, 200);
}

function sanitiseDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  return desc.trim().slice(0, 2000);
}

function parseSchedule(input: unknown): AutomationSchedule | null {
  if (!input || typeof input !== "object") return null;
  const schedule = input as AutomationSchedule;
  if (
    !schedule.frequency ||
    !AUTOMATION_SCHEDULE_FREQUENCIES.includes(schedule.frequency)
  ) {
    return null;
  }
  return {
    frequency: schedule.frequency,
    hour: schedule.hour ?? 0,
    minute: schedule.minute ?? 0,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
  };
}

function serialiseAutomation(definition: Awaited<ReturnType<typeof getAutomationDefinition>>) {
  if (!definition) return null;
  const templateKey = automationTemplateKeyOf(definition.configuration);
  const template = templateKey ? getAutomationTemplate(templateKey) : null;
  return {
    ...definition,
    scheduleLabel: definition.schedule
      ? formatScheduleLabel(definition.schedule, definition.timezone)
      : null,
    templateKey,
    templateLabel: template?.label ?? null,
    recipientEmail: automationRecipientEmailOf(definition.configuration),
    createdVia: automationCreatedViaOf(definition.configuration),
    archived: isArchivedAutomation(definition),
  };
}

const authed = [loadSession, requireAuth] as const;

automations.get("/api/automation-templates", ...authed, async (c) => {
  return c.json({
    templates: AUTOMATION_TEMPLATES.map((item) => ({
      key: item.key,
      type: item.type,
      label: item.label,
      description: item.description,
      system: item.system,
      defaultName: item.defaultName,
      defaultSchedule: item.defaultSchedule,
      defaultTimezone: item.defaultTimezone,
      available: item.available,
    })),
  });
});

automations.get("/api/companies/:slug/automations", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const includeArchived = c.req.query("includeArchived") === "1";
  const items = await listAutomationDefinitions(c.env.DB, company.id);
  return c.json({
    automations: items
      .filter((item) => includeArchived || !isArchivedAutomation(item))
      .map((item) => serialiseAutomation(item)),
  });
});

automations.get("/api/companies/:slug/automations/:automationId", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const automationId = c.req.param("automationId");
  const definition = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!definition) return c.json({ error: "Automation not found" }, 404);
  return c.json({ automation: serialiseAutomation(definition) });
});

automations.post("/api/companies/:slug/automations", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    description?: string;
    triggerType?: AutomationTriggerType;
    schedule?: AutomationSchedule;
    timezone?: string;
    actionType?: AutomationActionType;
    configuration?: Record<string, unknown>;
  }>();

  const name = body.name ? sanitiseName(body.name) : "";
  if (!name) return c.json({ error: "Name is required" }, 400);

  const triggerType = body.triggerType ?? "manual";
  if (!AUTOMATION_TRIGGER_TYPES.includes(triggerType)) {
    return c.json({ error: "Invalid trigger type" }, 400);
  }

  const actionType = body.actionType ?? "ai_prompt";
  if (!AUTOMATION_ACTION_TYPES.includes(actionType)) {
    return c.json({ error: "Invalid action type" }, 400);
  }

  const configuration = body.configuration ?? {};
  const configError = validateAutomationConfiguration(actionType, configuration);
  if (configError) return c.json({ error: configError }, 400);

  const schedule =
    triggerType === "schedule" ? parseSchedule(body.schedule) : null;
  if (triggerType === "schedule" && !schedule) {
    return c.json({ error: "Schedule is required for scheduled automations" }, 400);
  }

  const timezone = (body.timezone ?? "UTC").trim().slice(0, 64);
  let nextRunAt: string | null = null;
  if (schedule) {
    try {
      nextRunAt = computeNextRunUtcIso(schedule, timezone);
    } catch {
      return c.json({ error: "Invalid schedule or timezone" }, 400);
    }
  }

  const created = await createAutomationDefinition(c.env.DB, {
    companyId: company.id,
    name,
    description: sanitiseDescription(body.description),
    triggerType,
    schedule,
    timezone,
    actionType,
    configuration,
    createdBy: user.email,
    status: "draft",
    nextRunAt,
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "automation.created",
    actor: user.email,
    resourceType: "automation",
    resourceId: created.id,
    detail: { name, triggerType, actionType },
  });

  return c.json({ automation: serialiseAutomation(created) }, 201);
});

automations.post("/api/companies/:slug/automations/from-template", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const body = await c.req.json<{
    templateKey?: string;
    name?: string;
    recipientEmail?: string;
    timezone?: string;
    hour?: number;
    minute?: number;
    frequency?: (typeof AUTOMATION_SCHEDULE_FREQUENCIES)[number];
    activate?: boolean;
    allowDuplicate?: boolean;
  }>();

  const recipient = (body.recipientEmail ?? user.email ?? "").trim();
  if (!isValidRecipientEmail(recipient)) {
    return c.json({ error: "A valid recipient email is required" }, 400);
  }

  try {
    const automation = await provisionTemplateAutomation(c.env.DB, {
      companyId: company.id,
      templateKey: body.templateKey ?? "",
      recipientEmail: recipient,
      name: body.name,
      timezone: body.timezone,
      hour: body.hour,
      minute: body.minute,
      frequency: body.frequency,
      createdBy: user.email,
      activate: body.activate !== false,
      createdVia: user.isPlatformAdmin ? "platform_admin" : "portal",
      allowDuplicate: body.allowDuplicate === true,
      onExisting: "reject",
    });
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "automation.created",
      actor: user.email,
      resourceType: "automation",
      resourceId: automation.id,
      detail: {
        source: user.isPlatformAdmin ? "platform_admin" : "portal",
        createdVia: user.isPlatformAdmin ? "platform_admin" : "portal",
        templateKey: body.templateKey,
        recipientEmail: recipient,
        name: automation.name,
      },
    });
    return c.json({ automation: serialiseAutomation(automation) }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to create automation" },
      400,
    );
  }
});

automations.patch("/api/companies/:slug/automations/:automationId", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const automationId = c.req.param("automationId");
  const existing = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!existing) return c.json({ error: "Automation not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    triggerType?: AutomationTriggerType;
    schedule?: AutomationSchedule | null;
    timezone?: string;
    actionType?: AutomationActionType;
    configuration?: Record<string, unknown>;
  }>();

  const triggerType = body.triggerType ?? existing.triggerType;
  const schedule =
    body.schedule !== undefined
      ? body.schedule
        ? parseSchedule(body.schedule)
        : null
      : existing.schedule;
  if (triggerType === "schedule" && !schedule) {
    return c.json({ error: "Schedule is required for scheduled automations" }, 400);
  }

  const actionType = body.actionType ?? existing.actionType;
  const configuration = body.configuration ?? existing.configuration;
  const configError = validateAutomationConfiguration(actionType, configuration);
  if (configError) return c.json({ error: configError }, 400);

  const timezone = body.timezone ?? existing.timezone;
  let nextRunAt = existing.nextRunAt;
  if (schedule && existing.status === "active") {
    try {
      nextRunAt = computeNextRunUtcIso(schedule, timezone);
    } catch {
      return c.json({ error: "Invalid schedule or timezone" }, 400);
    }
  }

  const updated = await updateAutomationDefinition(c.env.DB, {
    companyId: company.id,
    automationId,
    patch: {
      name: body.name ? sanitiseName(body.name) : existing.name,
      description:
        body.description !== undefined ? sanitiseDescription(body.description) : existing.description,
      triggerType,
      schedule: triggerType === "schedule" ? schedule : null,
      timezone,
      actionType,
      configuration,
      nextRunAt: triggerType === "schedule" ? nextRunAt : null,
    },
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "automation.updated",
    actor: user.email,
    resourceType: "automation",
    resourceId: automationId,
    detail: { name: updated?.name },
  });

  return c.json({ automation: serialiseAutomation(updated) });
});

automations.post("/api/companies/:slug/automations/:automationId/activate", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const automationId = c.req.param("automationId");
  const existing = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!existing) return c.json({ error: "Automation not found" }, 404);

  const serviceIdentityId = await ensureAutomationServiceIdentity(c.env.DB, existing);
  let nextRunAt = existing.nextRunAt;
  if (existing.triggerType === "schedule" && existing.schedule) {
    nextRunAt = computeNextRunUtcIso(existing.schedule, existing.timezone);
  }

  const updated = await updateAutomationDefinition(c.env.DB, {
    companyId: company.id,
    automationId,
    patch: {
      status: "active",
      serviceIdentityId,
      nextRunAt,
      failureCount: 0,
    },
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "automation.activated",
    actor: user.email,
    resourceType: "automation",
    resourceId: automationId,
  });

  return c.json({ automation: serialiseAutomation(updated) });
});

automations.post("/api/companies/:slug/automations/:automationId/pause", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const automationId = c.req.param("automationId");
  const existing = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!existing) return c.json({ error: "Automation not found" }, 404);

  const updated = await updateAutomationDefinition(c.env.DB, {
    companyId: company.id,
    automationId,
    patch: { status: "paused" },
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "automation.paused",
    actor: user.email,
    resourceType: "automation",
    resourceId: automationId,
  });

  return c.json({ automation: serialiseAutomation(updated) });
});

automations.post("/api/companies/:slug/automations/plan", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>();
  try {
    const plan = await planAutomationCreation(c.env, {
      companyId: company.id,
      actor: {
        label: user.email,
        source: user.isPlatformAdmin ? "platform_admin" : "portal",
      },
      spec: {
        companyId: company.id,
        name: typeof body.name === "string" ? body.name : undefined,
        templateKey: typeof body.templateKey === "string" ? body.templateKey : undefined,
        trigger: {
          type: "schedule",
          frequency:
            typeof body.frequency === "string"
              ? (body.frequency as (typeof AUTOMATION_SCHEDULE_FREQUENCIES)[number])
              : "daily",
          time: typeof body.time === "string" ? body.time : "08:00",
          timezone: typeof body.timezone === "string" ? body.timezone : "Europe/London",
        },
        timezone: typeof body.timezone === "string" ? body.timezone : "Europe/London",
        recipientEmail: typeof body.recipientEmail === "string" ? body.recipientEmail : undefined,
        steps: Array.isArray(body.steps)
          ? body.steps.map((step) => ({
              type: String((step as { type?: unknown })?.type ?? ""),
            }))
          : undefined,
        enabled: body.enabled !== false,
      },
    });
    return c.json(plan);
  } catch (err) {
    const status = err instanceof AutomationControlError ? err.status : 400;
    return c.json(
      {
        error: err instanceof Error ? err.message : "Unable to plan automation",
        code: err instanceof AutomationControlError ? err.code : undefined,
        issues: err instanceof AutomationControlError ? err.details?.issues : undefined,
      },
      status,
    );
  }
});

automations.post("/api/companies/:slug/automations/from-plan", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }
  const body = await c.req.json<{
    planId?: string;
    confirmationToken?: string;
    confirmed?: boolean;
    allowDuplicate?: boolean;
  }>();
  try {
    const result = await createAutomationFromPlan(c.env, {
      companyId: company.id,
      planId: body.planId ?? "",
      confirmationToken: body.confirmationToken ?? "",
      confirmed: body.confirmed === true,
      allowDuplicate: body.allowDuplicate === true,
      actor: {
        label: user.email,
        source: user.isPlatformAdmin ? "platform_admin" : "portal",
      },
    });
    return c.json(
      {
        automation: serialiseAutomation(result.automation),
        managementUrl: result.managementUrl,
      },
      201,
    );
  } catch (err) {
    const status = err instanceof AutomationControlError ? err.status : 400;
    return c.json(
      {
        error: err instanceof Error ? err.message : "Unable to create automation",
        code: err instanceof AutomationControlError ? err.code : undefined,
      },
      status,
    );
  }
});

automations.post("/api/companies/:slug/automations/:automationId/archive", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }
  try {
    const updated = await archiveAutomation(c.env, {
      companyId: company.id,
      automationId: c.req.param("automationId"),
      actor: {
        label: user.email,
        source: user.isPlatformAdmin ? "platform_admin" : "portal",
      },
    });
    return c.json({ automation: serialiseAutomation(updated) });
  } catch (err) {
    const status = err instanceof AutomationControlError ? err.status : 400;
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to archive automation" },
      status,
    );
  }
});

automations.post("/api/companies/:slug/automations/:automationId/disable", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const automationId = c.req.param("automationId");
  const existing = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!existing) return c.json({ error: "Automation not found" }, 404);

  const updated = await updateAutomationDefinition(c.env.DB, {
    companyId: company.id,
    automationId,
    patch: { status: "disabled", nextRunAt: null },
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "automation.disabled",
    actor: user.email,
    resourceType: "automation",
    resourceId: automationId,
  });

  return c.json({ automation: serialiseAutomation(updated) });
});

automations.post("/api/companies/:slug/automations/:automationId/run", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const user = c.get("user");
  if (!canManageAutomations(user, company.id)) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const automationId = c.req.param("automationId");
  const existing = await getAutomationDefinition(c.env.DB, company.id, automationId);
  if (!existing) return c.json({ error: "Automation not found" }, 404);

  if (existing.status === "disabled") {
    return c.json({ error: "Automation is disabled" }, 409);
  }

  try {
    const idempotencyKey =
      c.req.header("Idempotency-Key")?.trim() ||
      c.req.header("idempotency-key")?.trim() ||
      null;
    const result = await requestAutomationRun(c.env, {
      companyId: company.id,
      automationId,
      initiatedBy: user.email,
      triggerType: "portal_manual",
      idempotencyKey,
    });
    const run = await getAutomationRun(c.env.DB, company.id, result.runId);
    return c.json({
      success: true,
      automationId: result.automationId,
      automationName: result.automationName,
      runId: result.runId,
      status: result.status,
      trigger: result.trigger,
      scheduledFor: null,
      scheduleChanged: false,
      reusedExisting: result.reusedExisting,
      created: result.created,
      run,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to start run" },
      409,
    );
  }
});

automations.get("/api/companies/:slug/automations/:automationId/runs", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const automationId = c.req.param("automationId");
  const runs = await listAutomationRuns(c.env.DB, company.id, automationId, 100);
  return c.json({
    runs: runs.map((run) => ({
      ...run,
      customerSummary:
        typeof run.result?.customerSummary === "string"
          ? run.result.customerSummary
          : run.resultSummary,
    })),
  });
});

automations.get("/api/companies/:slug/automation-runs/:runId", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const runId = c.req.param("runId");
  const run = await getAutomationRun(c.env.DB, company.id, runId);
  if (!run) return c.json({ error: "Run not found" }, 404);
  const steps = await listAutomationRunSteps(c.env.DB, company.id, runId);
  return c.json({ run, steps });
});

/** Internal fallback when queue binding unavailable */
automations.post("/api/internal/automation/process-run", async (c) => {
  const body = await c.req.json<{
    runId?: string;
    companyId?: string;
    automationId?: string;
  }>();
  if (!body.runId || !body.companyId || !body.automationId) {
    return c.json({ error: "runId, companyId, automationId required" }, 400);
  }

  const { processAutomationRunJob } = await import("../services/automation-engine/queue");
  await processAutomationRunJob(c.env, {
    runId: body.runId,
    companyId: body.companyId,
    automationId: body.automationId,
  });
  const run = await getAutomationRun(c.env.DB, body.companyId, body.runId);
  return c.json({ ok: true, run });
});

/** Acceptance endpoint — non-destructive pilot for co_caddington */
automations.post("/api/internal/automation/acceptance", async (c) => {
  const { runAutomationAcceptance } = await import("../services/automation-engine/acceptance");
  const result = await runAutomationAcceptance(c.env);
  return c.json(result, result.ok ? 200 : 500);
});

automations.post("/api/internal/automation/ensure-template", async (c) => {
  const body = await c.req.json<{
    companyId?: string;
    templateKey?: string;
    recipientEmail?: string;
    name?: string;
    timezone?: string;
    hour?: number;
    minute?: number;
    activate?: boolean;
    runNow?: boolean;
  }>();
  if (!body.companyId || !body.templateKey || !body.recipientEmail) {
    return c.json({ error: "companyId, templateKey, recipientEmail required" }, 400);
  }
  try {
    const automation = await provisionTemplateAutomation(c.env.DB, {
      companyId: body.companyId,
      templateKey: body.templateKey,
      recipientEmail: body.recipientEmail,
      name: body.name,
      timezone: body.timezone,
      hour: body.hour,
      minute: body.minute,
      createdBy: "system:automation-creation-v1",
      activate: body.activate !== false,
      createdVia: "api",
      onExisting: "update",
    });
    if (!body.runNow) {
      return c.json({ automation: serialiseAutomation(automation) });
    }
    const result = await requestAutomationRun(c.env, {
      companyId: body.companyId,
      automationId: automation.id,
      initiatedBy: "system:automation-creation-v1",
      triggerType: "manual",
    });
    const run = await getAutomationRun(c.env.DB, body.companyId, result.runId);
    return c.json({
      automation: serialiseAutomation(automation),
      run,
      created: result.created,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to provision automation" },
      400,
    );
  }
});

automations.post("/api/internal/automation/ensure-el-knowledge-activity", async (c) => {
  const body = await c.req.json<{ runNow?: boolean }>().catch(() => ({ runNow: false }));
  try {
    const beforeCaddington = await listAutomationDefinitions(c.env.DB, "co_caddington");
    const automation = await provisionElKnowledgeActivityAutomation(c.env.DB, {
      createdBy: "system:el-knowledge-activity",
      activate: true,
    });
    const afterCaddington = await listAutomationDefinitions(c.env.DB, "co_caddington");
    const caddingtonUnchanged =
      JSON.stringify(beforeCaddington.map((item) => [item.id, item.status, item.nextRunAt, item.schedule, item.configuration])) ===
      JSON.stringify(afterCaddington.map((item) => [item.id, item.status, item.nextRunAt, item.schedule, item.configuration]));
    if (!body.runNow) {
      return c.json({
        automation: serialiseAutomation(automation),
        caddingtonUnchanged,
      });
    }
    const preservedNextRun = automation.nextRunAt;
    const result = await runAutomationNow(c.env, {
      companyId: "co_el",
      automationId: automation.id,
      actor: { label: "system:el-knowledge-activity", source: "api" },
      triggerType: "manual",
    });
    const run = await getAutomationRun(c.env.DB, "co_el", result.runId);
    const after = await getAutomationDefinition(c.env.DB, "co_el", automation.id);
    return c.json({
      automation: serialiseAutomation(after ?? automation),
      run,
      created: result.created,
      scheduleUnchanged: after?.nextRunAt === preservedNextRun,
      caddingtonUnchanged,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unable to provision EL knowledge automation" },
      400,
    );
  }
});

export default automations;
