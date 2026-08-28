/**
 * Reusable daily document activity email — read-only knowledge metadata + transactional email.
 */

import {
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  capActivityList,
  formatCivilDateLong,
  formatClock,
  isValidRecipientEmail,
  renderDocumentActivityReportEmail,
  zonedCivilParts,
} from "@infra/shared";
import type { Env } from "../../../env";
import { getCompanyById } from "../../control-plane";
import { sendTransactionalEmail } from "../../email/send-transactional";
import { portalOrigin } from "../../public-urls";
import { recordUsageEvent } from "../../usage";
import { queryDocumentActivity } from "../document-activity-query";
import { AutomationActionError } from "./errors";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

const STORE_FAILURE_MESSAGE = "We couldn't retrieve document activity.";
const EMAIL_FAILURE_MESSAGE = "We couldn't send the document activity email.";

export async function executeDocumentActivityDailyEmail(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  const recipient = automationRecipientEmailOf(ctx.automation.configuration);
  if (!recipient || !isValidRecipientEmail(recipient)) {
    throw new AutomationActionError(
      "A valid recipient email is required.",
      false,
      "RECIPIENT_REQUIRED",
    );
  }

  const company = await getCompanyById(env.DB, ctx.companyId);
  if (!company) {
    throw new AutomationActionError("Company not found", false, "COMPANY_NOT_FOUND");
  }

  const now = new Date();
  let report;
  try {
    report = await queryDocumentActivity(env, ctx.companyId, now);
  } catch {
    throw new AutomationActionError(STORE_FAILURE_MESSAGE, false, "DOCUMENT_STORE_UNAVAILABLE", {
      handler: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
      templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
      companyId: ctx.companyId,
      emailSent: false,
      customerSummary: "Couldn't retrieve document activity",
    });
  }

  await recordUsageEvent(env.DB, {
    companyId: ctx.companyId,
    actorEmail: ctx.initiatedBy ?? "system:automation-engine",
    resourceType: "automation",
    resourceId: ctx.automation.id,
    action: "document.activity.summary",
    toolName: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
    quantity: 1,
    unit: "request",
    success: true,
    sourceClient: "automation-engine",
    correlationId: `${ctx.runId}:documents`,
    requestId: `automation_docs_${ctx.runId}`,
    metadata: {
      readOnly: true,
      triggeredProviderScan: false,
      windowFrom: report.windowFrom,
      windowTo: report.windowTo,
    },
  });

  const timeZone = ctx.automation.timezone || "Europe/London";
  const parts = zonedCivilParts(now, timeZone);
  const asOfLabel = `${formatClock(parts.hour, parts.minute)} on ${formatCivilDateLong(
    `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
  )}`;
  const newCapped = capActivityList(report.newDocuments);
  const updatedCapped = capActivityList(report.updatedDocuments);
  const portalUrl = `${portalOrigin(env)}/portal/${company.slug}/automations`;
  const email = renderDocumentActivityReportEmail({
    companyDisplayName: company.name,
    asOfLabel,
    sourceCounts: report.sourceCounts.map((row) => ({ label: row.label, count: row.count })),
    totalCount: report.totalCount,
    newDocuments: newCapped.items.map((item) => ({ title: item.title, sourceLabel: item.sourceLabel })),
    updatedDocuments: updatedCapped.items.map((item) => ({
      title: item.title,
      sourceLabel: item.sourceLabel,
    })),
    newCount: report.newCount,
    updatedCount: report.updatedCount,
    combinedActivity: false,
    omittedNew: Math.max(0, report.newCount - newCapped.items.length),
    omittedUpdated: Math.max(0, report.updatedCount - updatedCapped.items.length),
    portalUrl,
  });

  const resultBase = {
    handler: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
    templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
    companyId: ctx.companyId,
    windowFrom: report.windowFrom,
    windowTo: report.windowTo,
    sourceCounts: report.sourceCounts,
    totalCount: report.totalCount,
    newCount: report.newCount,
    updatedCount: report.updatedCount,
    recipientEmail: recipient,
    triggeredProviderScan: false,
    emailSent: false,
    customerSummary: "Document activity report generated",
  };

  const delivery = await sendTransactionalEmail(env, env.DB, {
    companyId: ctx.companyId,
    type: "DOCUMENT_ACTIVITY_REPORT",
    recipient,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
    actor: `automation:${ctx.runId}`,
  });

  if (!delivery.sent) {
    throw new AutomationActionError(EMAIL_FAILURE_MESSAGE, false, "EMAIL_DELIVERY_FAILED", {
      ...resultBase,
      emailId: delivery.id,
      emailError: delivery.error,
      customerSummary: "Document activity report generated, email not sent",
    });
  }

  return {
    summary: "Document activity report sent",
    result: {
      ...resultBase,
      emailSent: true,
      emailId: delivery.id,
      customerSummary: "Document activity report sent",
    },
  };
}
