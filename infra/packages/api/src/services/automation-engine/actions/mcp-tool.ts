/**
 * MCP tool automation action — uses gateway permission model via service identity.
 */

import type { Env } from "../../../env";
import type { AutomationMcpToolConfiguration } from "@infra/shared";
import { isXeroMutationToolName } from "@infra/shared";
import { getServiceIdentity } from "../../service-identities";
import { executeGatewayRequest } from "../../gateway";
import { isActionControlTool } from "../../mcp-action-tools";
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
  if (!toolName) throw new Error("MCP tool name is required");

  if (isXeroMutationToolName(toolName)) {
    throw new Error("Automations cannot invoke mutating Xero MCP tools");
  }
  if (
    isActionControlTool(toolName) &&
    (toolName === "execute_action_plan" || toolName.startsWith("plan_xero_"))
  ) {
    throw new Error("Automations cannot plan or execute Xero write actions");
  }

  const result = await executeGatewayRequest(env, {
    actor: { type: "service", identity },
    companyId: ctx.companyId,
    toolName,
    arguments: config.arguments ?? {},
    sourceClient: "automation-engine",
    clientRequestId: ctx.runId,
  });

  if (result.status !== 200) {
    throw new Error("error" in result ? result.error : "MCP tool execution failed");
  }

  const summary = `Executed ${toolName}`;

  return {
    summary: summary.slice(0, 240),
    result: {
      action: "mcp_tool",
      toolName,
      gatewayRequestId: result.gatewayRequestId,
      correlationId: result.correlationId,
      data: result.result ?? null,
      meteringRecordedByGateway: true,
    },
  };
}
