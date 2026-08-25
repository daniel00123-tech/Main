import { XeroApiError, XeroClient, xeroReadTools } from "@infra/xero-core";

export type CaddingtonMcpEnv = {
  MCP_AUTH_TOKEN?: string;
  INFRA_API_URL?: string;
  INFRA_MCP_ENVIRONMENT_ID?: string;
  __infraXeroContext?: InfraXeroContext;
};

export type InfraXeroContext = {
  tenantId: string;
  apiBaseUrl: string;
  accessToken: string;
  instanceId: string;
  organisationName: string | null;
  grantedScopes: string[];
};

type ZodLike = {
  string: () => {
    min: (n: number) => { describe: (d: string) => unknown; optional: () => unknown };
    optional: () => unknown;
    describe: (d: string) => unknown;
  };
  number: () => {
    int: () => {
      min: (n: number) => {
        max: (n: number) => { optional: () => unknown; describe: (d: string) => unknown };
        optional: () => unknown;
        describe: (d: string) => unknown;
      };
    };
    optional: () => unknown;
  };
  boolean: () => { optional: () => unknown };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodField = any;

type McpToolServer = {
  registerTool: (
    name: string,
    config: { description: string; inputSchema?: Record<string, unknown> },
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
  ) => void;
};

function stripInternalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { _infraXeroContext: _ignored, ...rest } = args;
  return rest;
}

function injectedContextFromArgs(
  args: Record<string, unknown>,
): InfraXeroContext | null {
  const raw = args._infraXeroContext;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const accessToken = String(record.accessToken ?? "");
  const tenantId = String(record.tenantId ?? "");
  const apiBaseUrl = String(record.apiBaseUrl ?? "");
  if (!accessToken || !tenantId || !apiBaseUrl) return null;
  return {
    accessToken,
    tenantId,
    apiBaseUrl,
    instanceId: String(record.instanceId ?? ""),
    organisationName: record.organisationName ? String(record.organisationName) : null,
    grantedScopes: Array.isArray(record.grantedScopes)
      ? record.grantedScopes.map(String)
      : [],
  };
}

function normalizeMcpAuthToken(value: string | undefined): string {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "");
}

const DEFAULT_INFRA_API = "https://infra-api.daniel-dwyer123.workers.dev";
const DEFAULT_MCP_ID = "mcp_caddington_primary";

export async function fetchInfraXeroContext(env: CaddingtonMcpEnv): Promise<
  | { ok: true; context: InfraXeroContext }
  | { ok: false; code: string; message: string; status: number }
> {
  const base = (env.INFRA_API_URL ?? DEFAULT_INFRA_API).replace(/\/$/, "");
  const mcpId = env.INFRA_MCP_ENVIRONMENT_ID ?? DEFAULT_MCP_ID;
  const token = normalizeMcpAuthToken(env.MCP_AUTH_TOKEN);
  if (!token) {
    return {
      ok: false,
      code: "XERO_BRIDGE_NOT_CONFIGURED",
      message: "Xero bridge auth is not configured on this MCP Worker.",
      status: 503,
    };
  }

  const response = await fetch(`${base}/api/internal/mcp/${mcpId}/xero/context`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      code: String(body.code ?? "XERO_NOT_CONNECTED"),
      message: String(body.error ?? "Xero is not connected for this company."),
      status: response.status,
    };
  }

  return {
    ok: true,
    context: {
      tenantId: String(body.tenantId),
      apiBaseUrl: String(body.apiBaseUrl),
      accessToken: String(body.accessToken),
      instanceId: String(body.instanceId),
      organisationName: body.organisationName ? String(body.organisationName) : null,
      grantedScopes: Array.isArray(body.grantedScopes) ? body.grantedScopes.map(String) : [],
    },
  };
}

function toolError(message: string, code?: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code: code ?? "XERO_ERROR" }) }],
    isError: true,
  };
}

function toolSuccess(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function withXeroClient<T>(
  env: CaddingtonMcpEnv,
  run: (
    client: XeroClient,
    context: InfraXeroContext,
    args: Record<string, unknown>,
  ) => Promise<T>,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const injected =
    injectedContextFromArgs(args) ??
    (env.__infraXeroContext ? env.__infraXeroContext : null);
  const resolved = injected
    ? { ok: true as const, context: injected }
    : await fetchInfraXeroContext(env);
  if (!resolved.ok) {
    return toolError(resolved.message, resolved.code);
  }
  const xeroArgs = stripInternalArgs(args);
  const client = new XeroClient({
    accessToken: resolved.context.accessToken,
    tenantId: resolved.context.tenantId,
    apiBaseUrl: resolved.context.apiBaseUrl,
  });
  try {
    const result = await run(client, resolved.context, xeroArgs);
    return toolSuccess({
      organisationName: resolved.context.organisationName,
      ...((typeof result === "object" && result !== null ? result : { result }) as object),
    });
  } catch (error) {
    if (error instanceof XeroApiError) {
      return toolError(error.provider.message, error.provider.code);
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(message, "XERO_EXECUTION_FAILED");
  }
}

export function registerXeroReadTools(server: McpToolServer, env: CaddingtonMcpEnv, z: ZodLike) {
  const zf: ZodField = z;
  server.registerTool(
    "xero_get_organisation",
    {
      description:
        "Read the connected Xero organisation profile for this company. Live data only.",
    },
    async (args = {}) =>
      withXeroClient(env, (client, _context, _xeroArgs) => xeroReadTools.getOrganisation(client), args),
  );

  server.registerTool(
    "xero_list_contacts",
    {
      description: "Search/list Xero contacts (customers and suppliers). Live data only.",
      inputSchema: {
        query: zf.string().optional().describe("Name search."),
        contactType: zf.string().optional().describe("Optional contact type hint."),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listContacts(client, {
          query: xeroArgs.query as string | undefined,
          contactType: xeroArgs.contactType as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_get_contact",
    {
      description: "Fetch one Xero contact by id. Live data only.",
      inputSchema: {
        contactId: zf.string().min(1).describe("Xero ContactID GUID."),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.getContact(client, { contactId: String(xeroArgs.contactId) }),
        args,
      ),
  );

  server.registerTool(
    "xero_search_invoices",
    {
      description:
        "Search Xero invoices with optional status, customer, overdue/unpaid filters and date range. Live data only.",
      inputSchema: {
        query: zf.string().optional().describe("Invoice number contains."),
        status: zf.string().optional(),
        contactId: zf.string().optional(),
        overdueOnly: zf.boolean().optional(),
        unpaidOnly: zf.boolean().optional(),
        fromDate: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        toDate: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.searchInvoices(client, {
          query: xeroArgs.query as string | undefined,
          status: xeroArgs.status as string | undefined,
          contactId: xeroArgs.contactId as string | undefined,
          overdueOnly: xeroArgs.overdueOnly as boolean | undefined,
          unpaidOnly: xeroArgs.unpaidOnly as boolean | undefined,
          fromDate: xeroArgs.fromDate as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_get_invoice",
    {
      description: "Fetch one invoice by Xero id or invoice number (e.g. INV-01800). Live data only.",
      inputSchema: {
        invoiceId: zf.string().optional(),
        invoiceNumber: zf.string().optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.getInvoice(client, {
          invoiceId: xeroArgs.invoiceId as string | undefined,
          invoiceNumber: xeroArgs.invoiceNumber as string | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_overdue_invoices",
    {
      description: "List overdue unpaid Xero invoices. Live data only.",
      inputSchema: {
        contactId: zf.string().optional(),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listOverdueInvoices(client, {
          contactId: xeroArgs.contactId as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_payments",
    {
      description: "List recent Xero payments in a bounded date range. Live data only.",
      inputSchema: {
        since: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        toDate: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listPayments(client, {
          since: xeroArgs.since as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_accounts",
    {
      description: "List chart of accounts from Xero. Live data only.",
      inputSchema: {
        accountType: zf.string().optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listAccounts(client, {
          accountType: xeroArgs.accountType as string | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_bank_transactions",
    {
      description: "List recent bank transactions in a bounded date range. Live data only.",
      inputSchema: {
        since: zf.string().optional(),
        toDate: zf.string().optional(),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listBankTransactions(client, {
          since: xeroArgs.since as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_profit_and_loss",
    {
      description:
        "Profit & Loss report for a bounded date range. Returns Xero-computed report rows for AI analysis.",
      inputSchema: {
        fromDate: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        toDate: zf.string().optional().describe("ISO date YYYY-MM-DD."),
        periods: zf
          .number()
          .int()
          .min(1)
          .max(11)
          .optional()
          .describe("Optional comparative periods for Xero report columns."),
        timeframe: zf
          .string()
          .optional()
          .describe('Comparison size: "MONTH", "QUARTER", or "YEAR".'),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.profitAndLoss(client, {
          fromDate: xeroArgs.fromDate as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_balance_sheet",
    {
      description: "Balance Sheet report as at a date. Live Xero report data only.",
      inputSchema: {
        date: zf.string().optional().describe("ISO date YYYY-MM-DD."),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.balanceSheet(client, { date: xeroArgs.date as string | undefined }),
        args,
      ),
  );

  server.registerTool(
    "xero_aged_receivables",
    {
      description: "Aged receivables or payables report for debtor/creditor position.",
      inputSchema: {
        reportType: zf.string().optional().describe('"payables" for aged payables, otherwise receivables.'),
        date: zf.string().optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.agedReceivables(client, {
          reportType: xeroArgs.reportType as string | undefined,
          date: xeroArgs.date as string | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_sales_summary",
    {
      description:
        "Summarise qualifying ACCREC sales for a date range, net of sales credit notes. Excludes ACCPAY purchase bills and voided/deleted documents. Returns currencyCode and transaction breakdown.",
      inputSchema: {
        fromDate: zf.string().min(1).describe("ISO date YYYY-MM-DD."),
        toDate: zf.string().min(1).describe("ISO date YYYY-MM-DD."),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.salesSummary(client, {
          fromDate: String(xeroArgs.fromDate),
          toDate: String(xeroArgs.toDate),
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_top_customers",
    {
      description:
        "Top customers by qualifying ACCREC sales revenue for a date range. Purchase-side documents are excluded. Returns currencyCode (e.g. GBP).",
      inputSchema: {
        fromDate: zf.string().optional(),
        toDate: zf.string().optional(),
        limit: zf.number().int().min(1).max(20).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.topCustomers(client, {
          fromDate: xeroArgs.fromDate as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );
}
