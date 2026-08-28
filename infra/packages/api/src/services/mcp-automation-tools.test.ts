import { describe, expect, it } from "vitest";
import {
  AUTOMATION_CONTROL_TOOLS,
  AUTOMATION_CONTROL_TOOL_SCHEMAS,
  isAutomationControlTool,
  isAutomationWriteTool,
  withAutomationControlTools,
} from "./mcp-automation-tools";
import {
  canManageAutomations,
  canManageAutomationsAsActor,
  canViewAutomationsAsActor,
} from "./automation-engine/permissions";
import type { SessionUser } from "../auth/session";
import type { GatewayActor } from "./gateway";

describe("automation MCP catalogue", () => {
  it("advertises plan/create as writes, not reads", () => {
    expect(isAutomationWriteTool("automation_list")).toBe(false);
    expect(isAutomationWriteTool("automation_get")).toBe(false);
    expect(isAutomationWriteTool("automation_plan")).toBe(true);
    expect(isAutomationWriteTool("automation_create")).toBe(true);
    expect(isAutomationWriteTool("automation_update")).toBe(true);
    expect(isAutomationWriteTool("automation_delete")).toBe(true);
    expect(AUTOMATION_CONTROL_TOOL_SCHEMAS.automation_list.readOnlyHint).toBe(true);
    expect(AUTOMATION_CONTROL_TOOL_SCHEMAS.automation_create.readOnlyHint).toBe(false);
    expect(AUTOMATION_CONTROL_TOOL_SCHEMAS.automation_create.description).toMatch(
      /write|persistent|confirm/i,
    );
    expect(AUTOMATION_CONTROL_TOOL_SCHEMAS.automation_plan.description).toMatch(
      /Does NOT create/i,
    );
    expect(AUTOMATION_CONTROL_TOOL_SCHEMAS.automation_create.description).toMatch(
      /could I/i,
    );
  });

  it("adds tools for company ChatGPT identities and hides them from runner identities", () => {
    const base = [{ name: "system_health", description: "health", inputSchema: {} }];
    const chatgpt = withAutomationControlTools(base, { identityType: "chatgpt" });
    expect(chatgpt.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...AUTOMATION_CONTROL_TOOLS]),
    );
    const runner = withAutomationControlTools(base, { identityType: "automation" });
    expect(runner.map((tool) => tool.name)).toEqual(["system_health"]);
    expect(isAutomationControlTool("automation_run_now")).toBe(true);
    expect(isAutomationControlTool("execute_action_plan")).toBe(false);
  });
});

describe("automation MCP RBAC", () => {
  const admin: SessionUser = {
    userId: "usr_admin",
    email: "admin@test.com",
    displayName: "Admin",
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_a", role: "company_admin" }],
  };
  const staff: SessionUser = {
    userId: "usr_staff",
    email: "staff@test.com",
    displayName: "Staff",
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_a", role: "office_staff" }],
  };

  it("keeps portal and MCP user permissions aligned", () => {
    const adminActor: GatewayActor = { type: "user", user: admin };
    const staffActor: GatewayActor = { type: "user", user: staff };
    expect(canManageAutomations(admin, "co_a")).toBe(true);
    expect(canManageAutomationsAsActor(adminActor, "co_a")).toBe(true);
    expect(canManageAutomations(staff, "co_a")).toBe(false);
    expect(canManageAutomationsAsActor(staffActor, "co_a")).toBe(false);
    expect(canViewAutomationsAsActor(staffActor, "co_a")).toBe(false);
  });

  it("allows the company ChatGPT identity and denies other tenants", () => {
    const chatgpt: GatewayActor = {
      type: "service",
      identity: {
        id: "svc_1",
        companyId: "co_a",
        name: "Company ChatGPT",
        description: null,
        identityType: "chatgpt",
        status: "active",
        tokenPrefix: "infra",
        hasToken: true,
        scopes: ["automation.manage"],
        mcpEnvironmentId: null,
        lastUsedAt: null,
        requestCount: 0,
        createdAt: "t",
        updatedAt: "t",
      },
    };
    const ht: GatewayActor = {
      ...chatgpt,
      identity: { ...chatgpt.identity, companyId: "co_ht", id: "svc_ht" },
    };
    expect(canManageAutomationsAsActor(chatgpt, "co_a")).toBe(true);
    expect(canManageAutomationsAsActor(ht, "co_a")).toBe(false);
    expect(canViewAutomationsAsActor(ht, "co_a")).toBe(false);
  });
});
