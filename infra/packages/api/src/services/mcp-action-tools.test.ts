import { describe, expect, it } from "vitest";
import {
  ACTION_CONTROL_TOOLS,
  actionControlToolAllowed,
  withActionControlTools,
} from "./mcp-action-tools";
import { XERO_ACTION_SERVICE_SCOPES } from "@infra/shared";

describe("action control tool scopes", () => {
  it("requires matching scope per action tool", () => {
    expect(actionControlToolAllowed("plan_xero_draft_invoice", ["xero.action.plan"])).toBe(
      true,
    );
    expect(actionControlToolAllowed("plan_xero_draft_invoice", ["xero.action.read"])).toBe(
      false,
    );
    expect(actionControlToolAllowed("confirm_action_plan", ["xero.action.confirm"])).toBe(
      true,
    );
    expect(actionControlToolAllowed("list_pending_actions", ["xero.action.list"])).toBe(true);
  });

  it("withActionControlTools omits tools when identity lacks action scopes", () => {
    const base = [{ name: "system_health", description: "health", inputSchema: {} }];
    const readOnly = withActionControlTools(base, [
      "knowledge.search",
      "xero.invoices.read",
    ]);
    expect(readOnly.map((t) => t.name)).toEqual(["system_health"]);

    const entitled = withActionControlTools(base, [
      "knowledge.search",
      ...XERO_ACTION_SERVICE_SCOPES,
    ]);
    expect(entitled.map((t) => t.name).sort()).toEqual(
      ["system_health", ...ACTION_CONTROL_TOOLS].sort(),
    );
  });

  it("keeps confirmation-gated Xero write copy on confirm/execute tools", () => {
    const entitled = withActionControlTools(
      [{ name: "system_health", description: "health", inputSchema: {} }],
      ["knowledge.search", ...XERO_ACTION_SERVICE_SCOPES],
    );
    const confirm = entitled.find((tool) => tool.name === "confirm_action_plan");
    const execute = entitled.find((tool) => tool.name === "execute_action_plan");
    expect(confirm?.description).toMatch(/Xero/i);
    expect(confirm?.description).toMatch(/confirmation/i);
    expect(confirm?.description).toMatch(/does not send Outlook/i);
    expect(execute?.description).toMatch(/confirm_action_plan/);
    expect(execute?.description).toMatch(/does not send Outlook/i);
  });
});
