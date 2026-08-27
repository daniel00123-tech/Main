import {
  XeroApiError,
  XeroClient,
  xeroReadTools,
  createDraftInvoiceWithFetch,
  approveInvoiceWithFetch,
  sendInvoiceWithFetch,
  createDraftBillWithFetch,
  approveBillWithFetch,
  createDraftCreditNoteWithFetch,
  createContactWithFetch,
  updateDraftInvoiceWithFetch,
  approveCreditNoteWithFetch,
  voidInvoiceWithFetch,
  voidCreditNoteWithFetch,
} from "@infra/xero-core";

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
  object: (shape: Record<string, unknown>) => unknown;
  array: (schema: unknown) => { min: (n: number) => unknown };
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
        "Search Xero invoices with optional status, customer, overdue/unpaid filters, invoice type (ACCREC/ACCPAY/ALL), and date range. Returns formatted invoice summaries. Live data only.",
      inputSchema: {
        query: zf.string().optional().describe("Invoice number contains."),
        status: zf.string().optional(),
        contactId: zf.string().optional(),
        overdueOnly: zf.boolean().optional(),
        unpaidOnly: zf.boolean().optional(),
        invoiceType: zf
          .string()
          .optional()
          .describe('Document type filter: "ACCREC", "ACCPAY", or "ALL" (default).'),
        effectiveDate: zf
          .string()
          .optional()
          .describe("As-at date for overdue calculations (YYYY-MM-DD). Defaults to today."),
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
          invoiceType: xeroArgs.invoiceType as string | undefined,
          effectiveDate: xeroArgs.effectiveDate as string | undefined,
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
      description:
        "List overdue ACCREC sales invoices (AmountDue > 0, due date strictly before effective date), sorted by days overdue. Live data only.",
      inputSchema: {
        contactId: zf.string().optional(),
        effectiveDate: zf
          .string()
          .optional()
          .describe("As-at date for overdue calculation (YYYY-MM-DD). Defaults to today."),
        limit: zf.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.listOverdueInvoices(client, {
          contactId: xeroArgs.contactId as string | undefined,
          effectiveDate: xeroArgs.effectiveDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_payments",
    {
      description:
        "List Xero payments in an inclusive date range with optional direction filter (customer_receipt, supplier_payment, or all). Live data only.",
      inputSchema: {
        since: zf.string().optional().describe("ISO date YYYY-MM-DD (inclusive start)."),
        toDate: zf.string().optional().describe("ISO date YYYY-MM-DD (inclusive end)."),
        direction: zf
          .string()
          .optional()
          .describe('"customer_receipt", "supplier_payment", or "all" (default).'),
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
          direction: xeroArgs.direction as string | undefined,
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
      description:
        "Computed aged receivables or payables from outstanding invoice balances (not the Xero AgedReceivablesByContact report).",
      inputSchema: {
        reportType: zf
          .string()
          .optional()
          .describe('"payables" for supplier bills, otherwise receivables.'),
        date: zf.string().optional().describe("Effective/as-at date (YYYY-MM-DD)."),
        contactId: zf.string().optional().describe("Optional contact filter."),
      },
    },
    async (args) =>
      withXeroClient(
        env,
        (client, _context, xeroArgs) =>
        xeroReadTools.agedReceivables(client, {
          reportType: xeroArgs.reportType as string | undefined,
          date: xeroArgs.date as string | undefined,
          contactId: xeroArgs.contactId as string | undefined,
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

  server.registerTool(
    "xero_top_suppliers",
    {
      description:
        "Top suppliers by qualifying ACCPAY bill spend for a date range. Sales invoices are excluded. Returns currencyCode.",
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
        xeroReadTools.topSuppliers(client, {
          fromDate: xeroArgs.fromDate as string | undefined,
          toDate: xeroArgs.toDate as string | undefined,
          limit: xeroArgs.limit as number | undefined,
        }),
        args,
      ),
  );

  server.registerTool(
    "xero_list_tax_rates",
    {
      description:
        "List active Xero tax rates for this organisation with VAT capability metadata. Live data only.",
    },
    async (args) =>
      withXeroClient(env, (client) => xeroReadTools.listTaxRates(client), args),
  );

  server.registerTool(
    "xero_vat_capability",
    {
      description:
        "Report what VAT/tax analysis INFRA can and cannot do via the Xero API (transaction-level tax vs official filed return).",
    },
    async (args) =>
      withXeroClient(env, (client) => xeroReadTools.vatCapability(client), args),
  );
}

/** Write tools — callable only via INFRA Action Engine (hidden from ChatGPT tools/list). */
export function registerXeroWriteTools(server: McpToolServer, env: CaddingtonMcpEnv, z: ZodLike) {
  const zf: ZodField = z;

  async function runWriteTool<T>(
    args: Record<string, unknown>,
    run: (config: { accessToken: string; tenantId: string; apiBaseUrl: string }, xeroArgs: Record<string, unknown>) => Promise<T>,
  ) {
    const injected =
      injectedContextFromArgs(args) ?? (env.__infraXeroContext ? env.__infraXeroContext : null);
    const resolved = injected ? { ok: true as const, context: injected } : await fetchInfraXeroContext(env);
    if (!resolved.ok) return toolError(resolved.message, resolved.code);
    const xeroArgs = stripInternalArgs(args);
    const config = {
      accessToken: resolved.context.accessToken,
      tenantId: resolved.context.tenantId,
      apiBaseUrl: resolved.context.apiBaseUrl,
      fetchImpl: fetch,
    };
    try {
      const result = await run(config, xeroArgs);
      return toolSuccess({ organisationName: resolved.context.organisationName, ...result });
    } catch (error) {
      if (error instanceof XeroApiError) return toolError(error.provider.message, error.provider.code);
      return toolError(error instanceof Error ? error.message : String(error), "XERO_EXECUTION_FAILED");
    }
  }

  server.registerTool(
    "xero_create_draft_invoice",
    {
      description: "Create a draft ACCREC sales invoice in Xero. Action Engine only.",
      inputSchema: {
        contactId: zf.string().min(1),
        lineItems: zf.array(zf.object({
          description: zf.string(), quantity: zf.number(), unitAmount: zf.number(),
          accountCode: zf.string().optional(), taxType: zf.string().optional(),
        })).min(1),
        reference: zf.string().optional(),
        date: zf.string().optional(),
        dueDate: zf.string().optional(),
      },
    },
    async (args) =>
      runWriteTool(args, (config, xeroArgs) =>
        createDraftInvoiceWithFetch(config, {
          contactId: String(xeroArgs.contactId),
          lineItems: xeroArgs.lineItems as never,
          reference: xeroArgs.reference as string | undefined,
          date: xeroArgs.date as string | undefined,
          dueDate: xeroArgs.dueDate as string | undefined,
        }),
      ),
  );

  server.registerTool(
    "xero_approve_invoice",
    {
      description: "Approve/authorise a DRAFT ACCREC sales invoice. Action Engine only.",
      inputSchema: { invoiceId: zf.string().min(1) },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      approveInvoiceWithFetch(config, { invoiceId: String(xeroArgs.invoiceId) })),
  );

  server.registerTool(
    "xero_send_invoice",
    {
      description: "Send an authorised sales invoice via Xero email. Action Engine only.",
      inputSchema: {
        invoiceId: zf.string().min(1),
        emailAddress: zf.string().optional(),
      },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      sendInvoiceWithFetch(config, {
        invoiceId: String(xeroArgs.invoiceId),
        emailAddress: xeroArgs.emailAddress as string | undefined,
      })),
  );

  server.registerTool(
    "xero_create_draft_bill",
    {
      description: "Create a draft ACCPAY supplier bill in Xero. Action Engine only.",
      inputSchema: {
        contactId: zf.string().min(1),
        lineItems: zf.array(zf.object({
          description: zf.string(), quantity: zf.number(), unitAmount: zf.number(),
          accountCode: zf.string().optional(), taxType: zf.string().optional(),
        })).min(1),
        reference: zf.string().optional(),
        date: zf.string().optional(),
        dueDate: zf.string().optional(),
      },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      createDraftBillWithFetch(config, {
        contactId: String(xeroArgs.contactId),
        lineItems: xeroArgs.lineItems as never,
        reference: xeroArgs.reference as string | undefined,
        date: xeroArgs.date as string | undefined,
        dueDate: xeroArgs.dueDate as string | undefined,
      })),
  );

  server.registerTool(
    "xero_approve_bill",
    {
      description: "Approve/authorise a DRAFT ACCPAY supplier bill. Action Engine only.",
      inputSchema: { invoiceId: zf.string().min(1) },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      approveBillWithFetch(config, { invoiceId: String(xeroArgs.invoiceId) })),
  );

  server.registerTool(
    "xero_create_draft_credit_note",
    {
      description: "Create a draft ACCREC credit note in Xero. Action Engine only.",
      inputSchema: {
        contactId: zf.string().min(1),
        lineItems: zf.array(zf.object({
          description: zf.string(), quantity: zf.number(), unitAmount: zf.number(),
          accountCode: zf.string().optional(), taxType: zf.string().optional(),
        })).min(1),
        reference: zf.string().optional(),
      },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      createDraftCreditNoteWithFetch(config, {
        contactId: String(xeroArgs.contactId),
        lineItems: xeroArgs.lineItems as never,
        reference: xeroArgs.reference as string | undefined,
      })),
  );

  server.registerTool(
    "xero_create_contact",
    {
      description: "Create a Xero contact. Action Engine only.",
      inputSchema: {
        name: zf.string().min(1),
        email: zf.string().optional(),
        phone: zf.string().optional(),
        isCustomer: zf.boolean().optional(),
        isSupplier: zf.boolean().optional(),
      },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      createContactWithFetch(config, {
        name: String(xeroArgs.name),
        email: xeroArgs.email as string | undefined,
        phone: xeroArgs.phone as string | undefined,
        isCustomer: xeroArgs.isCustomer as boolean | undefined,
        isSupplier: xeroArgs.isSupplier as boolean | undefined,
      })),
  );

  server.registerTool(
    "xero_update_draft_invoice",
    {
      description: "Update a DRAFT invoice or bill in Xero. Action Engine only.",
      inputSchema: {
        invoiceId: zf.string().min(1),
        type: zf.string().min(1),
        reference: zf.string().optional(),
        date: zf.string().optional(),
        dueDate: zf.string().optional(),
        lineItems: zf.array(zf.object({
          description: zf.string(), quantity: zf.number(), unitAmount: zf.number(),
          accountCode: zf.string().optional(), taxType: zf.string().optional(),
        })),
      },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      updateDraftInvoiceWithFetch(config, {
        invoiceId: String(xeroArgs.invoiceId),
        type: String(xeroArgs.type) === "ACCPAY" ? "ACCPAY" : "ACCREC",
        patch: {
          reference: xeroArgs.reference as string | undefined,
          date: xeroArgs.date as string | undefined,
          dueDate: xeroArgs.dueDate as string | undefined,
          lineItems: xeroArgs.lineItems as never,
        },
      })),
  );

  server.registerTool(
    "xero_approve_credit_note",
    {
      description: "Approve/authorise a DRAFT sales credit note. Action Engine only.",
      inputSchema: { creditNoteId: zf.string().min(1) },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      approveCreditNoteWithFetch(config, { creditNoteId: String(xeroArgs.creditNoteId) })),
  );

  server.registerTool(
    "xero_void_invoice",
    {
      description: "Void an invoice or supplier bill in Xero. Action Engine only.",
      inputSchema: { invoiceId: zf.string().min(1) },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      voidInvoiceWithFetch(config, { invoiceId: String(xeroArgs.invoiceId) })),
  );

  server.registerTool(
    "xero_void_credit_note",
    {
      description: "Void a credit note in Xero. Action Engine only.",
      inputSchema: { creditNoteId: zf.string().min(1) },
    },
    async (args) => runWriteTool(args, (config, xeroArgs) =>
      voidCreditNoteWithFetch(config, { creditNoteId: String(xeroArgs.creditNoteId) })),
  );
}
