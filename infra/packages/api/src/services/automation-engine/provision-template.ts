/**
 * Instantiate a reusable automation template for a company.
 * Does not hard-code any tenant — callers supply companyId and recipient.
 */

import {
  AUTOMATION_SCHEDULE_FREQUENCIES,
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  getAutomationTemplate,
  isArchivedAutomation,
  isValidRecipientEmail,
  materialAutomationFingerprint,
  type AutomationCreatedVia,
  type AutomationScheduleFrequency,
} from "@infra/shared";
import { computeNextRunUtcIso } from "./schedule";
import {
  createAutomationDefinition,
  listAutomationDefinitions,
  updateAutomationDefinition,
} from "./store";
import { ensureAutomationServiceIdentity } from "./permissions";

export async function findAutomationByTemplateKey(
  db: D1Database,
  companyId: string,
  templateKey: string,
) {
  const items = await listAutomationDefinitions(db, companyId);
  return (
    items.find((item) => automationTemplateKeyOf(item.configuration) === templateKey) ?? null
  );
}

export async function provisionTemplateAutomation(
  db: D1Database,
  input: {
    companyId: string;
    templateKey: string;
    recipientEmail: string;
    name?: string;
    timezone?: string;
    hour?: number;
    minute?: number;
    frequency?: AutomationScheduleFrequency;
    createdBy: string;
    activate?: boolean;
    createdVia?: AutomationCreatedVia;
    allowDuplicate?: boolean;
    onExisting?: "update" | "reject";
  },
) {
  const template = getAutomationTemplate(input.templateKey);
  if (!template || !template.available) {
    throw new Error("Unknown or unavailable automation template");
  }
  const recipient = input.recipientEmail.trim().toLowerCase();
  if (!isValidRecipientEmail(recipient)) {
    throw new Error("A valid recipient email is required");
  }

  const frequency: AutomationScheduleFrequency =
    input.frequency && AUTOMATION_SCHEDULE_FREQUENCIES.includes(input.frequency)
      ? input.frequency
      : template.defaultSchedule.frequency;
  const schedule = {
    ...template.defaultSchedule,
    frequency,
    hour: input.hour ?? template.defaultSchedule.hour ?? 8,
    minute: input.minute ?? template.defaultSchedule.minute ?? 0,
  };
  const timezone = input.timezone?.trim() || template.defaultTimezone;
  const configuration = {
    handler: template.key,
    templateKey: template.key,
    createdVia: input.createdVia ?? "api",
    parameters: { recipientEmail: recipient },
  };
  const nextRunAt = computeNextRunUtcIso(schedule, timezone);
  const existing = await findAutomationByTemplateKey(db, input.companyId, template.key);
  const fingerprint = materialAutomationFingerprint({
    templateKey: template.key,
    frequency: schedule.frequency,
    hour: schedule.hour ?? 8,
    minute: schedule.minute ?? 0,
    timezone,
    recipientEmail: recipient,
  });
  const existingLive =
    existing && !isArchivedAutomation(existing) && ["active", "paused", "draft"].includes(existing.status)
      ? existing
      : null;
  const existingFingerprint = existingLive
    ? materialAutomationFingerprint({
        templateKey: template.key,
        frequency: existingLive.schedule?.frequency ?? "daily",
        hour: existingLive.schedule?.hour ?? 8,
        minute: existingLive.schedule?.minute ?? 0,
        timezone: existingLive.timezone,
        recipientEmail: automationRecipientEmailOf(existingLive.configuration) ?? recipient,
      })
    : null;

  if (existingLive && input.onExisting !== "update" && !input.allowDuplicate) {
    const same = existingFingerprint === fingerprint;
    if (same || input.onExisting === "reject") {
      throw new Error(
        `You already have '${existingLive.name}' running at ${String(existingLive.schedule?.hour ?? 8).padStart(2, "0")}:${String(existingLive.schedule?.minute ?? 0).padStart(2, "0")}.`,
      );
    }
  }

  if (existing && input.onExisting === "update") {
    const updated = await updateAutomationDefinition(db, {
      companyId: input.companyId,
      automationId: existing.id,
      patch: {
        name: input.name?.trim() || existing.name,
        description: template.description,
        triggerType: "schedule",
        schedule,
        timezone,
        actionType: "internal",
        configuration,
        nextRunAt: existing.status === "active" ? nextRunAt : existing.nextRunAt,
      },
    });
    return updated ?? existing;
  }

  const created = await createAutomationDefinition(db, {
    companyId: input.companyId,
    name: input.name?.trim() || template.defaultName,
    description: template.description,
    triggerType: "schedule",
    schedule,
    timezone,
    actionType: "internal",
    configuration,
    createdBy: input.createdBy,
    status: input.activate ? "active" : "draft",
    nextRunAt: input.activate ? nextRunAt : null,
  });

  if (input.activate) {
    const serviceIdentityId = await ensureAutomationServiceIdentity(db, created);
    return (
      (await updateAutomationDefinition(db, {
        companyId: input.companyId,
        automationId: created.id,
        patch: { status: "active", serviceIdentityId, nextRunAt },
      })) ?? created
    );
  }

  return created;
}
