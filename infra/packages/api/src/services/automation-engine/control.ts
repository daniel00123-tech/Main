/**
 * Server-side automation planning, validation, and creation.
 * ChatGPT may supply a structured spec; INFRA never trusts it without
 * independent checks. Runtime remains the existing Automation Engine.
 */

import {
  DOCUMENT_SOURCE_CONNECTOR_IDS,
  PLATFORM_EMAIL_FROM_ADDRESS,
  TRANSACTIONAL_EMAIL_TYPES,
  automationCreatedViaOf,
  describeAutomationPlan,
  fingerprintForAutomation,
  isArchivedAutomation,
  isValidRecipientEmail,
  materialAutomationFingerprint,
  validateAutomationControlSpec,
  type AutomationCapabilitySnapshot,
  type AutomationControlSpec,
  type AutomationCreatedVia,
  type AutomationDuplicateMatch,
} from "@infra/shared";
import type { Env } from "../../env";
import { newId, nowIso } from "../../db/mappers";
import {
  getCompanyById,
  listConnectorInstances,
  recordAuditEvent,
} from "../control-plane";
import { portalOrigin } from "../public-urls";
import { computeNextRunUtcIso, formatScheduleLabel } from "./schedule";
import {
  createAutomationDefinition,
  getAutomationDefinition,
  listAutomationDefinitions,
  updateAutomationDefinition,
} from "./store";
import { ensureAutomationServiceIdentity } from "./permissions";
import { requestAutomationRun } from "./run-request";

export const AUTOMATION_PLAN_TTL_MS = 30 * 60 * 1000;

export type AutomationControlSource = AutomationCreatedVia;

export type AutomationControlActor = {
  label: string;
  source: AutomationControlSource;
};

export type AutomationControlPlanRecord = {
  id: string;
  companyId: string;
  kind: "create" | "update";
  actor: string;
  source: AutomationControlSource;
  spec: AutomationControlSpec & { automationId?: string };
  summary: Record<string, unknown>;
  confirmationToken: string;
  status: "pending" | "consumed" | "expired" | "cancelled";
  expiresAt: string;
  consumedAutomationId: string | null;
  createdAt: string;
};

export class AutomationControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutomationControlError";
  }
}

function mapPlan(row: Record<string, unknown>): AutomationControlPlanRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    kind: String(row.kind) as AutomationControlPlanRecord["kind"],
    actor: String(row.actor),
    source: String(row.source) as AutomationControlSource,
    spec: JSON.parse(String(row.spec_json ?? "{}")) as AutomationControlPlanRecord["spec"],
    summary: JSON.parse(String(row.summary_json ?? "{}")) as Record<string, unknown>,
    confirmationToken: String(row.confirmation_token),
    status: String(row.status) as AutomationControlPlanRecord["status"],
    expiresAt: String(row.expires_at),
    consumedAutomationId: row.consumed_automation_id
      ? String(row.consumed_automation_id)
      : null,
    createdAt: String(row.created_at),
  };
}

export async function loadAutomationCapabilities(
  db: D1Database,
  companyId: string,
): Promise<AutomationCapabilitySnapshot> {
  const connectors = await listConnectorInstances(db, companyId);
  const connected = connectors.filter((item) => item.authStatus === "connected");
  return {
    xeroConnected: connected.some((item) => item.connectorDefinitionId === "conn_xero"),
    documentSourcesConnected: connected.some((item) =>
      (DOCUMENT_SOURCE_CONNECTOR_IDS as readonly string[]).includes(item.connectorDefinitionId),
    ),
    emailEnabled: true,
    allowedEmailTypes: [...TRANSACTIONAL_EMAIL_TYPES],
    senderAddress: PLATFORM_EMAIL_FROM_ADDRESS,
  };
}

export async function findDuplicateAutomation(
  db: D1Database,
  companyId: string,
  fingerprint: string,
) {
  const items = await listAutomationDefinitions(db, companyId);
  return (
    items.find((item) => {
      if (isArchivedAutomation(item)) return false;
      if (!["active", "paused", "draft"].includes(item.status)) return false;
      return fingerprintForAutomation(item) === fingerprint;
    }) ?? null
  );
}

export async function listSimilarAutomations(
  db: D1Database,
  companyId: string,
  templateKey: string,
): Promise<AutomationDuplicateMatch[]> {
  const items = await listAutomationDefinitions(db, companyId);
  return items
    .filter((item) => {
      if (isArchivedAutomation(item)) return false;
      if (!["active", "paused", "draft"].includes(item.status)) return false;
      return item.configuration?.templateKey === templateKey ||
        item.configuration?.handler === templateKey;
    })
    .map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      scheduleLabel: item.schedule
        ? formatScheduleLabel(item.schedule, item.timezone)
        : "Scheduled",
      recipientEmail:
        typeof (item.configuration?.parameters as { recipientEmail?: string } | undefined)
          ?.recipientEmail === "string"
          ? String(
              (item.configuration.parameters as { recipientEmail?: string }).recipientEmail,
            )
          : null,
    }));
}

function confirmationToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function getAutomationControlPlan(
  db: D1Database,
  companyId: string,
  planId: string,
): Promise<AutomationControlPlanRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM automation_control_plans WHERE id = ? AND company_id = ? LIMIT 1`,
    )
    .bind(planId, companyId)
    .first();
  return row ? mapPlan(row as Record<string, unknown>) : null;
}

async function persistPlan(
  db: D1Database,
  input: Omit<AutomationControlPlanRecord, "createdAt" | "consumedAutomationId" | "status"> & {
    status?: AutomationControlPlanRecord["status"];
  },
): Promise<AutomationControlPlanRecord> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO automation_control_plans (
        id, company_id, kind, actor, source, spec_json, summary_json,
        confirmation_token, status, expires_at, consumed_automation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.companyId,
      input.kind,
      input.actor,
      input.source,
      JSON.stringify(input.spec),
      JSON.stringify(input.summary),
      input.confirmationToken,
      input.status ?? "pending",
      input.expiresAt,
      now,
      now,
    )
    .run();
  const created = await getAutomationControlPlan(db, input.companyId, input.id);
  if (!created) throw new Error("Failed to persist automation plan");
  return created;
}

async function markPlanConsumed(
  db: D1Database,
  companyId: string,
  planId: string,
  automationId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_control_plans
       SET status = 'consumed', consumed_automation_id = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(automationId, nowIso(), planId, companyId)
    .run();
}

export function managementUrlForCompany(env: Env, slug: string): string {
  return `${portalOrigin(env)}/portal/${slug}/automations`;
}

export async function planAutomationCreation(
  env: Env,
  input: {
    companyId: string;
    spec: AutomationControlSpec;
    actor: AutomationControlActor;
    kind?: "create" | "update";
    automationId?: string;
  },
) {
  const spec: AutomationControlSpec = { ...input.spec, companyId: input.companyId };
  const capabilities = await loadAutomationCapabilities(env.DB, input.companyId);
  const validation = validateAutomationControlSpec(spec, capabilities);
  if (!validation.ok || !validation.resolved || !validation.schedule || !validation.timezone || !validation.recipientEmail || !validation.name) {
    throw new AutomationControlError(
      validation.issues[0]?.message ?? "Automation plan is invalid.",
      validation.issues[0]?.code ?? "INVALID_PLAN",
      400,
      { issues: validation.issues },
    );
  }

  if (input.kind === "update" && input.automationId) {
    const existing = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
    if (!existing || isArchivedAutomation(existing)) {
      throw new AutomationControlError("Automation not found", "NOT_FOUND", 404);
    }
  }

  const company = await getCompanyById(env.DB, input.companyId);
  const fingerprint = materialAutomationFingerprint({
    templateKey: validation.resolved.templateKey,
    frequency: validation.schedule.frequency,
    hour: validation.schedule.hour ?? 0,
    minute: validation.schedule.minute ?? 0,
    timezone: validation.timezone,
    recipientEmail: validation.recipientEmail,
  });
  const duplicate = await findDuplicateAutomation(env.DB, input.companyId, fingerprint);
  const similar = await listSimilarAutomations(
    env.DB,
    input.companyId,
    validation.resolved.templateKey,
  );

  const description = describeAutomationPlan({
    name: validation.name,
    timezone: validation.timezone,
    schedule: validation.schedule,
    recipientEmail: validation.recipientEmail,
    resolved: validation.resolved,
    senderAddress: capabilities.senderAddress,
    companyName: company?.name ?? null,
  });

  const nextRunAt = computeNextRunUtcIso(validation.schedule, validation.timezone);
  const planId = newId("apl");
  const token = confirmationToken();
  const summary = {
    ...description,
    planId,
    templateKey: validation.resolved.templateKey,
    enabled: spec.enabled !== false,
    nextRun: nextRunAt,
    managementUrl: company ? managementUrlForCompany(env, company.slug) : null,
    duplicate: duplicate
      ? {
          id: duplicate.id,
          name: duplicate.name,
          status: duplicate.status,
          message: `You already have '${duplicate.name}' running at ${description.schedule.replace(/^Every (day|weekday) at /, "")}.`,
        }
      : null,
    similarAutomations: similar,
    requiresConfirmation: true,
    created: false,
  };

  const plan = await persistPlan(env.DB, {
    id: planId,
    companyId: input.companyId,
    kind: input.kind ?? "create",
    actor: input.actor.label,
    source: input.actor.source,
    spec: {
      ...spec,
      name: validation.name,
      recipientEmail: validation.recipientEmail,
      templateKey: validation.resolved.templateKey,
      automationId: input.automationId,
    },
    summary,
    confirmationToken: token,
    expiresAt: new Date(Date.now() + AUTOMATION_PLAN_TTL_MS).toISOString(),
  });

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "automation.planned",
    actor: input.actor.label,
    resourceType: "automation_plan",
    resourceId: plan.id,
    detail: {
      source: input.actor.source,
      kind: plan.kind,
      templateKey: validation.resolved.templateKey,
      name: validation.name,
      duplicateId: duplicate?.id ?? null,
    },
  });

  return {
    planId: plan.id,
    confirmationToken: token,
    status: "pending" as const,
    expiresAt: plan.expiresAt,
    valid: true,
    created: false,
    confirmationRequired: true,
    summary,
    spec: {
      companyId: input.companyId,
      name: validation.name,
      trigger: {
        type: "schedule" as const,
        frequency: validation.schedule.frequency,
        time: `${String(validation.schedule.hour ?? 0).padStart(2, "0")}:${String(validation.schedule.minute ?? 0).padStart(2, "0")}`,
        timezone: validation.timezone,
      },
      timezone: validation.timezone,
      steps: spec.steps ?? [
        {
          type: validation.resolved.requiresXero
            ? "XERO_MONTH_TO_DATE_SALES"
            : "KNOWLEDGE_DOCUMENT_ACTIVITY",
        },
        { type: "SEND_TRANSACTIONAL_REPORT_EMAIL" },
      ],
      recipients: [validation.recipientEmail],
      enabled: spec.enabled !== false,
    },
    issues: [] as { code: string; message: string }[],
  };
}

async function requireFreshPlan(
  db: D1Database,
  companyId: string,
  planId: string,
  confirmationTokenValue: string,
): Promise<AutomationControlPlanRecord> {
  const plan = await getAutomationControlPlan(db, companyId, planId);
  if (!plan) {
    throw new AutomationControlError(
      "Automation plan not found. Call automation_plan first.",
      "PLAN_NOT_FOUND",
      404,
    );
  }
  if (plan.status === "consumed") {
    throw new AutomationControlError(
      "This plan was already used to create or update an automation.",
      "PLAN_CONSUMED",
      409,
    );
  }
  if (plan.status !== "pending" || new Date(plan.expiresAt).getTime() < Date.now()) {
    throw new AutomationControlError(
      "This plan has expired. Create a new plan and confirm again.",
      "PLAN_EXPIRED",
      409,
    );
  }
  if (plan.confirmationToken !== confirmationTokenValue) {
    throw new AutomationControlError(
      "Confirmation token does not match this plan.",
      "CONFIRMATION_MISMATCH",
      403,
    );
  }
  return plan;
}

export async function createAutomationFromPlan(
  env: Env,
  input: {
    companyId: string;
    planId: string;
    confirmationToken: string;
    confirmed: boolean;
    allowDuplicate?: boolean;
    actor: AutomationControlActor;
  },
) {
  if (!input.confirmed) {
    throw new AutomationControlError(
      "Explicit confirmation is required to create a scheduled automation.",
      "CONFIRMATION_REQUIRED",
      400,
    );
  }
  const plan = await requireFreshPlan(
    env.DB,
    input.companyId,
    input.planId,
    input.confirmationToken,
  );
  if (plan.kind !== "create") {
    throw new AutomationControlError(
      "This plan is an update. Use automation_update.",
      "PLAN_KIND_MISMATCH",
      400,
    );
  }

  const capabilities = await loadAutomationCapabilities(env.DB, input.companyId);
  const validation = validateAutomationControlSpec(plan.spec, capabilities);
  if (!validation.ok || !validation.resolved || !validation.schedule || !validation.timezone || !validation.recipientEmail || !validation.name) {
    throw new AutomationControlError(
      validation.issues[0]?.message ?? "Automation is no longer valid.",
      validation.issues[0]?.code ?? "INVALID_PLAN",
      400,
      { issues: validation.issues },
    );
  }

  const fingerprint = materialAutomationFingerprint({
    templateKey: validation.resolved.templateKey,
    frequency: validation.schedule.frequency,
    hour: validation.schedule.hour ?? 0,
    minute: validation.schedule.minute ?? 0,
    timezone: validation.timezone,
    recipientEmail: validation.recipientEmail,
  });
  const duplicate = await findDuplicateAutomation(env.DB, input.companyId, fingerprint);
  if (duplicate && !input.allowDuplicate && !plan.spec.allowDuplicate) {
    throw new AutomationControlError(
      `You already have '${duplicate.name}' running at ${formatScheduleLabel(validation.schedule, validation.timezone)}.`,
      "DUPLICATE_AUTOMATION",
      409,
      { existingAutomationId: duplicate.id, name: duplicate.name },
    );
  }

  const nextRunAt = computeNextRunUtcIso(validation.schedule, validation.timezone);
  const enabled = plan.spec.enabled !== false;
  const created = await createAutomationDefinition(env.DB, {
    companyId: input.companyId,
    name: validation.name,
    description: validation.resolved.label,
    triggerType: "schedule",
    schedule: validation.schedule,
    timezone: validation.timezone,
    actionType: "internal",
    configuration: {
      handler: validation.resolved.templateKey,
      templateKey: validation.resolved.templateKey,
      createdVia: plan.source,
      parameters: { recipientEmail: validation.recipientEmail },
    },
    createdBy: input.actor.label,
    status: enabled ? "active" : "draft",
    nextRunAt: enabled ? nextRunAt : null,
  });

  let automation = created;
  if (enabled) {
    const serviceIdentityId = await ensureAutomationServiceIdentity(env.DB, created);
    automation =
      (await updateAutomationDefinition(env.DB, {
        companyId: input.companyId,
        automationId: created.id,
        patch: { status: "active", serviceIdentityId, nextRunAt },
      })) ?? created;
  }

  await markPlanConsumed(env.DB, input.companyId, plan.id, automation.id);
  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "automation.created",
    actor: input.actor.label,
    resourceType: "automation",
    resourceId: automation.id,
    detail: {
      source: plan.source,
      planId: plan.id,
      templateKey: validation.resolved.templateKey,
      name: automation.name,
      createdVia: plan.source,
    },
  });

  const company = await getCompanyById(env.DB, input.companyId);
  return {
    automation,
    managementUrl: company ? managementUrlForCompany(env, company.slug) : null,
    nextRun: automation.nextRunAt,
  };
}

export async function updateAutomationFromPlan(
  env: Env,
  input: {
    companyId: string;
    planId: string;
    confirmationToken: string;
    confirmed: boolean;
    actor: AutomationControlActor;
  },
) {
  if (!input.confirmed) {
    throw new AutomationControlError(
      "Explicit confirmation is required to change a scheduled automation.",
      "CONFIRMATION_REQUIRED",
      400,
    );
  }
  const plan = await requireFreshPlan(
    env.DB,
    input.companyId,
    input.planId,
    input.confirmationToken,
  );
  const automationId = plan.spec.automationId;
  if (plan.kind !== "update" || !automationId) {
    throw new AutomationControlError(
      "This plan is not an update. Use automation_create.",
      "PLAN_KIND_MISMATCH",
      400,
    );
  }
  return applyValidatedUpdate(env, {
    companyId: input.companyId,
    automationId,
    spec: plan.spec,
    actor: input.actor,
    planId: plan.id,
  });
}

export async function applyValidatedUpdate(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    spec: Partial<AutomationControlSpec>;
    actor: AutomationControlActor;
    planId?: string;
  },
) {
  const existing = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!existing || isArchivedAutomation(existing)) {
    throw new AutomationControlError("Automation not found", "NOT_FOUND", 404);
  }

  const currentRecipient =
    typeof (existing.configuration.parameters as { recipientEmail?: string } | undefined)
      ?.recipientEmail === "string"
      ? String((existing.configuration.parameters as { recipientEmail: string }).recipientEmail)
      : "";
  const merged: AutomationControlSpec = {
    companyId: input.companyId,
    name: input.spec.name ?? existing.name,
    templateKey:
      input.spec.templateKey ??
      (typeof existing.configuration.templateKey === "string"
        ? existing.configuration.templateKey
        : undefined),
    trigger: input.spec.trigger ?? {
      type: "schedule",
      frequency: existing.schedule?.frequency ?? "daily",
      time: `${String(existing.schedule?.hour ?? 8).padStart(2, "0")}:${String(existing.schedule?.minute ?? 0).padStart(2, "0")}`,
      timezone: existing.timezone,
    },
    timezone: input.spec.timezone ?? input.spec.trigger?.timezone ?? existing.timezone,
    recipientEmail: input.spec.recipientEmail ?? specRecipientSafe(input.spec) ?? currentRecipient,
    recipients: input.spec.recipients,
    steps: input.spec.steps,
    enabled: input.spec.enabled,
  };

  const capabilities = await loadAutomationCapabilities(env.DB, input.companyId);
  const validation = validateAutomationControlSpec(merged, capabilities);
  if (!validation.ok || !validation.resolved || !validation.schedule || !validation.timezone || !validation.recipientEmail || !validation.name) {
    throw new AutomationControlError(
      validation.issues[0]?.message ?? "Update is invalid.",
      validation.issues[0]?.code ?? "INVALID_UPDATE",
      400,
      { issues: validation.issues },
    );
  }

  const nextRunAt =
    existing.status === "active"
      ? computeNextRunUtcIso(validation.schedule, validation.timezone)
      : existing.nextRunAt;

  const updated = await updateAutomationDefinition(env.DB, {
    companyId: input.companyId,
    automationId: existing.id,
    patch: {
      name: validation.name,
      schedule: validation.schedule,
      timezone: validation.timezone,
      triggerType: "schedule",
      actionType: "internal",
      configuration: {
        ...existing.configuration,
        handler: validation.resolved.templateKey,
        templateKey: validation.resolved.templateKey,
        createdVia: automationCreatedViaOf(existing.configuration) ?? existing.configuration.createdVia,
        parameters: {
          ...((existing.configuration.parameters as Record<string, unknown>) ?? {}),
          recipientEmail: validation.recipientEmail,
        },
      },
      nextRunAt: existing.triggerType === "schedule" ? nextRunAt : null,
    },
  });

  if (input.planId) {
    await markPlanConsumed(env.DB, input.companyId, input.planId, existing.id);
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "automation.updated",
    actor: input.actor.label,
    resourceType: "automation",
    resourceId: existing.id,
    detail: {
      source: input.actor.source,
      planId: input.planId ?? null,
      name: updated?.name,
    },
  });

  return updated;
}

function specRecipientSafe(spec: Partial<AutomationControlSpec>): string | null {
  const fromList = spec.recipients?.find((item) => typeof item === "string" && item.trim());
  const raw = (fromList ?? spec.recipientEmail ?? "").trim().toLowerCase();
  return raw && isValidRecipientEmail(raw) ? raw : null;
}

export async function archiveAutomation(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    actor: AutomationControlActor;
  },
) {
  const existing = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!existing) {
    throw new AutomationControlError("Automation not found", "NOT_FOUND", 404);
  }
  if (isArchivedAutomation(existing)) {
    return existing;
  }
  const updated = await updateAutomationDefinition(env.DB, {
    companyId: input.companyId,
    automationId: existing.id,
    patch: {
      status: "disabled",
      nextRunAt: null,
      configuration: {
        ...existing.configuration,
        archived: true,
        archivedAt: nowIso(),
        archivedBy: input.actor.label,
      },
    },
  });
  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "automation.archived",
    actor: input.actor.label,
    resourceType: "automation",
    resourceId: existing.id,
    detail: { source: input.actor.source, name: existing.name },
  });
  return updated;
}

export async function setAutomationPaused(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    paused: boolean;
    actor: AutomationControlActor;
  },
) {
  const existing = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!existing || isArchivedAutomation(existing)) {
    throw new AutomationControlError("Automation not found", "NOT_FOUND", 404);
  }
  if (input.paused) {
    const updated = await updateAutomationDefinition(env.DB, {
      companyId: input.companyId,
      automationId: existing.id,
      patch: { status: "paused" },
    });
    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "automation.paused",
      actor: input.actor.label,
      resourceType: "automation",
      resourceId: existing.id,
      detail: { source: input.actor.source },
    });
    return updated;
  }

  const serviceIdentityId = await ensureAutomationServiceIdentity(env.DB, existing);
  let nextRunAt = existing.nextRunAt;
  if (existing.triggerType === "schedule" && existing.schedule) {
    nextRunAt = computeNextRunUtcIso(existing.schedule, existing.timezone);
  }
  const updated = await updateAutomationDefinition(env.DB, {
    companyId: input.companyId,
    automationId: existing.id,
    patch: {
      status: "active",
      serviceIdentityId,
      nextRunAt,
      failureCount: 0,
    },
  });
  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "automation.resumed",
    actor: input.actor.label,
    resourceType: "automation",
    resourceId: existing.id,
    detail: { source: input.actor.source },
  });
  return updated;
}

export async function runAutomationNow(
  env: Env,
  input: {
    companyId: string;
    automationId: string;
    actor: AutomationControlActor;
    triggerType?: "portal_manual" | "mcp_manual" | "manual";
    idempotencyKey?: string | null;
  },
) {
  const existing = await getAutomationDefinition(env.DB, input.companyId, input.automationId);
  if (!existing || isArchivedAutomation(existing)) {
    throw new AutomationControlError("Automation not found", "NOT_FOUND", 404);
  }
  if (existing.status === "disabled") {
    throw new AutomationControlError("Automation is disabled", "DISABLED", 409);
  }
  const snapshot = {
    status: existing.status,
    timezone: existing.timezone,
    nextRunAt: existing.nextRunAt,
    schedule: existing.schedule,
  };
  const result = await requestAutomationRun(env, {
    companyId: input.companyId,
    automationId: existing.id,
    initiatedBy: input.actor.label,
    triggerType: input.triggerType ?? "mcp_manual",
    idempotencyKey: input.idempotencyKey ?? null,
  });
  const after = await getAutomationDefinition(env.DB, input.companyId, existing.id);
  return {
    ...result,
    scheduleUnchanged: true,
    preserved: {
      status: after?.status ?? snapshot.status,
      timezone: after?.timezone ?? snapshot.timezone,
      nextRunAt: after?.nextRunAt ?? snapshot.nextRunAt,
      schedule: after?.schedule ?? snapshot.schedule,
    },
  };
}
