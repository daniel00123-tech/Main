/**
 * Company-MCP Xero read fallback.
 * Used when the company Xero connector is connected via company MCP
 * (mirrored, no INFRA credential_ref) — Elvex today.
 * Does not copy or rotate Xero credentials.
 */

import {
  SALES_SEMANTICS,
  aggregateSales,
  aggregateTopCustomers,
  classifySalesDocuments,
  type RawSalesDocument,
} from "@infra/xero-core";
import { isXeroWriteToolName } from "./xero-tools";
import type { Env } from "../env";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { listMcpTools } from "./mcp-client";
import { newId, nowIso } from "../db/mappers";

export const EL_XERO_READ_ALIASES: Record<string, string[]> = {
  xero_sales_summary: [
    "xero_sales_summary",
    "search_xero_invoices",
    "analyse_xero_sales",
    "get_xero_financial_summary",
  ],
  xero_search_invoices: ["xero_search_invoices", "search_xero_invoices"],
  xero_get_invoice: ["xero_get_invoice", "get_xero_invoice", "search_xero_invoices"],
  xero_list_overdue_invoices: ["xero_list_overdue_invoices", "search_xero_invoices"],
  xero_top_customers: ["xero_top_customers", "search_xero_invoices", "analyse_xero_sales"],
  xero_list_contacts: ["xero_list_contacts", "search_xero_contacts"],
  xero_get_contact: ["xero_get_contact", "get_xero_contact"],
  xero_get_organisation: ["xero_get_organisation", "get_xero_organisation"],
  xero_profit_and_loss: ["xero_profit_and_loss", "get_xero_financial_summary"],
};

function isWriteLikeTool(name: string): boolean {
  return isXeroWriteToolName(name) || /create|approve|send|allocate|void|update|delete|draft/i.test(name);
}

export function pickCompanyXeroTool(available: string[], desired: string): string | null {
  const names = new Set(available);
  const aliases = EL_XERO_READ_ALIASES[desired] ?? [desired];
  for (const alias of aliases) {
    if (names.has(alias) && !isWriteLikeTool(alias)) return alias;
  }
  if (names.has(desired) && !isWriteLikeTool(desired)) return desired;
  return null;
}

async function ensureXeroToolsAllowlisted(
  db: D1Database,
  companyId: string,
  mcpEnvironmentId: string,
  toolNames: string[],
): Promise<void> {
  const now = nowIso();
  for (const toolName of toolNames) {
    if (isWriteLikeTool(toolName)) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_allowlist
          (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
      )
      .bind(newId("allow"), companyId, mcpEnvironmentId, toolName, now, now)
      .run();
  }
}

export function mapArgsForCompanyXeroTool(
  desired: string,
  forwardName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = { ...args };
  if (typeof args.fromDate === "string") {
    forwarded.from = args.fromDate;
    forwarded.fromDate = args.fromDate;
  }
  if (typeof args.toDate === "string") {
    forwarded.to = args.toDate;
    forwarded.toDate = args.toDate;
  }
  if (desired === "xero_list_overdue_invoices") {
    forwarded.overdueOnly = true;
    forwarded.unpaidOnly = true;
  }
  if (desired === "xero_search_invoices" && args.unpaidOnly === true) {
    forwarded.unpaidOnly = true;
  }
  if (desired === "xero_get_invoice" && forwardName === "search_xero_invoices") {
    forwarded.query = args.invoiceNumber ?? args.invoiceId ?? args.query;
  }
  if (
    (desired === "xero_search_invoices" || desired === "xero_sales_summary" || desired === "xero_top_customers") &&
    typeof forwarded.query === "string" &&
    !/^INV-/i.test(forwarded.query)
  ) {
    delete forwarded.query;
  }
  if (forwardName === "analyse_xero_sales" && !forwarded.query) {
    forwarded.query = typeof args.periodLabel === "string" ? args.periodLabel : "sales";
  }
  if (
    (desired === "xero_sales_summary" || desired === "xero_search_invoices" || desired === "xero_top_customers") &&
    !forwarded.invoiceType
  ) {
    forwarded.invoiceType = "ACCREC";
  }
  if (forwarded.limit == null) {
    forwarded.limit = desired === "xero_sales_summary" || desired === "xero_top_customers" ? 100 : 50;
  }
  return forwarded;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invoiceRowsFromUnknown(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  }
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["invoices", "Invoices", "results", "items", "transactions", "documents"]) {
    if (Array.isArray(record[key])) return invoiceRowsFromUnknown(record[key]);
  }
  if (record.data) return invoiceRowsFromUnknown(record.data);
  if (record.result) return invoiceRowsFromUnknown(record.result);
  return [];
}

export function extractRawSalesDocuments(value: unknown): RawSalesDocument[] {
  return invoiceRowsFromUnknown(value).map((row) => {
    const contact = asRecord(row.Contact) ?? asRecord(row.contact);
    const type = String(row.Type ?? row.type ?? row.transactionType ?? "ACCREC");
    const kind =
      /credit/i.test(type) || row.documentKind === "credit_note" ? "credit_note" : "invoice";
    return {
      documentKind: kind,
      documentId: (row.InvoiceID ?? row.invoiceId ?? row.documentId ?? null) as string | null,
      documentNumber: (row.InvoiceNumber ?? row.invoiceNumber ?? row.documentNumber ?? null) as
        | string
        | null,
      contactId: (row.ContactID ?? contact?.ContactID ?? row.contactId ?? contact?.contactId ?? null) as
        | string
        | null,
      contactName: (row.ContactName ??
        contact?.Name ??
        row.contactName ??
        contact?.name ??
        null) as string | null,
      transactionType: type,
      status: (row.Status ?? row.status ?? null) as string | null,
      date: (row.Date ?? row.date ?? row.InvoiceDate ?? null) as string | null,
      total: Number(row.Total ?? row.total ?? row.SubTotal ?? row.amount ?? 0),
    };
  });
}

export function composeInfraXeroReadResult(
  desired: string,
  args: Record<string, unknown>,
  upstream: Record<string, unknown>,
  companyToolName: string,
): Record<string, unknown> {
  const retrievedAt = nowIso();
  const fromDate = typeof args.fromDate === "string" ? args.fromDate : null;
  const toDate = typeof args.toDate === "string" ? args.toDate : null;
  const periodLabel =
    typeof args.periodLabel === "string" ? args.periodLabel : fromDate && toDate ? `${fromDate} to ${toDate}` : null;
  const documents = extractRawSalesDocuments(upstream);
  const invoices = invoiceRowsFromUnknown(upstream);
  const invoiceNumbers = documents
    .map((doc) => doc.documentNumber)
    .filter((value): value is string => Boolean(value && value.trim()));

  const base = {
    source: "Xero",
    retrieved_at: retrievedAt,
    via: "company_mcp",
    toolName: desired,
    companyToolName,
    period: fromDate || toDate ? { fromDate, toDate, label: periodLabel } : undefined,
  };

  if (
    desired === "xero_sales_summary" &&
    (documents.length > 0 || (invoices.length === 0 && "invoices" in upstream))
  ) {
    const aggregated = aggregateSales(classifySalesDocuments(documents));
    return {
      ...base,
      currencyCode: upstream.currencyCode ?? upstream.currency ?? null,
      currency: upstream.currencyCode ?? upstream.currency ?? null,
      semantics: SALES_SEMANTICS,
      sales_total: aggregated.totalSales,
      invoice_count: aggregated.qualifyingTransactionCount,
      summary: {
        fromDate,
        toDate,
        transactionCount: aggregated.qualifyingTransactionCount,
        excludedTransactionCount: aggregated.excludedTransactionCount,
        totalSales: aggregated.totalSales,
        currencyCode: upstream.currencyCode ?? upstream.currency ?? null,
      },
      transactions: aggregated.transactions,
      excludedTransactions: aggregated.excludedTransactions,
    };
  }

  if (desired === "xero_top_customers" && documents.length > 0) {
    const limit = Math.min(Math.max(1, Number(args.limit ?? 5)), 20);
    return {
      ...base,
      currencyCode: upstream.currencyCode ?? upstream.currency ?? null,
      customers: aggregateTopCustomers(classifySalesDocuments(documents), limit),
    };
  }

  if (desired === "xero_search_invoices" || desired === "xero_list_overdue_invoices") {
    return {
      ...base,
      fromDate,
      toDate,
      invoice_numbers: invoiceNumbers,
      invoices: invoices.length ? invoices : documents,
      count: invoices.length || documents.length,
    };
  }

  if (desired === "xero_get_invoice") {
    const invoice = invoices[0] ?? (asRecord(upstream.invoice) ?? null);
    return {
      ...base,
      invoice,
      invoiceNumber: invoice?.InvoiceNumber ?? invoice?.invoiceNumber ?? args.invoiceNumber ?? null,
    };
  }

  const summary = asRecord(upstream.summary);
  const totalFromUpstream =
    typeof upstream.sales_total === "number"
      ? upstream.sales_total
      : typeof upstream.totalSales === "number"
        ? upstream.totalSales
        : typeof summary?.totalSales === "number"
          ? summary.totalSales
          : undefined;

  if (desired === "xero_sales_summary" && typeof totalFromUpstream === "number") {
    return {
      ...base,
      currencyCode: upstream.currencyCode ?? upstream.currency ?? null,
      currency: upstream.currencyCode ?? upstream.currency ?? null,
      semantics: SALES_SEMANTICS,
      sales_total: totalFromUpstream,
      invoice_count:
        typeof upstream.invoice_count === "number"
          ? upstream.invoice_count
          : Number(summary?.transactionCount ?? invoices.length ?? 0),
      summary: {
        fromDate,
        toDate,
        totalSales: totalFromUpstream,
        transactionCount:
          typeof summary?.transactionCount === "number" ? summary.transactionCount : invoices.length,
        currencyCode: upstream.currencyCode ?? upstream.currency ?? null,
      },
    };
  }

  return {
    ...upstream,
    ...base,
  };
}

export async function executeCompanyMcpXeroRead(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
  },
): Promise<
  | { ok: true; result: Record<string, unknown>; latencyMs: number; via: "company_mcp"; companyToolName: string }
  | { ok: false; status: 403 | 404 | 409 | 502 | 503; error: string; code?: string }
> {
  if (isWriteLikeTool(input.toolName)) {
    return { ok: false, status: 403, error: "Xero write tools are not available on this read path", code: "XERO_WRITE_DENIED" };
  }

  const mcp = (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled);
  if (!mcp) {
    return { ok: false, status: 503, error: "Business MCP unavailable", code: "XERO_MCP_UNAVAILABLE" };
  }

  let listedNames = Object.values(EL_XERO_READ_ALIASES).flat();
  let forwardName = pickCompanyXeroTool(listedNames, input.toolName);
  if (!forwardName) {
    try {
      const listed = await listMcpTools(env, mcp.endpointUrl, mcp.authSecretRef, mcp.serviceBindingRef);
      listedNames = listed.tools.map((tool) => tool.name);
      forwardName = pickCompanyXeroTool(listedNames, input.toolName);
    } catch {
      forwardName = pickCompanyXeroTool(Object.values(EL_XERO_READ_ALIASES).flat(), input.toolName);
    }
  }
  if (!forwardName) {
    return {
      ok: false,
      status: 409,
      error: "This Xero read capability isn’t available through this connection yet.",
      code: "XERO_TOOL_NOT_IMPLEMENTED",
    };
  }

  await ensureXeroToolsAllowlisted(env.DB, input.companyId, mcp.id, [forwardName, input.toolName]);

  const started = Date.now();
  const execution = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: forwardName,
    arguments: mapArgsForCompanyXeroTool(input.toolName, forwardName, input.arguments ?? {}),
    actorUserId: input.actorUserId ?? "system",
    actorEmail: input.actor,
    sourceClient: "infra-xero",
    skipUsageRecording: true,
  });

  if (execution.status !== 200) {
    return {
      ok: false,
      status: execution.status >= 400 && execution.status < 600 ? (execution.status as 403 | 404 | 409 | 502 | 503) : 502,
      error: execution.error ?? "I couldn’t retrieve Xero data just now.",
      code: execution.status === 404 ? "XERO_TOOL_NOT_IMPLEMENTED" : "XERO_MCP_UPSTREAM",
    };
  }

  const upstream = "data" in execution ? execution.data?.result : undefined;
  let record: Record<string, unknown>;
  if (typeof upstream === "string") {
    try {
      const parsed = JSON.parse(upstream) as unknown;
      record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { result: upstream };
    } catch {
      record = { result: upstream };
    }
  } else if (upstream && typeof upstream === "object") {
    record = upstream as Record<string, unknown>;
  } else {
    record = { result: upstream };
  }
  return {
    ok: true,
    result: composeInfraXeroReadResult(input.toolName, input.arguments ?? {}, record, forwardName),
    latencyMs: Date.now() - started,
    via: "company_mcp",
    companyToolName: forwardName,
  };
}
