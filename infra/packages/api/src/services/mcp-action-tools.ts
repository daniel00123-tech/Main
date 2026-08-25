/**
 * INFRA-native MCP action control tools.
 * Planning/confirmation tools are advertised to AI clients; direct Xero writes are not.
 */

export const ACTION_CONTROL_TOOLS = [
  "get_action_plan",
  "confirm_action_plan",
  "cancel_action_plan",
  "list_pending_actions",
  "dry_run_action_plan",
  "plan_xero_credit_invoices",
  "plan_xero_draft_invoice",
  "plan_xero_remittance_allocation",
] as const;

export type ActionControlTool = (typeof ACTION_CONTROL_TOOLS)[number];

export function isActionControlTool(name: string): name is ActionControlTool {
  return (ACTION_CONTROL_TOOLS as readonly string[]).includes(name);
}

/** Required service-identity scope per Action Engine MCP tool. */
export const ACTION_CONTROL_TOOL_REQUIRED_SCOPES: Record<ActionControlTool, string> = {
  get_action_plan: "xero.action.read",
  list_pending_actions: "xero.action.list",
  dry_run_action_plan: "xero.action.read",
  confirm_action_plan: "xero.action.confirm",
  cancel_action_plan: "xero.action.cancel",
  plan_xero_draft_invoice: "xero.action.plan",
  plan_xero_credit_invoices: "xero.action.plan",
  plan_xero_remittance_allocation: "xero.action.plan",
};

export function actionControlToolAllowed(
  toolName: string,
  scopes: readonly string[],
): boolean {
  if (!isActionControlTool(toolName)) return false;
  if (scopes.includes("*")) return true;
  const required = ACTION_CONTROL_TOOL_REQUIRED_SCOPES[toolName];
  return scopes.includes(required);
}

export const ACTION_CONTROL_TOOL_SCHEMAS: Record<
  ActionControlTool,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  get_action_plan: {
    description:
      "Fetch a server-side action plan by plan_id. Use after planning a financial action — do not reconstruct plans from conversation text.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1, description: "Action plan id (act_…)." },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
  confirm_action_plan: {
    description:
      "Confirm a previously created action plan for execution. Requires plan_id and confirmationToken returned at plan creation. INFRA re-validates permissions and live source state before executing.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1 },
        confirmationToken: { type: "string", minLength: 1 },
      },
      required: ["planId", "confirmationToken"],
      additionalProperties: false,
    },
  },
  cancel_action_plan: {
    description: "Cancel a pending action plan.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
  list_pending_actions: {
    description: "List pending or awaiting-confirmation action plans for this company.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  dry_run_action_plan: {
    description:
      "Dry-run an action plan against live Xero/INFRA state without mutating accounting records. Returns READY TO EXECUTE readiness including OAuth scope and execution gate status.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", minLength: 1 },
      },
      required: ["planId"],
      additionalProperties: false,
    },
  },
  plan_xero_credit_invoices: {
    description:
      "Plan crediting one or more Xero sales invoices (ACCREC). Retrieves live invoice state from Xero and returns an action plan — does NOT execute. Use for 'Credit INV-123' or batch credit requests.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceNumbers: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 20,
        },
        idempotencyKey: { type: "string", description: "Optional client idempotency key." },
      },
      required: ["invoiceNumbers"],
      additionalProperties: false,
    },
  },
  plan_xero_draft_invoice: {
    description:
      "Plan creating a draft sales invoice (ACCREC, DRAFT status) in Xero. Returns an action plan for human confirmation — does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", minLength: 1 },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unitAmount: { type: "number" },
              accountCode: { type: "string" },
            },
            required: ["description", "quantity", "unitAmount"],
          },
          minItems: 1,
        },
        reference: { type: "string" },
        date: { type: "string", description: "ISO date YYYY-MM-DD." },
        idempotencyKey: { type: "string" },
      },
      required: ["contactId", "lineItems"],
      additionalProperties: false,
    },
  },
  plan_xero_remittance_allocation: {
    description:
      "Plan payment allocation against Xero sales invoices from remittance clues. Validates live invoice balances — ambiguous matches require user decision.",
    inputSchema: {
      type: "object",
      properties: {
        paymentAmount: { type: "number" },
        currencyCode: { type: "string", minLength: 3, maxLength: 3 },
        invoiceHints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              invoiceNumber: { type: "string" },
              amount: { type: "number" },
            },
          },
        },
        idempotencyKey: { type: "string" },
      },
      required: ["paymentAmount", "currencyCode", "invoiceHints"],
      additionalProperties: false,
    },
  },
};

export function withActionControlTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  scopes?: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const existing = new Set(tools.map((tool) => tool.name));
  const merged = [...tools];
  for (const name of ACTION_CONTROL_TOOLS) {
    if (existing.has(name)) continue;
    if (scopes && !actionControlToolAllowed(name, scopes)) continue;
    const spec = ACTION_CONTROL_TOOL_SCHEMAS[name];
    merged.push({ name, description: spec.description, inputSchema: spec.inputSchema });
  }
  return merged;
}
