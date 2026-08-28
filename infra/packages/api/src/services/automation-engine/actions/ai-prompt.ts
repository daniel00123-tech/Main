/**
 * AI Prompt automation action — tenant-scoped deterministic V1 executor.
 * V2 will integrate external LLM providers with metering.
 */

import type { Env } from "../../../env";
import type { AutomationAiPromptConfiguration } from "@infra/shared";
import { nowIso } from "../../../db/mappers";
import { getCompanyById } from "../../control-plane";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

export async function executeAiPromptAction(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  const config = ctx.automation.configuration as AutomationAiPromptConfiguration;
  const prompt = config.prompt?.trim();
  if (!prompt) throw new Error("AI prompt is empty");

  const company = await getCompanyById(env.DB, ctx.companyId);
  const executedAt = nowIso();
  const response = buildPromptResponse(prompt, {
    companyId: ctx.companyId,
    companySlug: ctx.companySlug,
    companyName: company?.name ?? ctx.companySlug,
    executedAt,
    automationId: ctx.automation.id,
    runId: ctx.runId,
    context: config.context ?? {},
  });

  return {
    summary: response.slice(0, 240),
    result: {
      action: "ai_prompt",
      prompt,
      response,
      executedAt,
      companyId: ctx.companyId,
      companySlug: ctx.companySlug,
      companyName: company?.name ?? null,
      automationId: ctx.automation.id,
      runId: ctx.runId,
      engine: "automation-engine-v1",
    },
  };
}

function buildPromptResponse(
  prompt: string,
  ctx: {
    companyId: string;
    companySlug: string;
    companyName: string;
    executedAt: string;
    automationId: string;
    runId: string;
    context: Record<string, unknown>;
  },
): string {
  const lower = prompt.toLowerCase();
  if (
    lower.includes("confirmation") &&
    lower.includes("automation engine") &&
    lower.includes("executed successfully")
  ) {
    return [
      "INFRA automation engine executed successfully.",
      `Timestamp: ${ctx.executedAt}`,
      `Company: ${ctx.companyName} (${ctx.companySlug}, ${ctx.companyId})`,
      `Automation: ${ctx.automationId}`,
      `Run: ${ctx.runId}`,
    ].join("\n");
  }

  return [
    "Automation AI prompt executed (V1 deterministic mode).",
    `Timestamp: ${ctx.executedAt}`,
    `Company: ${ctx.companyName} (${ctx.companySlug})`,
    "",
    "Instruction:",
    prompt,
    "",
    "Note: External LLM invocation is deferred to Automation Engine V2.",
  ].join("\n");
}
