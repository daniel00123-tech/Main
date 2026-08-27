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
  AUTOMATION_TRIGGER_TYPES,
  type AutomationActionType,
  type AutomationSchedule,
  type AutomationStatus,
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
  return {
    ...definition,
    scheduleLabel: definition.schedule
      ? formatScheduleLabel(definition.schedule, definition.timezone)
      : null,
  };
}

const authed = [loadSession, requireAuth] as const;

automations.get("/api/companies/:slug/automations", ...authed, async (c) => {
  const company = await resolveCompany(c);
  if (!company) return c.json({ error: "Company not found or access denied" }, 404);
  const items = await listAutomationDefinitions(c.env.DB, company.id);
  return c.json({
    automations: items.map((item) => ({
      ...item,
      scheduleLabel: item.schedule ? formatScheduleLabel(item.schedule, item.timezone) : null,
    })),
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
    const result = await requestAutomationRun(c.env, {
      companyId: company.id,
      automationId,
      initiatedBy: user.email,
      triggerType: "manual",
    });
    const run = await getAutomationRun(c.env.DB, company.id, result.runId);
    return c.json({ run, created: result.created });
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
  return c.json({ runs });
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

export default automations;
