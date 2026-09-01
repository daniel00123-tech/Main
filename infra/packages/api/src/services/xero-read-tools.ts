/**
 * INFRA-native Xero READ MCP tools advertised on the human ChatGPT facade.
 * Execution stays on the shared gateway path (INFRA-native token or company MCP).
 */

import {
  XERO_READ_MCP_TOOLS,
  XERO_TOOL_CONTRACTS,
  type XeroToolContract,
} from "@infra/shared";

export const XERO_READ_TOOL_NAMES = XERO_READ_MCP_TOOLS;

export function isXeroReadAdvertisedTool(name: string): boolean {
  return (XERO_READ_TOOL_NAMES as readonly string[]).includes(name);
}

export function xeroReadToolsAllowed(scopes?: readonly string[]): boolean {
  if (!scopes) return true;
  if (scopes.includes("*")) return true;
  return scopes.some((scope) => scope.startsWith("xero.") && !scope.includes("action."));
}

const DATE_PROPS = {
  fromDate: {
    type: "string",
    description: "Inclusive start date YYYY-MM-DD (Europe/London). Required for period totals.",
  },
  toDate: {
    type: "string",
    description: "Inclusive end date YYYY-MM-DD (Europe/London).",
  },
  period: {
    type: "string",
    description:
      "Optional natural period such as today, this month, last month, or 2026-09-01. Used only when fromDate/toDate are omitted.",
  },
} as const;

const SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  xero_sales_summary: {
    description:
      "Retrieve live Xero sales/invoice totals for a date period. Use this for current sales, sales today, this month, last month, or a date range. Do not use company knowledge search or database_summary for live Xero financial totals. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...DATE_PROPS,
      },
    },
  },
  xero_search_invoices: {
    description:
      "List or search live Xero sales invoices by date, status, outstanding/unpaid, or invoice number. Use for invoices raised today or in a date range. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional invoice number or customer text" },
        invoiceNumber: { type: "string" },
        status: { type: "string" },
        overdueOnly: { type: "boolean" },
        unpaidOnly: { type: "boolean" },
        contactId: { type: "string" },
        limit: { type: "number", default: 25 },
        ...DATE_PROPS,
      },
    },
  },
  xero_get_invoice: {
    description: "Fetch one live Xero invoice by invoice number (INV-XXXX) or invoice id. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        invoiceNumber: { type: "string" },
      },
    },
  },
  xero_list_overdue_invoices: {
    description: "List overdue Xero sales invoices. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        effectiveDate: { type: "string", description: "As-at date YYYY-MM-DD" },
        limit: { type: "number", default: 25 },
      },
    },
  },
  xero_top_customers: {
    description:
      "Top customers by invoiced ACCREC value for a date period. Read-only. Do not use knowledge search.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 5 },
        ...DATE_PROPS,
      },
    },
  },
  xero_list_contacts: {
    description: "Search this company's Xero contacts (customers and suppliers). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        contactType: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  xero_get_contact: {
    description: "Fetch one Xero contact by id. Read-only.",
    inputSchema: {
      type: "object",
      properties: { contactId: { type: "string" } },
    },
  },
  xero_get_organisation: {
    description: "Read the connected Xero organisation profile. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
};

function schemaForContract(contract: XeroToolContract): {
  description: string;
  inputSchema: Record<string, unknown>;
} {
  if (SCHEMAS[contract.mcpToolName]) return SCHEMAS[contract.mcpToolName];
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [key, type] of Object.entries(contract.input)) {
    properties[key.replace(/\?$/, "")] = {
      type: type.replace(/\?$/, "") === "number" ? "number" : type.replace(/\?$/, "") === "boolean" ? "boolean" : "string",
    };
  }
  return {
    description: `${contract.mcpToolName.replace(/_/g, " ")}. Live Xero read. Do not use company knowledge for this data.`,
    inputSchema: { type: "object", properties },
  };
}

export function withXeroReadTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  scopes?: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  if (!xeroReadToolsAllowed(scopes)) return tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const extras: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const contract of XERO_TOOL_CONTRACTS.filter(
    (item) => item.implemented && item.riskClass === "low_risk",
  )) {
    const schema = schemaForContract(contract);
    const existing = byName.get(contract.mcpToolName);
    if (existing) {
      const properties =
        existing.inputSchema &&
        typeof existing.inputSchema === "object" &&
        existing.inputSchema.properties &&
        typeof existing.inputSchema.properties === "object"
          ? (existing.inputSchema.properties as Record<string, unknown>)
          : {};
      const emptySchema = Object.keys(properties).length === 0;
      byName.set(contract.mcpToolName, {
        ...existing,
        description: schema.description,
        inputSchema: emptySchema ? schema.inputSchema : existing.inputSchema,
      });
    } else {
      extras.push({
        name: contract.mcpToolName,
        description: schema.description,
        inputSchema: schema.inputSchema,
      });
    }
  }
  return [...byName.values(), ...extras];
}
