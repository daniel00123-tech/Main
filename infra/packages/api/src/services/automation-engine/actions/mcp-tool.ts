/**
 * MCP tool automation action — uses gateway permission model via service identity.
 */

import type { Env } from "../../../env";
import type { AutomationMcpToolConfiguration } from "@infra/shared";
import { authenticateServiceToken, getServiceIdentity } from "../../service-identities";
import { evaluateServiceActionPermission } from "../../service-identities";
import { resolveToolAction } from "../../mcp-knowledge-standard";
import type { AutomationActionResult, AutomationExecutionContext } from "../actions/index";

export async function executeMcpToolAction(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  if (!ctx.serviceIdentityId) {
    throw new Error("Automation has no service identity for MCP tool execution");
  }

  const identity = await getServiceIdentity(env.DB, ctx.serviceIdentityId);
  if (!identity || identity.companyId !== ctx.companyId || identity.status !== "active") {
    throw new Error("Automation service identity is invalid or disabled");
  }

  const config = ctx.automation.configuration as AutomationMcpToolConfiguration;
  const toolName = config.toolName.trim();
  const action = resolveToolAction(toolName);
  if (!action) throw new Error(`Unknown or unsupported MCP tool: ${toolName}`);

  const permission = await evaluateServiceActionPermission(env.DB, identity, action);
  if (!permission.allowed) {
    throw new Error(permission.reason ?? "Automation service identity lacks permission for tool");
  }

  const { executeGatewayRequest } = await import("../../gateway");
  const result = await executeGatewayRequest(env, {
    companyId: ctx.companyId,
    toolName,
    arguments: config.arguments ?? {},
    serviceIdentity: identity,
    sourceClient: "automation-engine",
    correlationId: ctx.runId,
    requestId: `automation_${ctx.runId}`,
  });

  if (!result.ok) {
    throw new Error(result.error ?? "MCP tool execution failed");
  }

  const summary =
    typeof result.data === "object" && result.data && "summary" in result.data
      ? String((result.data as { summary?: string }).summary)
      : `Executed ${toolName}`;

  return {
    summary: summary.slice(0, 240),
    result: {
      action: "mcp_tool",
      toolName,
      data: result.data ?? null,
      meteringRecordedByGateway: true,
    },
  };
}
