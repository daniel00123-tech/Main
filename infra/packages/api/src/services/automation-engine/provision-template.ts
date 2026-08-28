/**
 * Instantiate a reusable automation template for a company.
 * Does not hard-code any tenant — callers supply companyId and recipient.
 */

import {
  automationTemplateKeyOf,
  getAutomationTemplate,
  isValidRecipientEmail,
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
    createdBy: string;
    activate?: boolean;
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

  const schedule = {
    ...template.defaultSchedule,
    hour: input.hour ?? template.defaultSchedule.hour ?? 8,
    minute: input.minute ?? template.defaultSchedule.minute ?? 0,
  };
  const timezone = input.timezone?.trim() || template.defaultTimezone;
  const configuration = {
    handler: template.key,
    templateKey: template.key,
    parameters: { recipientEmail: recipient },
  };
  const nextRunAt = computeNextRunUtcIso(schedule, timezone);
  const existing = await findAutomationByTemplateKey(db, input.companyId, template.key);

  if (existing) {
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
