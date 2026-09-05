/**
 * Bounded warehouse tools for OpenAI + ChatGPT MCP.
 * Never expose SQL or D1 credentials.
 */

import { classifyWarehouseRequest } from "./freshness";
import { executeWarehouseQuery, type WarehouseQueryRequest } from "./query";
import { createD1WarehouseRepository, type WarehouseRepository } from "./store";
import {
  WAREHOUSE_TOOL_NAMES,
  WAREHOUSE_XERO_CONNECTOR,
  isWarehouseToolName,
  warehouseChildDebitCents,
} from "./standard";

export { isWarehouseToolName, WAREHOUSE_TOOL_NAMES };

export const WAREHOUSE_TOOL_SCHEMAS: Array<{
  name: (typeof WAREHOUSE_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "warehouse_sales_analysis",
    description:
      "Historical/analytical Xero sales from the INFRA warehouse (monthly totals, period comparisons, trends). Not for right-now sales — use xero_sales_summary for current live figures. Read-only. Returns source=xero_warehouse, warehouse_as_of, and completeness_status. Never treat PARTIAL/BACKFILLING months as complete totals.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", description: "Inclusive YYYY-MM-DD" },
        toDate: { type: "string", description: "Inclusive YYYY-MM-DD" },
        aggregation: {
          type: "string",
          enum: ["sales_by_month", "sales_total", "invoice_count"],
        },
      },
    },
  },
  {
    name: "warehouse_invoice_analysis",
    description:
      "Historical invoice lists and counts from the warehouse. For a named invoice's current paid status use xero_get_invoice. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string" },
        toDate: { type: "string" },
        status: { type: "string" },
        invoiceNumber: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "warehouse_receivables_analysis",
    description:
      "Warehouse overdue/outstanding trends and snapshots. For who is overdue right now use xero_list_overdue_invoices. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotType: { type: "string", enum: ["xero_overdue_snapshot", "xero_receivables_snapshot"] },
        aggregation: { type: "string", enum: ["overdue_total", "outstanding_total", "snapshot_series"] },
      },
    },
  },
  {
    name: "warehouse_customer_analysis",
    description:
      "Highest-value customers over a warehouse period. Not a live ranking unless warehouse freshness is enough. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string" },
        toDate: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "warehouse_query",
    description:
      "Controlled warehouse query over approved aggregations only. Never arbitrary SQL. Tenant is the authorised company. Falls back to live Xero when the warehouse is missing, stale, or degraded.",
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["invoices", "invoice_lines", "contacts", "payments", "credit_notes", "snapshots", "kpis"],
        },
        aggregation: {
          type: "string",
          enum: [
            "sales_by_month",
            "sales_total",
            "invoice_count",
            "outstanding_total",
            "overdue_total",
            "top_customers",
            "kpi_latest",
            "snapshot_series",
            "invoice_list",
          ],
        },
        fromDate: { type: "string" },
        toDate: { type: "string" },
        status: { type: "string" },
        contactId: { type: "string" },
        invoiceNumber: { type: "string" },
        snapshotType: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
];

export function withWarehouseTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  scopes?: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  if (scopes && !scopes.includes("*") && !scopes.some((scope) => scope.startsWith("xero."))) {
    return tools;
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const schema of WAREHOUSE_TOOL_SCHEMAS) {
    if (!byName.has(schema.name)) byName.set(schema.name, schema);
  }
  return [...byName.values()];
}

export async function executeWarehouseTool(input: {
  repo?: WarehouseRepository;
  db?: D1Database;
  companyId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  intentText?: string;
}): Promise<
  | { ok: true; result: Record<string, unknown>; latencyMs: number }
  | { ok: false; status: 409 | 422 | 503; error: string; result?: Record<string, unknown> }
> {
  if (!isWarehouseToolName(input.toolName)) {
    return { ok: false, status: 409, error: "Not a warehouse tool" };
  }
  const repo = input.repo ?? (input.db ? createD1WarehouseRepository(input.db) : null);
  if (!repo) return { ok: false, status: 503, error: "Warehouse store unavailable" };
  const started = Date.now();
  const args = input.arguments ?? {};
  const request: WarehouseQueryRequest = {
    companyId: input.companyId,
    connector: WAREHOUSE_XERO_CONNECTOR,
    fromDate: typeof args.fromDate === "string" ? args.fromDate : undefined,
    toDate: typeof args.toDate === "string" ? args.toDate : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    contactId: typeof args.contactId === "string" ? args.contactId : undefined,
    invoiceNumber: typeof args.invoiceNumber === "string" ? args.invoiceNumber : undefined,
    snapshotType: typeof args.snapshotType === "string" ? args.snapshotType : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    intentText: input.intentText,
  };
  if (input.toolName === "warehouse_sales_analysis") {
    request.aggregation =
      args.aggregation === "sales_by_month" ||
      args.aggregation === "invoice_count" ||
      args.aggregation === "sales_total"
        ? args.aggregation
        : "sales_by_month";
  } else if (input.toolName === "warehouse_invoice_analysis") {
    request.entity = "invoices";
    request.aggregation = args.aggregation === "invoice_count" ? "invoice_count" : "invoice_list";
  } else if (input.toolName === "warehouse_receivables_analysis") {
    request.aggregation =
      args.aggregation === "outstanding_total" || args.aggregation === "snapshot_series"
        ? args.aggregation
        : "overdue_total";
    request.snapshotType =
      typeof args.snapshotType === "string" ? args.snapshotType : "xero_overdue_snapshot";
  } else if (input.toolName === "warehouse_customer_analysis") {
    request.aggregation = "top_customers";
  } else {
    request.entity = typeof args.entity === "string" ? (args.entity as WarehouseQueryRequest["entity"]) : undefined;
    request.aggregation =
      typeof args.aggregation === "string"
        ? (args.aggregation as WarehouseQueryRequest["aggregation"])
        : undefined;
  }
  request.freshnessClass = classifyWarehouseRequest({
    intentText: input.intentText ?? input.toolName,
    fromDate: request.fromDate,
    toDate: request.toDate,
  });
  const executed = await executeWarehouseQuery(repo, request);
  const result = {
    ...executed,
    customerChargeCents: warehouseChildDebitCents(),
    toolName: input.toolName,
  };
  if (!executed.ok) {
    return {
      ok: false,
      status: executed.fallback ? 503 : 422,
      error: executed.reason ?? "WAREHOUSE_QUERY_FAILED",
      result,
    };
  }
  return { ok: true, latencyMs: Date.now() - started, result };
}
