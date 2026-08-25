import { XERO_AUTH, XERO_DATA_BOUNDS } from "@infra/shared";
import {
  XeroApiError,
  XeroClient,
  xeroReadTools,
  XERO_READ_TOOL_HANDLERS,
  aggregateSales,
  aggregateTopCustomers,
  classifySalesDocuments,
  customerSafeXeroErrorMessage,
  dateRangeWhere,
  getContactWithFetch,
  listContactsWithFetch,
  mapCreditNoteRow,
  mapInvoiceRow,
  profitAndLossWithFetch,
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

async function fetchOrganisationBaseCurrency(
  token: { accessToken: string; tenantId: string },
): Promise<string | null> {
  const body = await fetchXeroJson<{ Organisations?: Array<{ BaseCurrency?: string }> }>(
    token,
    "/Organisation",
  );
  return body.Organisations?.[0]?.BaseCurrency ?? null;
}

async function fetchPagedXeroCollection<T>(
  token: { accessToken: string; tenantId: string },
  path: "/Invoices" | "/CreditNotes",
  collectionKey: "Invoices" | "CreditNotes",
  where: string,
  target: number,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  while (rows.length < target && page <= 10) {
    const body = await fetchXeroJson<Record<string, T[]>>(token, path, { where, page });
    const batch = body[collectionKey] ?? [];
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return rows.slice(0, target);
}

async function fetchSalesDocumentsWithToken(
  token: { accessToken: string; tenantId: string },
  input: { fromDate: string; toDate: string; limit?: number },
) {
  const where = dateRangeWhere(input.fromDate, input.toDate);
  const target = Math.min(
    Math.max(1, input.limit ?? XERO_DATA_BOUNDS.defaultListResults),
    XERO_DATA_BOUNDS.maxListResults,
  );
  const invoices = await fetchPagedXeroCollection<Record<string, unknown>>(
    token,
    "/Invoices",
    "Invoices",
    where,
    target,
  );
  const creditNotes = await fetchPagedXeroCollection<Record<string, unknown>>(
    token,
    "/CreditNotes",
    "CreditNotes",
    where,
    target,
  );
  return [
    ...invoices.map(mapInvoiceRow),
    ...creditNotes.map(mapCreditNoteRow),
  ];
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

  const workerClient = new XeroClient({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
    apiBaseUrl: XERO_AUTH.apiBaseUrl,
    fetchImpl: fetch,
  });

  try {
    if (input.toolName === "xero_get_organisation") {
      const organisationBody = await fetchXeroJson<{ Organisations?: unknown[] }>(
        { accessToken: token.accessToken, tenantId: token.tenantId },
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
      const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };
      const currencyCode = await fetchOrganisationBaseCurrency(xeroToken);
      const raw = await fetchSalesDocumentsWithToken(xeroToken, {
        fromDate,
        toDate,
        limit: XERO_DATA_BOUNDS.maxListResults,
      });
      const aggregated = aggregateSales(classifySalesDocuments(raw));
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          currencyCode,
          summary: {
            fromDate,
            toDate,
            transactionCount: aggregated.qualifyingTransactionCount,
            excludedTransactionCount: aggregated.excludedTransactionCount,
            totalSales: aggregated.totalSales,
            currencyCode,
          },
          transactions: aggregated.transactions,
          excludedTransactions: aggregated.excludedTransactions,
        },
      };
    }

    if (input.toolName === "xero_profit_and_loss") {
      const args = input.arguments ?? {};
      const fromDate = String(args.fromDate ?? "");
      const toDate = String(args.toDate ?? "");
      const payload = await profitAndLossWithFetch(
        {
          accessToken: token.accessToken,
          tenantId: token.tenantId,
          apiBaseUrl: XERO_AUTH.apiBaseUrl,
          fetchImpl: fetch,
        },
        {
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          periods: args.periods != null ? Number(args.periods) : undefined,
          timeframe: args.timeframe as "MONTH" | "QUARTER" | "YEAR" | undefined,
        },
      );
      const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };
      const organisationCurrency =
        payload.parsed.currencyCode ?? (await fetchOrganisationBaseCurrency(xeroToken));
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          currencyCode: organisationCurrency,
          fromDate: fromDate || null,
          toDate: toDate || null,
          parsed: {
            ...payload.parsed,
            currencyCode: organisationCurrency,
          },
          report: payload.report,
        },
      };
    }

    if (input.toolName === "xero_top_customers") {
      const args = input.arguments ?? {};
      const limit = Math.min(Math.max(1, Number(args.limit ?? 3)), 20);
      const fromDate = String(args.fromDate ?? "");
      const toDate = String(args.toDate ?? "");
      const xeroToken = { accessToken: token.accessToken, tenantId: token.tenantId };
      const currencyCode = await fetchOrganisationBaseCurrency(xeroToken);
      const raw = await fetchSalesDocumentsWithToken(xeroToken, {
        fromDate,
        toDate,
        limit: XERO_DATA_BOUNDS.maxListResults,
      });
      const customers = aggregateTopCustomers(classifySalesDocuments(raw), limit).map(
        (customer) => ({ ...customer, currencyCode }),
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          currencyCode,
          customers,
        },
      };
    }

    if (input.toolName === "xero_list_contacts") {
      const args = input.arguments ?? {};
      const payload = await listContactsWithFetch(
        {
          accessToken: token.accessToken,
          tenantId: token.tenantId,
          apiBaseUrl: XERO_AUTH.apiBaseUrl,
          fetchImpl: fetch,
        },
        {
          query: args.query != null ? String(args.query) : undefined,
          contactType: args.contactType != null ? String(args.contactType) : undefined,
          limit: args.limit != null ? Number(args.limit) : undefined,
        },
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          ...payload,
        },
      };
    }

    if (input.toolName === "xero_get_contact") {
      const args = input.arguments ?? {};
      const contactId = String(args.contactId ?? "").trim();
      if (!contactId) {
        return { ok: false, status: 409, error: "contactId is required", code: "VALIDATION_FAILED" };
      }
      const payload = await getContactWithFetch(
        {
          accessToken: token.accessToken,
          tenantId: token.tenantId,
          apiBaseUrl: XERO_AUTH.apiBaseUrl,
          fetchImpl: fetch,
        },
        { contactId },
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        result: {
          organisationName: token.payload.organisationName,
          ...payload,
        },
      };
    }

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
        error: customerSafeXeroErrorMessage(error.provider.code, error.provider.message),
        code: error.provider.code,
      };
    }
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : "Xero execution failed";
    return { ok: false, status: 502, error: message, code: "XERO_EXECUTION_FAILED" };
  }
}
