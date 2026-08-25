import { XeroApiError, XeroClient, xeroReadTools } from "@infra/xero-core";

export type CaddingtonMcpEnv = {
  MCP_AUTH_TOKEN?: string;
  INFRA_API_URL?: string;
  INFRA_MCP_ENVIRONMENT_ID?: string;
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

const DEFAULT_INFRA_API = "https://infra-api.daniel-dwyer123.workers.dev";
const DEFAULT_MCP_ID = "mcp_caddington_primary";

export async function fetchInfraXeroContext(env: CaddingtonMcpEnv): Promise<
  | { ok: true; context: InfraXeroContext }
  | { ok: false; code: string; message: string; status: number }
> {
  const base = (env.INFRA_API_URL ?? DEFAULT_INFRA_API).replace(/\/$/, "");
  const mcpId = env.INFRA_MCP_ENVIRONMENT_ID ?? DEFAULT_MCP_ID;
  const token = env.MCP_AUTH_TOKEN;
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
  run: (client: XeroClient, context: InfraXeroContext) => Promise<T>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = await fetchInfraXeroContext(env);
  if (!resolved.ok) {
    return toolError(resolved.message, resolved.code);
  }
  const client = new XeroClient({
    accessToken: resolved.context.accessToken,
    tenantId: resolved.context.tenantId,
    apiBaseUrl: resolved.context.apiBaseUrl,
  });
  try {
    const result = await run(client, resolved.context);
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
    async () => withXeroClient(env, (client) => xeroReadTools.getOrganisation(client)),
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
      withXeroClient(env, (client) =>
        xeroReadTools.listContacts(client, {
          query: args.query as string | undefined,
          contactType: args.contactType as string | undefined,
          limit: args.limit as number | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.getContact(client, { contactId: String(args.contactId) }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.searchInvoices(client, {
          query: args.query as string | undefined,
          status: args.status as string | undefined,
          contactId: args.contactId as string | undefined,
          overdueOnly: args.overdueOnly as boolean | undefined,
          unpaidOnly: args.unpaidOnly as boolean | undefined,
          fromDate: args.fromDate as string | undefined,
          toDate: args.toDate as string | undefined,
          limit: args.limit as number | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.getInvoice(client, {
          invoiceId: args.invoiceId as string | undefined,
          invoiceNumber: args.invoiceNumber as string | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.listOverdueInvoices(client, {
          contactId: args.contactId as string | undefined,
          limit: args.limit as number | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.listPayments(client, {
          since: args.since as string | undefined,
          toDate: args.toDate as string | undefined,
          limit: args.limit as number | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.listAccounts(client, {
          accountType: args.accountType as string | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.listBankTransactions(client, {
          since: args.since as string | undefined,
          toDate: args.toDate as string | undefined,
          limit: args.limit as number | undefined,
        }),
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
      },
    },
    async (args) =>
      withXeroClient(env, (client) =>
        xeroReadTools.profitAndLoss(client, {
          fromDate: args.fromDate as string | undefined,
          toDate: args.toDate as string | undefined,
        }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.balanceSheet(client, { date: args.date as string | undefined }),
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
      withXeroClient(env, (client) =>
        xeroReadTools.agedReceivables(client, {
          reportType: args.reportType as string | undefined,
          date: args.date as string | undefined,
        }),
      ),
  );

  server.registerTool(
    "xero_sales_summary",
    {
      description:
        "Summarise sales/revenue from Xero invoices for a date range. Use for questions like 'sales last month'.",
      inputSchema: {
        fromDate: zf.string().min(1).describe("ISO date YYYY-MM-DD."),
        toDate: zf.string().min(1).describe("ISO date YYYY-MM-DD."),
      },
    },
    async (args) =>
      withXeroClient(env, (client) =>
        xeroReadTools.salesSummary(client, {
          fromDate: String(args.fromDate),
          toDate: String(args.toDate),
        }),
      ),
  );

  server.registerTool(
    "xero_top_customers",
    {
      description: "Top customers by invoice revenue for a date range.",
      inputSchema: {
        fromDate: zf.string().optional(),
        toDate: zf.string().optional(),
        limit: zf.number().int().min(1).max(20).optional(),
      },
    },
    async (args) =>
      withXeroClient(env, (client) =>
        xeroReadTools.topCustomers(client, {
          fromDate: args.fromDate as string | undefined,
          toDate: args.toDate as string | undefined,
          limit: args.limit as number | undefined,
        }),
      ),
  );
}
