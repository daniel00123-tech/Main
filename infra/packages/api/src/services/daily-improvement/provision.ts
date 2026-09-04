/**
 * Provision the three platform daily-improvement automations.
 * Does not create a new Worker. Does not touch the 08:00 EL knowledge automation.
 */

import {
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  automationTemplateKeyOf,
  isArchivedAutomation,
} from "@infra/shared";
import { computeNextRunUtcIso } from "../automation-engine/schedule";
import {
  createAutomationDefinition,
  listAutomationDefinitions,
  updateAutomationDefinition,
} from "../automation-engine/store";
import { ensureAutomationServiceIdentity } from "../automation-engine/permissions";
import { EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID } from "./constants";

const SPECS = [
  {
    key: DAILY_IMPROVEMENT_QA_TEMPLATE,
    name: "INFRA Daily improvement QA",
    hour: 16,
    minute: 30,
    description: "16:30 Europe/London QA window over genuine customer interactions.",
  },
  {
    key: DAILY_IMPROVEMENT_REPORT_TEMPLATE,
    name: "INFRA Daily improvement report",
    hour: 17,
    minute: 0,
    description: "17:00 Europe/London informational Daily Improvement Report.",
  },
  {
    key: DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
    name: "INFRA Daily improvement engineering",
    hour: 17,
    minute: 5,
    description: "17:05 Europe/London automatic engineering cycle. No approval.",
  },
] as const;

export async function resolvePlatformAutomationCompanyId(db: D1Database): Promise<string | null> {
  const adminCompany = await db
    .prepare(
      `SELECT m.company_id AS id
       FROM company_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE u.is_platform_admin = 1 AND u.status = 'active'
       LIMIT 1`,
    )
    .first<{ id: string }>()
    .catch(() => null);
  if (adminCompany?.id) return adminCompany.id;
  const any = await db.prepare(`SELECT id FROM companies LIMIT 1`).first<{ id: string }>().catch(() => null);
  return any?.id ?? null;
}

export async function provisionDailyImprovementAutomations(
  db: D1Database,
): Promise<{ companyId: string | null; created: string[]; updated: string[]; skippedKnowledge: true }> {
  const companyId = await resolvePlatformAutomationCompanyId(db);
  if (!companyId) {
    return { companyId: null, created: [], updated: [], skippedKnowledge: true };
  }
  const existing = await listAutomationDefinitions(db, companyId);
  const created: string[] = [];
  const updated: string[] = [];
  for (const spec of SPECS) {
    const found = existing.find(
      (item) =>
        !isArchivedAutomation(item) &&
        item.id !== EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID &&
        automationTemplateKeyOf(item.configuration) === spec.key,
    );
    const schedule = { frequency: "daily" as const, hour: spec.hour, minute: spec.minute };
    const configuration = {
      handler: spec.key,
      templateKey: spec.key,
      createdVia: "system",
      parameters: { platform: true },
    };
    const nextRunAt = computeNextRunUtcIso(schedule, "Europe/London");
    if (found) {
      if (found.id === EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID) continue;
      await updateAutomationDefinition(db, {
        companyId,
        automationId: found.id,
        patch: {
          name: spec.name,
          description: spec.description,
          triggerType: "schedule",
          schedule,
          timezone: "Europe/London",
          actionType: "internal",
          configuration,
          nextRunAt: found.status === "active" ? nextRunAt : found.nextRunAt,
        },
      });
      updated.push(spec.key);
      continue;
    }
    const createdDef = await createAutomationDefinition(db, {
      companyId,
      name: spec.name,
      description: spec.description,
      triggerType: "schedule",
      schedule,
      timezone: "Europe/London",
      actionType: "internal",
      configuration,
      createdBy: "system:daily-improvement",
      status: "draft",
      nextRunAt,
    });
    const serviceIdentityId = await ensureAutomationServiceIdentity(db, createdDef);
    await updateAutomationDefinition(db, {
      companyId,
      automationId: createdDef.id,
      patch: { status: "active", serviceIdentityId, nextRunAt },
    });
    created.push(spec.key);
  }
  return { companyId, created, updated, skippedKnowledge: true };
}
