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
  "execute_action_plan",
  "plan_xero_credit_invoices",
  "plan_xero_draft_invoice",
  "plan_xero_remittance_allocation",
  "plan_xero_approve_invoice",
  "plan_xero_send_invoice",
  "plan_xero_draft_bill",
  "plan_xero_approve_bill",
  "plan_xero_draft_credit_note",
  "plan_xero_create_contact",
  "plan_xero_create_approve_send",
  "plan_xero_update_draft_invoice",
  "plan_xero_approve_credit_note",
  "plan_xero_credit_note_allocation",
  "plan_xero_void_document",
  "plan_xero_delete_test_draft",
  "list_xero_test_artefacts",
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
  execute_action_plan: "xero.action.execute",
  confirm_action_plan: "xero.action.confirm",
  cancel_action_plan: "xero.action.cancel",
  plan_xero_draft_invoice: "xero.action.plan",
  plan_xero_credit_invoices: "xero.action.plan",
  plan_xero_remittance_allocation: "xero.action.plan",
  plan_xero_approve_invoice: "xero.action.plan",
  plan_xero_send_invoice: "xero.action.plan",
  plan_xero_draft_bill: "xero.action.plan",
  plan_xero_approve_bill: "xero.action.plan",
  plan_xero_draft_credit_note: "xero.action.plan",
  plan_xero_create_contact: "xero.action.plan",
  plan_xero_create_approve_send: "xero.action.plan",
  plan_xero_update_draft_invoice: "xero.action.plan",
  plan_xero_approve_credit_note: "xero.action.plan",
  plan_xero_credit_note_allocation: "xero.action.plan",
  plan_xero_void_document: "xero.action.plan",
  plan_xero_delete_test_draft: "xero.action.plan",
  list_xero_test_artefacts: "xero.action.read",
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
      "Fetch a server-side Xero financial action plan by plan_id. Xero Action Engine only — not email. Use after planning a financial action — do not reconstruct plans from conversation text.",
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
      "Confirm a previously created Xero financial action plan. Requires plan_id and confirmationToken. Confirmation is mandatory before any write. This does not send Outlook mail and must not be used to bypass confirmation.",
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
  execute_action_plan: {
    description:
      "Execute a confirmed Xero financial action plan via the INFRA Action Engine. confirm_action_plan is required first. This does not send Outlook mail. Draft invoice plans do not need a separate portal approval.",
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
      "Plan creating a draft sales invoice (ACCREC, DRAFT status) in Xero. Returns an action plan for human confirmation — does NOT execute. Provide contactName (e.g. \"Elvex\") or contactId.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          minLength: 1,
          description: "Xero ContactID GUID. Optional if contactName is provided.",
        },
        contactName: {
          type: "string",
          minLength: 1,
          description:
            "Customer name or short name to match in Xero (e.g. \"Elvex\" → Elvex Property Services). Optional if contactId is provided.",
        },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unitAmount: { type: "number" },
              accountCode: { type: "string", description: "Xero account code (e.g. 200 for Sales)." },
              accountName: {
                type: "string",
                description: "Natural-language sales account label when accountCode is omitted (defaults to Sales).",
              },
              taxType: {
                type: "string",
                description: "Explicit Xero TaxType. Prefer taxTreatment when unsure.",
              },
            },
            required: ["description", "quantity", "unitAmount"],
          },
          minItems: 1,
        },
        reference: { type: "string" },
        invoiceDate: { type: "string", description: "ISO date YYYY-MM-DD for the invoice date." },
        dueDate: { type: "string", description: "ISO date YYYY-MM-DD for payment due date." },
        date: {
          type: "string",
          description: "Deprecated alias for invoiceDate (ISO date YYYY-MM-DD).",
        },
        taxTreatment: {
          type: "string",
          description: "Natural-language VAT treatment, e.g. \"No VAT\", \"standard rate\".",
        },
        taxType: {
          type: "string",
          description: "Explicit Xero TaxType override when taxTreatment is insufficient.",
        },
        idempotencyKey: { type: "string" },
      },
      required: ["lineItems"],
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
  plan_xero_approve_invoice: {
    description: "Plan approving/authorising a DRAFT ACCREC sales invoice in Xero. Does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        invoiceNumber: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  plan_xero_send_invoice: {
    description: "Plan sending an authorised sales invoice via Xero email. Does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        invoiceNumber: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  plan_xero_draft_bill: {
    description: "Plan creating a DRAFT ACCPAY supplier bill in Xero. Does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        contactName: { type: "string" },
        lineItems: { type: "array", items: { type: "object" }, minItems: 1 },
        reference: { type: "string" },
        billDate: { type: "string" },
        dueDate: { type: "string" },
        taxTreatment: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["lineItems"],
      additionalProperties: false,
    },
  },
  plan_xero_approve_bill: {
    description: "Plan approving a DRAFT ACCPAY supplier bill. Does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        invoiceNumber: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  plan_xero_draft_credit_note: {
    description: "Plan creating a DRAFT sales credit note in Xero. Does NOT execute.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        contactName: { type: "string" },
        lineItems: { type: "array", items: { type: "object" }, minItems: 1 },
        reference: { type: "string" },
        taxTreatment: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["lineItems"],
      additionalProperties: false,
    },
  },
  plan_xero_create_contact: {
    description: "Plan creating a new Xero contact. Does NOT execute. Duplicate names are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        email: { type: "string" },
        phone: { type: "string" },
        isCustomer: { type: "boolean" },
        isSupplier: { type: "boolean" },
        idempotencyKey: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  plan_xero_create_approve_send: {
    description: "Plan a combined create → approve → send sales invoice workflow. Does NOT execute until confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        contactName: { type: "string" },
        lineItems: { type: "array", items: { type: "object" }, minItems: 1 },
        reference: { type: "string" },
        invoiceDate: { type: "string" },
        dueDate: { type: "string" },
        taxTreatment: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["lineItems"],
      additionalProperties: false,
    },
  },
  list_xero_test_artefacts: {
    description: "Search manifest of INFRA test Xero artefacts by reference prefix (report only — no deletion).",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Reference prefix, e.g. INFRA-BETA-WRITE-" },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  plan_xero_update_draft_invoice: {
    description: "Plan updating a DRAFT sales invoice in Xero.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        reference: { type: "string" },
        invoiceDate: { type: "string" },
        dueDate: { type: "string" },
        lineItems: { type: "array", items: { type: "object" } },
        idempotencyKey: { type: "string" },
      },
      required: ["invoiceId"],
      additionalProperties: false,
    },
  },
  plan_xero_approve_credit_note: {
    description: "Plan approving a DRAFT sales credit note in Xero.",
    inputSchema: {
      type: "object",
      properties: {
        creditNoteId: { type: "string" },
        creditNoteNumber: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  plan_xero_credit_note_allocation: {
    description: "Plan allocating a credit note to a sales invoice in Xero.",
    inputSchema: {
      type: "object",
      properties: {
        creditNoteId: { type: "string", minLength: 1 },
        invoiceId: { type: "string", minLength: 1 },
        amount: { type: "number", minimum: 0.01 },
        idempotencyKey: { type: "string" },
      },
      required: ["creditNoteId", "invoiceId", "amount"],
      additionalProperties: false,
    },
  },
  plan_xero_void_document: {
    description: "Plan voiding an invoice, bill, or credit note in Xero (destructive).",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        creditNoteId: { type: "string" },
        documentKind: { type: "string", enum: ["invoice", "bill", "credit_note"] },
        reason: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  plan_xero_delete_test_draft: {
    description: "Plan deletion of a DRAFT INFRA test artefact (prefix-enforced). Operator confirmation required.",
    inputSchema: {
      type: "object",
      properties: {
        xeroId: { type: "string", minLength: 1 },
        reference: { type: "string", minLength: 1 },
        documentType: { type: "string", enum: ["ACCREC", "ACCPAY", "CREDIT_NOTE"] },
        idempotencyKey: { type: "string" },
      },
      required: ["xeroId", "reference"],
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
