/**
 * INFRA Xero READ tools advertised on the ChatGPT MCP facade.
 * Writes are never advertised here — financial writes stay on the Action Engine.
 */

import { XERO_TOOL_CONTRACTS, elvexAllowsAction, isElvexCompany, type CompanyRole } from "@infra/shared";
import { xeroActionForTool, isXeroToolName, isXeroWriteToolName } from "./xero-tools";

export const ADVERTISED_XERO_READ_TOOLS = [
  "xero_sales_summary",
  "xero_search_invoices",
  "xero_get_invoice",
  "xero_list_overdue_invoices",
  "xero_top_customers",
] as const;

export type AdvertisedXeroReadTool = (typeof ADVERTISED_XERO_READ_TOOLS)[number];

const XERO_READ_SCOPE_HINTS = [
  "xero.sales.summary",
  "xero.sales.read",
  "xero.top_customers",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.contacts.read",
  "xero.contacts.search",
] as const;

export function isAdvertisedXeroReadTool(name: string): name is AdvertisedXeroReadTool {
  return (ADVERTISED_XERO_READ_TOOLS as readonly string[]).includes(name);
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

export function elvexRoleMaySeeXeroReadTools(role: CompanyRole | null): boolean {
  return elvexAllowsAction(role, "xero.sales.summary", { toolName: "xero_sales_summary" }).allowed;
}

function contractDescription(toolName: string): string {
  const contract = XERO_TOOL_CONTRACTS.find((tool) => tool.mcpToolName === toolName);
  return contract?.name ?? toolName;
}

export const XERO_READ_TOOL_SCHEMAS: Record<
  AdvertisedXeroReadTool,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  xero_sales_summary: {
    description:
      "Summarise qualifying Xero Accounts Receivable sales for a date range (today, this month, last month, or explicit fromDate/toDate). Europe/London. Read-only. Never invent figures.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description:
            "Natural period: today, yesterday, this week, last week, this month, last month, this quarter, last quarter, this year, last year, or a specific date / date range.",
        },
        fromDate: { type: "string", description: "Inclusive start date YYYY-MM-DD (Europe/London)" },
        toDate: { type: "string", description: "Inclusive end date YYYY-MM-DD (Europe/London)" },
        query: { type: "string", description: "Optional natural-language date hint if period is omitted" },
      },
    },
  },
  xero_search_invoices: {
    description:
      "List or search Xero invoices by date, customer, invoice number, outstanding, or overdue. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Customer, invoice number, or natural-language date" },
        period: { type: "string", description: "Natural period for invoice date filter" },
        fromDate: { type: "string", description: "Inclusive start date YYYY-MM-DD" },
        toDate: { type: "string", description: "Inclusive end date YYYY-MM-DD" },
        status: { type: "string", description: "Optional Xero status (AUTHORISED, PAID, DRAFT, VOIDED)" },
        overdueOnly: { type: "boolean", description: "Only overdue invoices" },
        unpaidOnly: { type: "boolean", description: "Only outstanding / unpaid invoices" },
        invoiceNumber: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  xero_get_invoice: {
    description: "Fetch one Xero invoice by invoice number (for example INV-1234) or invoice id. Read-only.",
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
    description: "List overdue Xero invoices. Read-only.",
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
      "Return top customers by qualifying Xero sales for a date range. Read-only. Never invent figures.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Natural period such as this month or last month" },
        fromDate: { type: "string" },
        toDate: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", default: 5 },
      },
    },
  },
};

export function withXeroReadTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  options?: {
    scopes?: readonly string[];
    companyId?: string;
    userRole?: CompanyRole | null;
    actorType?: "user" | "service";
  },
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const actorType = options?.actorType ?? (options?.scopes ? "service" : "user");
  if (actorType === "service" && !serviceMaySeeXeroReadTools(options?.scopes)) {
    return tools;
  }
  if (actorType === "user" && isElvexCompany({ id: options?.companyId })) {
    if (!elvexRoleMaySeeXeroReadTools(options?.userRole ?? null)) {
      return tools.filter(
        (tool) => !isXeroToolName(tool.name) && !isElMcpNativeXeroTool(tool.name),
      );
    }
  }

  const existing = new Set(tools.map((tool) => tool.name));
  const overlay = ADVERTISED_XERO_READ_TOOLS.filter((name) => !existing.has(name)).map((name) => ({
    name,
    description: XERO_READ_TOOL_SCHEMAS[name].description,
    inputSchema: XERO_READ_TOOL_SCHEMAS[name].inputSchema,
  }));
  return [...tools, ...overlay];
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
