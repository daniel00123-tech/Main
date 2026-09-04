/**
 * Automation action handlers — extensible registry.
 */

import type { Env } from "../../env";
import {
  isValidRecipientEmail,
  type AutomationActionType,
  DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE,
  DAILY_IMPROVEMENT_QA_TEMPLATE,
  DAILY_IMPROVEMENT_REPORT_TEMPLATE,
  DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
  KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE,
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
} from "@infra/shared";
import { executeAiPromptAction } from "./ai-prompt";
import { executeInternalAction } from "./internal";
import { executeMcpToolAction } from "./mcp-tool";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

export type { AutomationActionResult, AutomationExecutionContext } from "./types";

export async function executeAutomationAction(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  switch (ctx.automation.actionType) {
    case "ai_prompt":
      return executeAiPromptAction(env, ctx);
    case "mcp_tool":
      return executeMcpToolAction(env, ctx);
    case "internal":
      return executeInternalAction(env, ctx);
    default:
      throw new Error(`Unsupported action type: ${ctx.automation.actionType satisfies never}`);
  }
}

export function validateAutomationConfiguration(
  actionType: AutomationActionType,
  configuration: Record<string, unknown>,
): string | null {
  if (actionType === "ai_prompt") {
    const prompt = configuration.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) return "AI prompt action requires a non-empty prompt";
    if (prompt.length > 20_000) return "Prompt exceeds maximum length";
    return null;
  }
  if (actionType === "mcp_tool") {
    const toolName = configuration.toolName;
    if (typeof toolName !== "string" || !toolName.trim()) return "MCP tool action requires toolName";
    if (toolName.includes("://")) return "Invalid tool name";
    return null;
  }
  if (actionType === "internal") {
    const handler = configuration.handler;
    if (typeof handler !== "string" || !handler.trim()) return "Internal action requires handler";
    if (
      handler === DAILY_IMPROVEMENT_QA_TEMPLATE ||
      handler === DAILY_IMPROVEMENT_REPORT_TEMPLATE ||
      handler === DAILY_IMPROVEMENT_ENGINEERING_TEMPLATE
    ) {
      return null;
    }
    if (
      handler === XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE ||
      handler === DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE ||
      handler === KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE
    ) {
      const params = (configuration.parameters ?? {}) as Record<string, unknown>;
      const recipient = String(params.recipientEmail ?? configuration.recipientEmail ?? "");
      if (!isValidRecipientEmail(recipient)) {
        if (handler === DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE) {
          return "Daily document activity requires a valid recipient email";
        }
        if (handler === KNOWLEDGE_INGESTION_DAILY_EMAIL_TEMPLATE) {
          return "Daily knowledge activity requires a valid recipient email";
        }
        return "Daily sales email requires a valid recipient email";
      }
    }
    return null;
  }
  return "Unknown action type";
}
