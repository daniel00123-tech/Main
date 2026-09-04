/**
 * Internal INFRA-native automation actions — no arbitrary code execution.
 */

import type { Env } from "../../../env";
import {
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  type AutomationInternalConfiguration,
} from "@infra/shared";
import { nowIso } from "../../../db/mappers";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";
import { executeDocumentActivityDailyEmail } from "./document-activity-email";
import { executeKnowledgeIngestionDailyEmail } from "./knowledge-ingestion-email";
import { executeXeroMonthToDateSalesEmail } from "./xero-sales-email";

const ALLOWED_HANDLERS = new Set([
  "noop",
  "health_ping",
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
]);

export async function executeInternalAction(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  const config = ctx.automation.configuration as AutomationInternalConfiguration;
  const handler = config.handler?.trim();
  if (!handler || !ALLOWED_HANDLERS.has(handler)) {
    throw new Error(`Internal handler not allowed: ${handler ?? "(missing)"}`);
  }

  if (handler === "noop") {
    return {
      summary: "Internal noop completed",
      result: { handler, executedAt: nowIso(), companyId: ctx.companyId },
    };
  }

  if (handler === "health_ping") {
    const row = await env.DB.prepare("SELECT 1 AS ok").first();
    return {
      summary: row ? "Health ping OK" : "Health ping failed",
      result: { handler, d1: Boolean(row), executedAt: nowIso() },
    };
  }

  if (handler === XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE) {
    return executeXeroMonthToDateSalesEmail(env, ctx);
  }

  if (handler === DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE) {
    return executeDocumentActivityDailyEmail(env, ctx);
  }

  if (handler === KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE) {
    return executeKnowledgeIngestionDailyEmail(env, ctx);
  }

  if (handler === DAILY_IMPROVEMENT_QA_TEMPLATE) {
    const { runDailyImprovementQa } = await import("../../daily-improvement");
    const result = await runDailyImprovementQa(env);
    return { summary: `Daily improvement QA ${result.reason}`, result };
  }

  if (handler === DAILY_IMPROVEMENT_REPORT_TEMPLATE) {
    const { runDailyImprovementReport } = await import("../../daily-improvement");
    const result = await runDailyImprovementReport(env);
    return { summary: `Daily improvement report ${result.reason}`, result };
  }

  if (handler === DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE) {
    const { runDailyImprovementEngineering } = await import("../../daily-improvement");
    const result = await runDailyImprovementEngineering(env);
    return { summary: `Daily improvement engineering ${result.reason}`, result };
  }

  throw new Error("Unhandled internal action");
}
