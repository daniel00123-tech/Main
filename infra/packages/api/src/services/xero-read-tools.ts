/**
 * INFRA Xero READ tools advertised on the ChatGPT MCP facade.
 * Writes are never advertised here — financial writes stay on the Action Engine.
 */

import {
  XERO_READ_MCP_TOOLS,
  XERO_TOOL_CONTRACTS,
  elvexAllowsAction,
  isElvexCompany,
  type CompanyRole,
  type XeroToolContract,
} from "@infra/shared";
import { xeroActionForTool, isXeroToolName, isXeroWriteToolName } from "./xero-tools";

export const ADVERTISED_XERO_READ_TOOLS = [
  "xero_sales_summary",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_overdue_invoices",
  "xero_top_customers",
] as const;

export type AdvertisedXeroReadTool = (typeof ADVERTISED_XERO_READ_TOOLS)[number];

export const XERO_READ_TOOL_NAMES = XERO_READ_MCP_TOOLS;

const XERO_READ_SCOPE_HINTS = [
  "xero.sales.summary",
  "xero.sales.read",
  "xero.top_customers",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.reports.read",
  "xero.finance.read",
] as const;

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

export function isAdvertisedXeroReadTool(name: string): name is AdvertisedXeroReadTool {
  return (ADVERTISED_XERO_READ_TOOLS as readonly string[]).includes(name);
}

export function isXeroReadAdvertisedTool(name: string): boolean {
  return (XERO_READ_TOOL_NAMES as readonly string[]).includes(name);
}

export function isElMcpNativeXeroTool(name: string): boolean {
  return (
    name === "search_xero_invoices" ||
    name === "analyse_xero_sales" ||
    name === "search_xero_bills" ||
    name === "get_xero_financial_summary" ||
    name === "create_xero_draft_invoice"
  );
}

export function serviceMaySeeXeroReadTools(scopes?: readonly string[]): boolean {
  if (!scopes) return false;
  if (scopes.includes("*")) return true;
  return XERO_READ_SCOPE_HINTS.some((scope) => scopes.includes(scope));
}

export function xeroReadToolsAllowed(scopes?: readonly string[]): boolean {
  if (!scopes) return true;
  if (scopes.includes("*")) return true;
  return scopes.some((scope) => scope.startsWith("xero.") && !scope.includes("action."));
}

export function elvexRoleMaySeeXeroReadTools(role: CompanyRole | null): boolean {
  return elvexAllowsAction(role, "xero.sales.summary", { toolName: "xero_sales_summary" }).allowed;
}

function contractDescription(toolName: string): string {
  const contract = XERO_TOOL_CONTRACTS.find((tool) => tool.mcpToolName === toolName);
  return contract?.name ?? toolName;
}

type XeroReadOptions = {
  scopes?: readonly string[];
  companyId?: string;
  userRole?: CompanyRole | null;
  actorType?: "user" | "service";
};

function normalizeOptions(
  optionsOrScopes?: XeroReadOptions | readonly string[],
): XeroReadOptions {
  if (Array.isArray(optionsOrScopes)) {
    return { scopes: optionsOrScopes, actorType: "service" };
  }
  return optionsOrScopes ?? {};
}

export const XERO_READ_TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  xero_sales_summary: {
    description:
      "Retrieve live Xero sales/invoice totals for a date period. Use this for current sales, sales today, this month, last month, or a date range. Do not use company knowledge search or database_summary for live Xero financial totals. Read-only. Never invent figures.",
    inputSchema: {
      type: "object",
      properties: {
        ...DATE_PROPS,
        query: { type: "string", description: "Optional natural-language date hint if period is omitted" },
      },
    },
  },
  xero_search_invoices: {
    description:
      "List or search live Xero sales invoices by date, status, outstanding/unpaid, or invoice number. Use for invoices raised today or in a date range. Do not forward free-text 'invoiced today' into search query — use fromDate/toDate. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional invoice number or customer text — not a date phrase" },
        invoiceNumber: { type: "string" },
        status: { type: "string", description: "Optional Xero status (AUTHORISED, PAID, DRAFT, VOIDED)" },
        overdueOnly: { type: "boolean", description: "Only overdue invoices" },
        unpaidOnly: { type: "boolean", description: "Only outstanding / unpaid invoices" },
        contactId: { type: "string" },
        limit: { type: "number", default: 50 },
        ...DATE_PROPS,
      },
    },
  },
  xero_get_invoice: {
    description: "Fetch one live Xero invoice by invoice number (INV-XXXX) or invoice id. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceNumber: { type: "string" },
        invoiceId: { type: "string" },
        query: { type: "string", description: "Invoice number if not passed as invoiceNumber" },
      },
    },
  },
  xero_list_overdue_invoices: {
    description: "List overdue Xero sales invoices. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        effectiveDate: { type: "string", description: "As-of date YYYY-MM-DD (defaults to today in Europe/London)" },
        contactId: { type: "string" },
        limit: { type: "number", default: 50 },
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
        query: { type: "string" },
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
  if (XERO_READ_TOOL_SCHEMAS[contract.mcpToolName]) return XERO_READ_TOOL_SCHEMAS[contract.mcpToolName];
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [key, type] of Object.entries(contract.input)) {
    properties[key.replace(/\?$/, "")] = {
      type:
        type.replace(/\?$/, "") === "number"
          ? "number"
          : type.replace(/\?$/, "") === "boolean"
            ? "boolean"
            : "string",
    };
  }
  return {
    description: `${contract.mcpToolName.replace(/_/g, " ")}. Live Xero read. Do not use company knowledge for this data.`,
    inputSchema: { type: "object", properties },
  };
}

export function withXeroReadTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  optionsOrScopes?: XeroReadOptions | readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const options = normalizeOptions(optionsOrScopes);
  const actorType = options.actorType ?? (options.scopes ? "service" : "user");
  if (actorType === "service" && !xeroReadToolsAllowed(options.scopes) && !serviceMaySeeXeroReadTools(options.scopes)) {
    return tools;
  }
  if (actorType === "user" && isElvexCompany({ id: options.companyId })) {
    if (!elvexRoleMaySeeXeroReadTools(options.userRole ?? null)) {
      return tools.filter(
        (tool) => !isXeroToolName(tool.name) && !isElMcpNativeXeroTool(tool.name),
      );
    }
  }

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

export function filterElvexXeroToolsForRole<T extends { name: string }>(
  tools: T[],
  role: CompanyRole | null,
): T[] {
  return tools.filter((tool) => {
    if (isXeroWriteToolName(tool.name) || tool.name === "create_xero_draft_invoice") {
      return false;
    }
    if (!isXeroToolName(tool.name) && !isElMcpNativeXeroTool(tool.name)) {
      return true;
    }
    const mapped = xeroActionForTool(tool.name);
    const action = mapped?.action ?? `mcp.${tool.name}`;
    return elvexAllowsAction(role, action, { toolName: tool.name }).allowed;
  });
}

export function advertisedXeroReadToolNames(): string[] {
  return [...ADVERTISED_XERO_READ_TOOLS];
}

export function xeroReadToolContractLabel(toolName: string): string {
  return contractDescription(toolName);
}
