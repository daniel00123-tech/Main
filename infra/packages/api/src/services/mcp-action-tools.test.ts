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
});
