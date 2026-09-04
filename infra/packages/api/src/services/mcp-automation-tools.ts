/**
 * Company-scoped MCP tools for INFRA automation control.
 * Persistent create/update requires a prior validated plan and confirmation.
 * These tools never execute customer-supplied code or Xero writes.
 */

import {
  AUTOMATION_SCHEDULE_FREQUENCIES,
  automationCreatedViaOf,
  automationRecipientEmailOf,
  automationTemplateKeyOf,
  getAutomationTemplate,
  isArchivedAutomation,
  parseClockTime,
  type AutomationScheduleFrequency,
} from "@infra/shared";
import type { Env } from "../env";
import type { GatewayActor } from "./gateway";
import { getCompanyById } from "./control-plane";
import {
  findAutomationsByName,
  getAutomationDefinition,
  getAutomationRun,
  listAutomationDefinitions,
  listLatestAutomationRuns,
} from "./automation-engine/store";
import { formatScheduleLabel } from "./automation-engine/schedule";
import {
  applyValidatedUpdate,
  archiveAutomation,
  AutomationControlError,
  createAutomationFromPlan,
  managementUrlForCompany,
  planAutomationCreation,
  runAutomationNow,
  setAutomationPaused,
  updateAutomationFromPlan,
  type AutomationControlActor,
} from "./automation-engine/control";
import {
  automationActorLabel,
  automationActorSource,
  canManageAutomationsAsActor,
  canViewAutomationsAsActor,
} from "./automation-engine/permissions";

export const AUTOMATION_CONTROL_TOOLS = [
  "automation_list",
  "automation_get",
  "automation_get_run",
  "automation_plan",
  "automation_create",
  "automation_plan_update",
  "automation_update",
  "automation_pause",
  "automation_resume",
  "automation_run_now",
  "automation_delete",
] as const;

export type AutomationControlTool = (typeof AUTOMATION_CONTROL_TOOLS)[number];

export const AUTOMATION_READ_TOOLS = [
  "automation_list",
  "automation_get",
  "automation_get_run",
] as const;

export function isAutomationControlTool(name: string): name is AutomationControlTool {
  return (AUTOMATION_CONTROL_TOOLS as readonly string[]).includes(name);
}

export function isAutomationWriteTool(name: string): boolean {
  return isAutomationControlTool(name) && !(AUTOMATION_READ_TOOLS as readonly string[]).includes(name);
}

export const AUTOMATION_CONTROL_TOOL_SCHEMAS: Record<
  AutomationControlTool,
  { description: string; inputSchema: Record<string, unknown>; readOnlyHint: boolean }
> = {
  automation_list: {
    readOnlyHint: true,
    description:
      "List this company's INFRA automations. Read-only. Use for 'Show me my active automations', 'list paused automations', or to find an automation before Run now. Returns id, name, description, enabled/paused state, schedule, timezone, next run, last run, and whether manual execution is supported. Tenant comes from the authenticated ChatGPT/Claude connection — do not pass another company.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: {
          type: "boolean",
          description: "If true, include archived automations. Default false.",
        },
        status: {
          type: "string",
          enum: ["active", "paused", "all"],
          description: "Filter by enabled state. Default all (except archived).",
        },
      },
      additionalProperties: false,
    },
  },
  automation_get: {
    readOnlyHint: true,
    description:
      "Get one INFRA automation by id for this company. Read-only. Use after automation_list to inspect schedule, recipient, and status.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", minLength: 1, description: "Automation id (aut_…)." },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  automation_plan: {
    readOnlyHint: false,
    description:
      "Validate a structured automation request and return a plan for the user to review. Does NOT create the automation. Use for 'every morning email me sales' or similar. For exploratory questions such as 'could I get a sales report every morning?', call this and explain the plan — do not call automation_create until the user explicitly confirms.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Suggested automation name." },
        templateKey: {
          type: "string",
          enum: [
            "xero_month_to_date_sales_email",
            "document_activity_daily_email",
            "knowledge_ingestion_daily_email",
          ],
          description: "Approved template shortcut when steps are omitted.",
        },
        frequency: {
          type: "string",
          enum: [...AUTOMATION_SCHEDULE_FREQUENCIES],
          description: "How often to run. Customers should not need cron or RRULE.",
        },
        time: { type: "string", description: "Local time HH:MM, for example 08:00." },
        timezone: {
          type: "string",
          description: "IANA timezone. Caddington uses Europe/London. Do not convert to a fixed UTC hour.",
        },
        recipientEmail: { type: "string", description: "Explicit report recipient." },
        recipients: { type: "array", items: { type: "string" } },
        steps: {
          type: "array",
          description:
            "Allowlisted actions only: XERO_MONTH_TO_DATE_SALES, KNOWLEDGE_DOCUMENT_ACTIVITY, SEND_TRANSACTIONAL_REPORT_EMAIL. Xero financial writes are rejected.",
          items: {
            type: "object",
            properties: { type: { type: "string" } },
            required: ["type"],
            additionalProperties: false,
          },
        },
        enabled: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  automation_create: {
    readOnlyHint: false,
    description:
      "Create a persistent INFRA automation from a previously validated plan. This is a write. Requires planId, confirmationToken, and confirmed=true after the user explicitly agrees. Never call this for hypothetical or 'could I' questions. Creating an automation stores configuration only — no code generation and no Cursor/GitHub/deploy step.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1, description: "Plan id returned by automation_plan (apl_…)." },
        confirmationToken: {
          type: "string",
          minLength: 1,
          description: "confirmationToken from automation_plan. INFRA re-validates the plan server-side.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. The user must have explicitly confirmed the plan.",
        },
        allowDuplicate: {
          type: "boolean",
          description: "Set true only when the user explicitly wants a second copy of an identical automation.",
        },
      },
      required: ["planId", "confirmationToken", "confirmed"],
      additionalProperties: false,
    },
  },
  automation_plan_update: {
    readOnlyHint: false,
    description:
      "Plan a change to an existing automation (name, time, frequency, timezone, recipient). Does NOT apply the change. After the user confirms, call automation_update with the returned planId.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", minLength: 1 },
        name: { type: "string" },
        frequency: { type: "string", enum: [...AUTOMATION_SCHEDULE_FREQUENCIES] },
        time: { type: "string", description: "Local time HH:MM, for example 07:30." },
        timezone: { type: "string" },
        recipientEmail: { type: "string" },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  automation_update: {
    readOnlyHint: false,
    description:
      "Apply a confirmed schedule/name/recipient change to an existing automation. Write operation. Prefer planId + confirmationToken from automation_plan_update. Direct field updates require confirmed=true after the user agreed. Does not require recreating the automation.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string" },
        confirmationToken: { type: "string" },
        automationId: { type: "string" },
        name: { type: "string" },
        frequency: { type: "string", enum: [...AUTOMATION_SCHEDULE_FREQUENCIES] },
        time: { type: "string" },
        timezone: { type: "string" },
        recipientEmail: { type: "string" },
        confirmed: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  automation_pause: {
    readOnlyHint: false,
    description:
      "Pause an existing automation so it stops recurring. Does not delete history. Use when the user says 'pause my document report'. This is a write.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", minLength: 1 },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  automation_resume: {
    readOnlyHint: false,
    description:
      "Resume a paused automation. Recurring schedule continues from the next valid slot. This is a write.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", minLength: 1 },
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  automation_run_now: {
    readOnlyHint: false,
    description:
      "Run a saved INFRA automation immediately (mcp_manual). Does NOT change its schedule, timezone, enabled/paused state, next scheduled run, recipients, or instructions. Paused automations may still be run once. Use for 'Run my Daily month-to-date sales automation now', 'Run it once now but do not change its normal 8:00 a.m. schedule', or 'Run the paused document activity automation once'. Identify by automationId or unique name. This is a write.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: {
          type: "string",
          description: "Automation id (aut_…). Optional if a unique name is supplied.",
        },
        automation_id: {
          type: "string",
          description: "Alias of automationId.",
        },
        name: {
          type: "string",
          description: "Unique automation name, case-insensitive. Optional if an id is supplied.",
        },
        automation_name: {
          type: "string",
          description: "Alias of name.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional. Same key returns the same run and does not start a second execution.",
        },
        idempotency_key: {
          type: "string",
          description: "Alias of idempotencyKey.",
        },
      },
      additionalProperties: false,
    },
  },
  automation_get_run: {
    readOnlyHint: true,
    description:
      "Get the current or final status of an automation run by run ID. Use for 'Show me whether that manual run completed' or after automation_run_now. Read-only. Returns status, trigger source, times, and a concise failure reason when failed.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1, description: "Run id (aur_…)." },
        run_id: { type: "string", description: "Alias of runId." },
      },
      additionalProperties: false,
    },
  },
  automation_delete: {
    readOnlyHint: false,
    description:
      "Archive an automation (soft delete). Run history and audit remain. Requires confirmed=true. This is a write. Use when the user says 'delete the document report'.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", minLength: 1 },
        confirmed: {
          type: "boolean",
          description: "Must be true after the user explicitly asked to delete/archive.",
        },
      },
      required: ["automationId", "confirmed"],
      additionalProperties: false,
    },
  },
};

export function withAutomationControlTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  options?: { identityType?: string },
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  if (options?.identityType === "automation" || options?.identityType === "scheduled") {
    return tools;
  }
  const existing = new Set(tools.map((tool) => tool.name));
  const merged = [...tools];
  for (const name of AUTOMATION_CONTROL_TOOLS) {
    if (existing.has(name)) continue;
    const spec = AUTOMATION_CONTROL_TOOL_SCHEMAS[name];
    merged.push({
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    });
  }
  return merged;
}

function actorContext(actor: GatewayActor): AutomationControlActor {
  return { label: automationActorLabel(actor), source: automationActorSource(actor) };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function presentAutomation(
  item: NonNullable<Awaited<ReturnType<typeof getAutomationDefinition>>>,
  latestRun?: { status: string; triggerType: string; createdAt: string } | null,
) {
  const templateKey = automationTemplateKeyOf(item.configuration);
  const template = templateKey ? getAutomationTemplate(templateKey) : null;
  const archived = isArchivedAutomation(item);
  return {
    automationId: item.id,
    name: item.name,
    description: item.description,
    status: archived ? "archived" : item.status,
    enabled: item.status === "active",
    paused: item.status === "paused",
    schedule: item.schedule
      ? formatScheduleLabel(item.schedule, item.timezone)
      : null,
    timezone: item.timezone,
    nextRun: item.nextRunAt,
    lastRun: item.lastRunAt,
    lastRunStatus: latestRun?.status ?? null,
    lastRunTrigger: latestRun?.triggerType ?? null,
    lastRunAt: latestRun?.createdAt ?? item.lastRunAt,
    recipient: automationRecipientEmailOf(item.configuration),
    templateKey,
    templateLabel: template?.label ?? null,
    createdVia: automationCreatedViaOf(item.configuration),
    manualRunSupported: !archived && item.status !== "disabled",
  };
}

export async function resolveAutomationForManualRun(
  env: Env,
  companyId: string,
  args: Record<string, unknown>,
) {
  const id = asString(args.automationId) || asString(args.automation_id);
  const name = asString(args.name) || asString(args.automation_name);
  if (id) {
    const item = await getAutomationDefinition(env.DB, companyId, id);
    if (!item || isArchivedAutomation(item)) {
      return { error: { status: 404 as const, body: { error: "Automation not found", code: "NOT_FOUND" } } };
    }
    return { automation: item };
  }
  if (!name) {
    return {
      error: {
        status: 400 as const,
        body: {
          error: "Provide automationId or a unique automation name.",
          code: "IDENTIFICATION_REQUIRED",
        },
      },
    };
  }
  const matches = await findAutomationsByName(env.DB, companyId, name);
  const live = matches.filter((item) => !isArchivedAutomation(item));
  if (live.length === 0) {
    return {
      error: {
        status: 404 as const,
        body: {
          error: `No automation named '${name}' was found for this company.`,
          code: "NOT_FOUND",
        },
      },
    };
  }
  if (live.length > 1) {
    return {
      error: {
        status: 409 as const,
        body: {
          error: `More than one automation is named '${name}'. Specify automationId.`,
          code: "AMBIGUOUS_NAME",
          candidates: live.map((item) => ({
            automationId: item.id,
            name: item.name,
            status: item.status,
          })),
        },
      },
    };
  }
  return { automation: live[0] };
}

function controlErrorBody(err: unknown): {
  status: 400 | 403 | 404 | 409;
  body: Record<string, unknown>;
} {
  if (err instanceof AutomationControlError) {
    return {
      status: err.status,
      body: {
        error: err.message,
        code: err.code,
        ...(err.details ?? {}),
      },
    };
  }
  return {
    status: 400,
    body: { error: err instanceof Error ? err.message : "Automation control failed" },
  };
}

function stepsFromArgs(args: Record<string, unknown>) {
  if (!Array.isArray(args.steps)) return undefined;
  return args.steps
    .filter((step) => step && typeof step === "object")
    .map((step) => ({ type: String((step as { type?: unknown }).type ?? "") }))
    .filter((step) => step.type);
}

export async function executeAutomationControlTool(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor: GatewayActor;
  },
): Promise<{ status: 200 | 400 | 403 | 404 | 409; body: Record<string, unknown> }> {
  const { companyId, toolName, actor } = input;
  const args = input.arguments ?? {};

  if (!isAutomationControlTool(toolName)) {
    return { status: 400, body: { error: "Unknown automation tool" } };
  }

  if (isAutomationWriteTool(toolName) && !canManageAutomationsAsActor(actor, companyId)) {
    return {
      status: 403,
      body: {
        error: "You do not have permission to manage automations for this company.",
        code: "AUTOMATION_FORBIDDEN",
      },
    };
  }
  if (!isAutomationWriteTool(toolName) && !canViewAutomationsAsActor(actor, companyId)) {
    return {
      status: 403,
      body: {
        error: "You do not have permission to view automations for this company.",
        code: "AUTOMATION_FORBIDDEN",
      },
    };
  }

  const company = await getCompanyById(env.DB, companyId);
  const manageUrl = company ? managementUrlForCompany(env, company.slug) : null;
  const ctx = actorContext(actor);

  try {
    if (toolName === "automation_list") {
      const includeArchived = args.includeArchived === true;
      const statusFilter = asString(args.status) || "all";
      const items = await listAutomationDefinitions(env.DB, companyId);
      const latest = await listLatestAutomationRuns(env.DB, companyId);
      const automations = items
        .filter((item) => includeArchived || !isArchivedAutomation(item))
        .filter((item) => {
          if (statusFilter === "active") return item.status === "active";
          if (statusFilter === "paused") return item.status === "paused";
          return true;
        })
        .map((item) => presentAutomation(item, latest.get(item.id) ?? null));
      return { status: 200, body: { automations, managementUrl: manageUrl } };
    }

    if (toolName === "automation_get") {
      const automationId = asString(args.automationId);
      const item = await getAutomationDefinition(env.DB, companyId, automationId);
      if (!item) return { status: 404, body: { error: "Automation not found", code: "NOT_FOUND" } };
      return {
        status: 200,
        body: { automation: presentAutomation(item), managementUrl: manageUrl },
      };
    }

    if (toolName === "automation_plan") {
      const frequency = asString(args.frequency) as AutomationScheduleFrequency;
      const time = asString(args.time) || "08:00";
      const timezone = asString(args.timezone) || "Europe/London";
      const result = await planAutomationCreation(env, {
        companyId,
        actor: ctx,
        spec: {
          companyId,
          name: asString(args.name) || undefined,
          templateKey: asString(args.templateKey) || undefined,
          trigger: {
            type: "schedule",
            frequency: frequency || "daily",
            time,
            timezone,
          },
          timezone,
          recipientEmail: asString(args.recipientEmail) || undefined,
          recipients: Array.isArray(args.recipients)
            ? args.recipients.map((item) => String(item))
            : undefined,
          steps: stepsFromArgs(args),
          enabled: args.enabled !== false,
        },
      });
      return {
        status: 200,
        body: {
          ...result,
          message:
            "Plan only — no automation was created. Tell the user what will happen and call automation_create after they explicitly confirm.",
        },
      };
    }

    if (toolName === "automation_create") {
      const created = await createAutomationFromPlan(env, {
        companyId,
        planId: asString(args.planId),
        confirmationToken: asString(args.confirmationToken),
        confirmed: args.confirmed === true,
        allowDuplicate: args.allowDuplicate === true,
        actor: ctx,
      });
      const presented = presentAutomation(created.automation);
      return {
        status: 200,
        body: {
          created: true,
          automationId: presented.automationId,
          name: presented.name,
          status: presented.status,
          schedule: presented.schedule,
          timezone: presented.timezone,
          nextRun: presented.nextRun,
          recipient: presented.recipient,
          managementUrl: created.managementUrl,
          customerMessage: `Done. '${presented.name}' will run ${presented.schedule} ${presented.timezone} and email ${presented.recipient}. You can manage it in INFRA → Automations.`,
        },
      };
    }

    if (toolName === "automation_plan_update") {
      const automationId = asString(args.automationId);
      const existing = await getAutomationDefinition(env.DB, companyId, automationId);
      if (!existing || isArchivedAutomation(existing)) {
        return { status: 404, body: { error: "Automation not found", code: "NOT_FOUND" } };
      }
      const clock =
        (asString(args.time) && parseClockTime(asString(args.time))) || {
          hour: existing.schedule?.hour ?? 8,
          minute: existing.schedule?.minute ?? 0,
        };
      const result = await planAutomationCreation(env, {
        companyId,
        actor: ctx,
        kind: "update",
        automationId,
        spec: {
          companyId,
          name: asString(args.name) || existing.name,
          templateKey: automationTemplateKeyOf(existing.configuration) ?? undefined,
          trigger: {
            type: "schedule",
            frequency:
              (asString(args.frequency) as AutomationScheduleFrequency) ||
              existing.schedule?.frequency ||
              "daily",
            time: `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`,
            timezone: asString(args.timezone) || existing.timezone,
          },
          timezone: asString(args.timezone) || existing.timezone,
          recipientEmail:
            asString(args.recipientEmail) ||
            automationRecipientEmailOf(existing.configuration) ||
            undefined,
          enabled: existing.status === "active",
        },
      });
      return {
        status: 200,
        body: {
          ...result,
          automationId,
          message:
            "Update plan only — the automation was not changed. Confirm with the user, then call automation_update.",
        },
      };
    }

    if (toolName === "automation_update") {
      if (asString(args.planId) && asString(args.confirmationToken)) {
        const updated = await updateAutomationFromPlan(env, {
          companyId,
          planId: asString(args.planId),
          confirmationToken: asString(args.confirmationToken),
          confirmed: args.confirmed === true,
          actor: ctx,
        });
        return {
          status: 200,
          body: {
            automation: updated ? presentAutomation(updated) : null,
            managementUrl: manageUrl,
          },
        };
      }
      if (args.confirmed !== true) {
        return {
          status: 400,
          body: {
            error: "Schedule changes require confirmed=true after the user agrees, or a planId from automation_plan_update.",
            code: "CONFIRMATION_REQUIRED",
          },
        };
      }
      const automationId = asString(args.automationId);
      if (!automationId) {
        return { status: 400, body: { error: "automationId or planId is required" } };
      }
      const existing = await getAutomationDefinition(env.DB, companyId, automationId);
      if (!existing) return { status: 404, body: { error: "Automation not found", code: "NOT_FOUND" } };
      const clock =
        (asString(args.time) && parseClockTime(asString(args.time))) || {
          hour: existing.schedule?.hour ?? 8,
          minute: existing.schedule?.minute ?? 0,
        };
      const updated = await applyValidatedUpdate(env, {
        companyId,
        automationId,
        actor: ctx,
        spec: {
          name: asString(args.name) || undefined,
          trigger: {
            type: "schedule",
            frequency:
              (asString(args.frequency) as AutomationScheduleFrequency) ||
              existing.schedule?.frequency ||
              "daily",
            time: `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`,
            timezone: asString(args.timezone) || existing.timezone,
          },
          timezone: asString(args.timezone) || existing.timezone,
          recipientEmail: asString(args.recipientEmail) || undefined,
        },
      });
      return {
        status: 200,
        body: {
          automation: updated ? presentAutomation(updated) : null,
          managementUrl: manageUrl,
        },
      };
    }

    if (toolName === "automation_pause" || toolName === "automation_resume") {
      const updated = await setAutomationPaused(env, {
        companyId,
        automationId: asString(args.automationId),
        paused: toolName === "automation_pause",
        actor: ctx,
      });
      return {
        status: 200,
        body: { automation: updated ? presentAutomation(updated) : null },
      };
    }

    if (toolName === "automation_get_run") {
      const runId = asString(args.runId) || asString(args.run_id);
      const run = await getAutomationRun(env.DB, companyId, runId);
      if (!run) {
        return { status: 404, body: { error: "Run not found", code: "NOT_FOUND" } };
      }
      return {
        status: 200,
        body: {
          runId: run.id,
          automationId: run.automationId,
          status: run.status,
          trigger: run.triggerType,
          initiatedBy: run.initiatedBy,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          resultSummary: run.resultSummary,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        },
      };
    }

    if (toolName === "automation_run_now") {
      const resolved = await resolveAutomationForManualRun(env, companyId, args);
      if ("error" in resolved) return resolved.error;
      const result = await runAutomationNow(env, {
        companyId,
        automationId: resolved.automation.id,
        actor: ctx,
        triggerType: "mcp_manual",
        idempotencyKey: asString(args.idempotencyKey) || asString(args.idempotency_key) || null,
      });
      const run = await getAutomationRun(env.DB, companyId, result.runId);
      return {
        status: 200,
        body: {
          success: true,
          automationId: result.automationId,
          automationName: result.automationName,
          runId: result.runId,
          status: result.status,
          trigger: result.trigger,
          startedAt: run?.startedAt ?? run?.createdAt ?? null,
          scheduledFor: null,
          scheduleChanged: false,
          scheduleUnchanged: true,
          preserved: result.preserved,
          reusedExisting: result.reusedExisting,
          customerMessage: `Started '${result.automationName}' now (${result.status}). Its normal schedule and enabled/paused state were not changed.`,
        },
      };
    }

    if (toolName === "automation_delete") {
      if (args.confirmed !== true) {
        return {
          status: 400,
          body: {
            error: "confirmed=true is required to archive an automation.",
            code: "CONFIRMATION_REQUIRED",
          },
        };
      }
      const updated = await archiveAutomation(env, {
        companyId,
        automationId: asString(args.automationId),
        actor: ctx,
      });
      return {
        status: 200,
        body: {
          archived: true,
          automation: updated ? presentAutomation(updated) : null,
          historyPreserved: true,
        },
      };
    }

    return { status: 400, body: { error: "Unknown automation tool" } };
  } catch (err) {
    return controlErrorBody(err);
  }
}
