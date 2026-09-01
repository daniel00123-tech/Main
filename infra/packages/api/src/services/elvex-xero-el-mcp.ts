/**
 * Elvex Xero READ execution via the existing EL Business MCP.
 * Does not copy Xero credentials into INFRA. Never invents figures.
 */

import { isElvexCompany } from "@infra/shared";
import type { Env } from "../env";
import { callMcpTool, listMcpTools, type McpToolDefinition } from "./mcp-client";
import {
  withResolvedBusinessDates,
  resolveBusinessPeriod,
  formatCivilDate,
  londonCivilParts,
} from "./intelligence/periods";
import { isXeroToolName, isXeroWriteToolName } from "./xero-tools";

const EL_MCP_FALLBACK: Record<string, string> = {
  xero_sales_summary: "analyse_xero_sales",
  xero_top_customers: "analyse_xero_sales",
  xero_search_invoices: "search_xero_invoices",
  xero_get_invoice: "search_xero_invoices",
  xero_list_overdue_invoices: "search_xero_invoices",
  xero_profit_and_loss: "get_xero_financial_summary",
};

export function shouldExecuteElvexXeroViaElMcp(
  companyId: string,
  toolName: string,
): boolean {
  return (
    isElvexCompany({ id: companyId }) &&
    isXeroToolName(toolName) &&
    !isXeroWriteToolName(toolName)
  );
}

export function resolveElMcpXeroToolName(
  infraToolName: string,
  listedNames: readonly string[],
): string {
  if (listedNames.includes(infraToolName)) return infraToolName;
  const mapped = EL_MCP_FALLBACK[infraToolName];
  if (mapped && listedNames.includes(mapped)) return mapped;
  return mapped ?? infraToolName;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseElMcpPayload(textContent: string | null, rawResult: unknown): Record<string, unknown> {
  if (textContent) {
    try {
      const parsed = JSON.parse(textContent);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return { text: textContent };
    } catch {
      return { text: textContent };
    }
  }
  const record = asRecord(rawResult);
  if (record) return record;
  return { result: rawResult ?? null };
}

export function mapArgumentsForElMcpTool(
  infraToolName: string,
  elToolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const fromDate = String(args.fromDate ?? args.from_date ?? "").trim() || undefined;
  const toDate = String(args.toDate ?? args.to_date ?? "").trim() || undefined;
  const period = String(args.period ?? args.periodLabel ?? "").trim() || undefined;
  const query = String(args.query ?? "").trim() || undefined;
  const invoiceNumber =
    String(args.invoiceNumber ?? args.invoice_number ?? "").trim() ||
    (query && /^INV[-_]?\w+/i.test(query) ? query : undefined);
  const invoiceId = String(args.invoiceId ?? args.invoice_id ?? "").trim() || undefined;
  const limit = args.limit != null ? Number(args.limit) : undefined;
  const overdueOnly = args.overdueOnly === true || infraToolName === "xero_list_overdue_invoices";
  const unpaidOnly = args.unpaidOnly === true;

  const dateAliases = {
    fromDate,
    toDate,
    from_date: fromDate,
    to_date: toDate,
    start_date: fromDate,
    end_date: toDate,
    period,
    periodLabel: args.periodLabel,
  };

  if (elToolName === "search_xero_invoices") {
    return {
      ...dateAliases,
      query: invoiceNumber ?? query,
      invoice_number: invoiceNumber,
      invoiceNumber,
      invoice_id: invoiceId,
      invoiceId,
      status: args.status != null ? String(args.status) : undefined,
      overdue: overdueOnly || undefined,
      overdueOnly: overdueOnly || undefined,
      unpaid: unpaidOnly || undefined,
      unpaidOnly: unpaidOnly || undefined,
      outstanding: unpaidOnly || undefined,
      limit,
    };
  }

  if (elToolName === "analyse_xero_sales" || elToolName === "get_xero_financial_summary") {
    return {
      ...dateAliases,
      query,
      limit: infraToolName === "xero_top_customers" ? (limit ?? 5) : limit,
      top_customers: infraToolName === "xero_top_customers" ? true : undefined,
      group_by: infraToolName === "xero_top_customers" ? "customer" : undefined,
    };
  }

  return {
    ...args,
    ...dateAliases,
    query,
    invoiceNumber,
    invoiceId,
    overdueOnly,
    unpaidOnly,
    limit,
  };
}

export function resolveXeroReadArguments(
  toolName: string,
  args: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
  const hint = [args.period, args.query, args.periodLabel]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
  const resolved = withResolvedBusinessDates(toolName, args, hint || "this month", now);
  if (toolName === "xero_list_overdue_invoices" && !String(resolved.effectiveDate ?? "").trim()) {
    const today = londonCivilParts(now);
    resolved.effectiveDate = formatCivilDate({
      year: today.year,
      month: today.month,
      day: today.day,
    });
  }
  if (
    toolName === "xero_get_invoice" &&
    !String(resolved.invoiceNumber ?? "").trim() &&
    !String(resolved.invoiceId ?? "").trim()
  ) {
    const query = String(resolved.query ?? "").trim();
    if (query) resolved.invoiceNumber = query;
  }
  return resolved;
}

function hasUsablePayload(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).length > 0;
}

export async function executeElvexXeroReadViaElMcp(
  env: Env,
  input: {
    companyId: string;
    mcp: {
      endpointUrl: string;
      authSecretRef?: string | null;
      serviceBindingRef?: string | null;
    };
    toolName: string;
    arguments?: Record<string, unknown>;
  },
): Promise<
  | { ok: true; result: Record<string, unknown>; latencyMs: number; elToolName: string }
  | { ok: false; status: 502 | 503; error: string; code: string }
> {
  const started = Date.now();
  const args = resolveXeroReadArguments(input.toolName, input.arguments ?? {});

  let listed: McpToolDefinition[] = [];
  try {
    const remote = await listMcpTools(
      env,
      input.mcp.endpointUrl,
      input.mcp.authSecretRef,
      input.mcp.serviceBindingRef,
    );
    listed = remote.tools;
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "EL MCP tools/list failed",
      code: "EL_MCP_UNAVAILABLE",
    };
  }

  const elToolName = resolveElMcpXeroToolName(
    input.toolName,
    listed.map((tool) => tool.name),
  );
  if (!listed.some((tool) => tool.name === elToolName)) {
    return {
      ok: false,
      status: 502,
      error: `EL MCP does not expose a Xero read tool for ${input.toolName}`,
      code: "EL_MCP_XERO_TOOL_MISSING",
    };
  }

  const forwardArgs = mapArgumentsForElMcpTool(input.toolName, elToolName, args);

  try {
    const execution = await callMcpTool(env, {
      endpointUrl: input.mcp.endpointUrl,
      authSecretRef: input.mcp.authSecretRef,
      serviceBindingRef: input.mcp.serviceBindingRef,
      toolName: elToolName,
      arguments: forwardArgs,
    });
    const payload = parseElMcpPayload(execution.textContent, execution.result);
    if (!hasUsablePayload(payload)) {
      return {
        ok: false,
        status: 502,
        error: "EL MCP returned an empty Xero payload",
        code: "EL_MCP_EMPTY_RESULT",
      };
    }

    let comparison: Record<string, unknown> | undefined;
    if (args.comparisonRequested === true && args.comparisonFromDate && args.comparisonToDate) {
      try {
        const compareArgs = mapArgumentsForElMcpTool(input.toolName, elToolName, {
          ...args,
          fromDate: args.comparisonFromDate,
          toDate: args.comparisonToDate,
          period: args.comparisonLabel,
        });
        const compareExec = await callMcpTool(env, {
          endpointUrl: input.mcp.endpointUrl,
          authSecretRef: input.mcp.authSecretRef,
          serviceBindingRef: input.mcp.serviceBindingRef,
          toolName: elToolName,
          arguments: compareArgs,
        });
        comparison = parseElMcpPayload(compareExec.textContent, compareExec.result);
      } catch {
        comparison = undefined;
      }
    }

    return {
      ok: true,
      latencyMs: Date.now() - started,
      elToolName,
      result: {
        source: "el-business-mcp",
        infraToolName: input.toolName,
        elToolName,
        fromDate: args.fromDate ?? null,
        toDate: args.toDate ?? null,
        periodLabel: args.periodLabel ?? args.period ?? null,
        comparisonRequested: args.comparisonRequested === true,
        comparisonSupported: Boolean(comparison),
        comparison,
        ...payload,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "EL MCP Xero read failed";
    return {
      ok: false,
      status: 502,
      error: message,
      code: "EL_MCP_XERO_EXECUTION_FAILED",
    };
  }
}

/** Exported for tests — period helper used when ChatGPT only sends a period string. */
export function periodHintFromArgs(args: Record<string, unknown>): string {
  if (typeof args.period === "string" && args.period.trim()) return args.period.trim();
  if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
  return "this month";
}

export function resolvePeriodOrDefault(text: string, now = new Date()) {
  return resolveBusinessPeriod(text, now);
}
