import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";
import {
  XeroApiError,
  XeroClient,
  xeroReadTools,
  XERO_READ_TOOL_HANDLERS,
} from "@infra/xero-core";
import type { Env } from "../env";
import { getValidXeroAccessToken } from "./xero";
import { isXeroToolName, isXeroWriteToolName, prepareXeroMcpExecution } from "./xero-tools";

type ReadHandlerName = (typeof XERO_READ_TOOL_HANDLERS)[keyof typeof XERO_READ_TOOL_HANDLERS];

function xeroHeaders(token: { accessToken: string; tenantId: string }): HeadersInit {
  return {
    Authorization: `Bearer ${token.accessToken}`,
    "Xero-tenant-id": token.tenantId,
    Accept: "application/json",
  };
}

async function fetchXeroJson<T>(
  token: { accessToken: string; tenantId: string },
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, `${XERO_AUTH.apiBaseUrl.replace(/\/$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const response = await fetch(url.toString(), { headers: xeroHeaders(token) });
  const text = await response.text();
  if (!response.ok) {
    throw new XeroApiError({
      status: response.status,
      code: response.status === 401 ? "XERO_AUTH_EXPIRED" : "XERO_REQUEST_FAILED",
      message: text.slice(0, 200) || `Xero request failed (${response.status}).`,
    });
  }
  return text.trim() ? (JSON.parse(text) as T) : ({} as T);
}

async function fetchInvoicesInRange(
  token: { accessToken: string; tenantId: string },
  input: { fromDate?: string; toDate?: string; limit?: number },
) {
  const from = input.fromDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = input.toDate ?? new Date().toISOString().slice(0, 10);
  const target = Math.min(
    Math.max(1, input.limit ?? XERO_DATA_BOUNDS.defaultListResults),
    XERO_DATA_BOUNDS.maxListResults,
  );
  const invoices: Array<{
    Total?: number;
    Contact?: { ContactID?: string; Name?: string };
  }> = [];
  let page = 1;
  while (invoices.length < target && page <= 10) {
    const body = await fetchXeroJson<{ Invoices?: typeof invoices }>(token, "/Invoices", {
      where: `Date>=DateTime(${from.replace(/-/g, ",")}) AND Date<=DateTime(${to.replace(/-/g, ",")})`,
      page,
    });
    const batch = body.Invoices ?? [];
    if (!batch.length) break;
    invoices.push(...batch);
    page += 1;
  }
  return invoices.slice(0, target);
}

export async function executeXeroReadToolOnInfra(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    actor: string;
  },
): Promise<
  | { ok: true; result: Record<string, unknown>; latencyMs: number }
  | { ok: false; status: 403 | 404 | 409 | 502 | 503; error: string; code?: string }
> {
  if (!isXeroToolName(input.toolName) || isXeroWriteToolName(input.toolName)) {
    return { ok: false, status: 409, error: "Not a Xero read tool" };
  }

  const started = Date.now();
  const prepared = await prepareXeroMcpExecution({
    env,
    companyId: input.companyId,
    toolName: input.toolName,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      status: prepared.status,
      error: prepared.body.error,
      code: prepared.body.code,
    };
  }

  const token = await getValidXeroAccessToken({
    env,
    companyId: input.companyId,
    instanceId: prepared.instanceId,
    actor: input.actor,
    reason: "mcp_resolve",
  });
  if (!token.ok) {
    return {
      ok: false,
      status: token.status,
      error: token.body.error,
      code: token.body.code,
    };
  }

  const handlerName = XERO_READ_TOOL_HANDLERS[
    input.toolName as keyof typeof XERO_READ_TOOL_HANDLERS
  ] as ReadHandlerName | undefined;
  if (!handlerName) {
    return { ok: false, status: 409, error: "Xero read handler not registered" };
  }

  const handler = xeroReadTools[handlerName] as (
    client: XeroClient,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };

  try {
    if (input.toolName === "xero_get_organisation") {
      const organisationBody = await fetchXeroJson<{ Organisations?: unknown[] }>(
        xeroToken,
        "/Organisation",
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          organisation: organisationBody.Organisations?.[0] ?? null,
        },
      };
    }

    if (input.toolName === "xero_sales_summary") {
      const args = input.arguments ?? {};
      const fromDate = String(args.fromDate ?? "");
      const toDate = String(args.toDate ?? "");
      const invoices = await fetchInvoicesInRange(xeroToken, {
        fromDate,
        toDate,
        limit: XERO_DATA_BOUNDS.maxListResults,
      });
      let totalSales = 0;
      for (const row of invoices) totalSales += Number(row.Total ?? 0);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          summary: {
            fromDate,
            toDate,
            invoiceCount: invoices.length,
            totalSales,
          },
        },
      };
    }

    if (input.toolName === "xero_top_customers") {
      const args = input.arguments ?? {};
      const limit = Math.min(Math.max(1, Number(args.limit ?? 3)), 20);
      const invoices = await fetchInvoicesInRange(xeroToken, {
        fromDate: args.fromDate as string | undefined,
        toDate: args.toDate as string | undefined,
        limit: XERO_DATA_BOUNDS.maxListResults,
      });
      const totals = new Map<string, { contactId: string; name: string; total: number }>();
      for (const row of invoices) {
        const id = row.Contact?.ContactID ?? "unknown";
        const existing = totals.get(id) ?? {
          contactId: id,
          name: row.Contact?.Name ?? "Unknown",
          total: 0,
        };
        existing.total += Number(row.Total ?? 0);
        totals.set(id, existing);
      }
      const customers = [...totals.values()].sort((a, b) => b.total - a.total).slice(0, limit);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          customers,
        },
      };
    }

    const workerClient = new XeroClient({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      apiBaseUrl: XERO_AUTH.apiBaseUrl,
      fetchImpl: fetch,
    });

    const payload = await handler(workerClient, input.arguments ?? {});
    return {
      ok: true,
      latencyMs: Date.now() - started,
      result: {
        organisationName: token.payload.organisationName,
        ...payload,
      },
    };
  } catch (error) {
    if (error instanceof XeroApiError) {
      return {
        ok: false,
        status: error.provider.status === 504 ? 503 : 502,
        error: error.provider.message,
        code: error.provider.code,
      };
    }
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : "Xero execution failed";
    return { ok: false, status: 502, error: message, code: "XERO_EXECUTION_FAILED" };
  }
}
