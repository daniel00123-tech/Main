/**
 * Automation action handlers — extensible registry.
 */

import type { Env } from "../../env";
import type { AutomationActionType, AutomationDefinitionRecord } from "@infra/shared";
import { executeAiPromptAction } from "./ai-prompt";
import { executeInternalAction } from "./internal";
import { executeMcpToolAction } from "./mcp-tool";

export type AutomationExecutionContext = {
  companyId: string;
  companySlug: string;
  automation: AutomationDefinitionRecord;
  runId: string;
  initiatedBy: string | null;
  serviceIdentityId: string | null;
};

export type AutomationActionResult = {
  summary: string;
  result: Record<string, unknown>;
};

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
    return null;
  }
  return "Unknown action type";
}
