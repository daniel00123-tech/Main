/**
 * Provision the EL Business daily knowledge-activity automation.
 * Reuses the existing Automation Engine and the Caddington recipient.
 * Does not create or modify the Caddington automation.
 */

import {
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  isArchivedAutomation,
} from "@infra/shared";
import { provisionTemplateAutomation } from "./provision-template";
import { listAutomationDefinitions } from "./store";

const EL_COMPANY_ID = "co_el";
const CADDINGTON_COMPANY_ID = "co_caddington";
const EL_AUTOMATION_NAME = "Daily EL knowledge activity";

export async function resolveExistingDocumentActivityRecipient(db: D1Database): Promise<string | null> {
  const items = await listAutomationDefinitions(db, CADDINGTON_COMPANY_ID);
  const live = items.find(
    (item) =>
      !isArchivedAutomation(item) &&
      item.status === "active" &&
      automationTemplateKeyOf(item.configuration) === DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  );
  return live ? automationRecipientEmailOf(live.configuration) : null;
}

export async function provisionElKnowledgeActivityAutomation(
  db: D1Database,
  input?: { createdBy?: string; activate?: boolean },
) {
  const recipient = await resolveExistingDocumentActivityRecipient(db);
  if (!recipient) {
    throw new Error("Caddington daily document activity recipient is not configured");
  }
  return provisionTemplateAutomation(db, {
    companyId: EL_COMPANY_ID,
    templateKey: KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
    recipientEmail: recipient,
    name: EL_AUTOMATION_NAME,
    timezone: "Europe/London",
    hour: 8,
    minute: 0,
    frequency: "daily",
    createdBy: input?.createdBy ?? "system:el-knowledge-activity",
    activate: input?.activate !== false,
    createdVia: "api",
    onExisting: "update",
  });
}
