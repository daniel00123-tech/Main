import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { createXeroContext, jsonTool } from "./context";
import { toolErrorPayload } from "./errors";
import {
  analyseCustomers,
  analyseSales,
  analyseSuppliers,
  createDraft,
  financialSummary,
  getContactHistory,
  getInvoice,
  getOrganisation,
  getReport,
  listSettings,
  searchContacts,
  searchInvoices,
} from "./service";
import { analyseCashReceived, analyseInvoiceActivity } from "./sales";
import { classifyXeroQuestion, recommendedXeroTool } from "./intent";
import { requireCapability, requireXeroTool } from "../rbac/guard";

const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().optional(),
  unitAmount: z.number(),
  accountCode: z.string().optional(),
});

export function registerXeroTools(server: McpServer, env: Env): void {
  server.registerTool(
    "search_xero_contacts",
    {
      description:
        "Search Elvex Xero customers and suppliers. Use for 'who is customer X', contact balances, or supplier lookup.",
      inputSchema: {
        query: z.string().optional().describe("Name fragment."),
        role: z.enum(["customer", "supplier", "all"]).optional(),
        contact_id: z.string().optional().describe("If set, return that contact and recent invoices."),
        top: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "search_xero_contacts", input);
        const ctx = await createXeroContext(env);
        if (input.contact_id) return jsonTool(await getContactHistory(ctx.client, input.contact_id));
        return jsonTool({
          organisation: ctx.organisationName,
          contacts: await searchContacts(ctx.client, { query: input.query, role: input.role, top: input.top }),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "search_xero_invoices",
    {
      description:
        "Search Elvex Xero sales invoice documents. Use for invoice numbers, a named customer's invoices, overdue invoices, or outstanding debtors. Outstanding AmountDue includes VAT. Do NOT use this for generic 'what are our sales/revenue' questions — use analyse_xero_sales (P&L revenue excluding VAT). For 'how much have we invoiced' use analyse_xero_invoice_activity.",
      inputSchema: {
        query: z.string().optional().describe("Invoice number, customer, or reference."),
        status: z.string().optional(),
        outstanding: z.boolean().optional(),
        overdue: z.boolean().optional(),
        contact: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        top: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "search_xero_invoices", input);
        const ctx = await createXeroContext(env);
        return jsonTool({
          organisation: ctx.organisationName,
          invoices: await searchInvoices(ctx.client, { type: "ACCREC", ...input }),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "get_xero_invoice",
    {
      description:
        "Get one Elvex Xero invoice or bill by InvoiceID, including line items. Total is including VAT; SubTotal is excluding VAT. Not a company-wide sales total.",
      inputSchema: { invoice_id: z.string() },
    },
    async ({ invoice_id }) => {
      try {
        await requireXeroTool(env, "get_xero_invoice", { invoice_id });
        const ctx = await createXeroContext(env);
        const invoice = await getInvoice(ctx.client, invoice_id);
        const type = String((invoice as { Type?: string; type?: string } | null)?.Type ?? (invoice as { type?: string } | null)?.type ?? "");
        if (type === "ACCPAY") {
          await requireCapability(env, "xero.finance.read", { xeroTool: "get_xero_invoice" });
        }
        return jsonTool({ organisation: ctx.organisationName, invoice });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "search_xero_bills",
    {
      description:
        "Search Elvex Xero supplier bills (ACCPAY). Use for bills due, overdue creditors, or spend by supplier.",
      inputSchema: {
        query: z.string().optional(),
        status: z.string().optional(),
        outstanding: z.boolean().optional(),
        overdue: z.boolean().optional(),
        contact: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        top: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "search_xero_bills", input);
        const ctx = await createXeroContext(env);
        return jsonTool({
          organisation: ctx.organisationName,
          bills: await searchInvoices(ctx.client, { type: "ACCPAY", ...input }),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "get_xero_financial_summary",
    {
      description:
        "Elvex management snapshot. Primary sales figure is P&L revenue excluding VAT. Also includes net invoice activity, cash received (includes VAT), outstanding receivables (includes VAT), P&L and bank. Use for a full pack — not as a substitute that mixes those metrics.",
    },
    async () => {
      try {
        await requireXeroTool(env, "get_xero_financial_summary");
        const ctx = await createXeroContext(env);
        return jsonTool(await financialSummary(ctx.client));
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "get_xero_report",
    {
      description:
        "Fetch an Elvex Xero report. profitandloss is the authoritative source for management sales/revenue and is exclusive of VAT. agedreceivables is outstanding customer debt and includes VAT. banksummary is cash movement, not sales.",
      inputSchema: {
        report: z.string().describe("profitandloss (sales/revenue ex VAT) | balancesheet | trialbalance | banksummary (cash) | executivesummary | agedreceivables (outstanding inc VAT) | agedpayables | organisation | settings"),
        from: z.string().optional(),
        to: z.string().optional(),
        date: z.string().optional(),
        periods: z.number().int().min(1).max(12).optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "get_xero_report", input);
        const ctx = await createXeroContext(env);
        const key = input.report.toLowerCase();
        if (key === "organisation") return jsonTool(await getOrganisation(ctx.client));
        if (key === "settings") return jsonTool(await listSettings(ctx.client));
        return jsonTool(await getReport(ctx.client, input));
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_sales",
    {
      description:
        "DEFAULT tool for 'What are our sales?', 'How much have we sold?', 'What was revenue?', or 'How are sales looking?'. Returns management/accounting revenue from the Xero Profit and Loss for the requested period, EXCLUDING VAT. Do not use invoice totals or divide by 1.2. Not for invoices raised, cash received, or outstanding debt.",
      inputSchema: {
        months: z.number().int().min(1).max(12).optional(),
        from: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to the first day of the current month."),
        to: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
        question: z.string().optional().describe("Original user question, used only to confirm this is a sales/revenue ask."),
      },
    },
    async ({ months, from, to, question }) => {
      try {
        await requireXeroTool(env, "analyse_xero_sales");
        const ctx = await createXeroContext(env);
        const routing = classifyXeroQuestion(question);
        if (question && routing.metric !== "sales_revenue") {
          return jsonTool({
            organisation: ctx.organisationName,
            wrongTool: true,
            metric: routing.metric,
            useTool: recommendedXeroTool(routing.metric),
            reason: routing.reason,
            note: "analyse_xero_sales is reserved for management sales/revenue excluding VAT.",
          });
        }
        return jsonTool({
          organisation: ctx.organisationName,
          ...(await analyseSales(ctx.client, months ?? 6, { from, to, question })),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_invoice_activity",
    {
      description:
        "Net invoices raised (posted sales invoices minus sales credit notes) by document date. Use for 'How much have we invoiced?', 'What invoices have we raised?', 'Net invoicing this month', or 'How many invoices/credit notes were raised?'. Returns both excluding-VAT (SubTotal) and including-VAT (Total). This is NOT management sales/revenue — use analyse_xero_sales for that.",
      inputSchema: {
        months: z.number().int().min(1).max(12).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ months, from, to }) => {
      try {
        await requireXeroTool(env, "analyse_xero_invoice_activity");
        const ctx = await createXeroContext(env);
        return jsonTool({
          organisation: ctx.organisationName,
          ...(await analyseInvoiceActivity(ctx.client, { months, from, to })),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_cash_received",
    {
      description:
        "Customer cash received (Xero ACCRECPAYMENT) in a period. Use for 'How much cash have we received?' or 'What receipts came in?'. Cash includes VAT where invoices were taxable. This is NOT sales/revenue and NOT invoices raised.",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ from, to }) => {
      try {
        await requireXeroTool(env, "analyse_xero_cash_received");
        const ctx = await createXeroContext(env);
        return jsonTool({
          organisation: ctx.organisationName,
          ...(await analyseCashReceived(ctx.client, { from, to })),
        });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_customers",
    {
      description:
        "Rank Elvex customers by invoiced spend (excluding VAT where SubTotal is present) and show outstanding debt. Outstanding debt includes VAT. Not the tool for company-wide sales/revenue.",
      inputSchema: {
        months: z.number().int().min(1).max(12).optional(),
        top: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ months, top }) => {
      try {
        await requireXeroTool(env, "analyse_xero_customers");
        const ctx = await createXeroContext(env);
        return jsonTool({ organisation: ctx.organisationName, ...(await analyseCustomers(ctx.client, months ?? 6, top ?? 8)) });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_suppliers",
    {
      description: "Rank Elvex suppliers by bill spend and outstanding creditors.",
      inputSchema: {
        months: z.number().int().min(1).max(12).optional(),
        top: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ months, top }) => {
      try {
        await requireXeroTool(env, "analyse_xero_suppliers");
        const ctx = await createXeroContext(env);
        return jsonTool({ organisation: ctx.organisationName, ...(await analyseSuppliers(ctx.client, months ?? 6, top ?? 8)) });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "create_xero_draft_invoice",
    {
      description:
        "Preview or create a DRAFT Elvex sales invoice. Defaults to dry_run. Set dry_run=false and confirm=true to create the draft. Never approves, sends, voids or records payment.",
      inputSchema: {
        contact: z.string(),
        line_items: z.array(lineItemSchema),
        date: z.string().optional(),
        due_date: z.string().optional(),
        reference: z.string().optional(),
        dry_run: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "create_xero_draft_invoice", input);
        const ctx = await createXeroContext(env);
        return jsonTool(
          await createDraft(ctx.client, {
            kind: "invoice",
            contact: input.contact,
            lineItems: input.line_items,
            date: input.date,
            dueDate: input.due_date,
            reference: input.reference,
            dryRun: input.dry_run,
            confirm: input.confirm,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "create_xero_quote",
    {
      description: "Preview or create a DRAFT Elvex Xero quote. Defaults to dry_run. Requires confirm=true to execute.",
      inputSchema: {
        contact: z.string(),
        line_items: z.array(lineItemSchema),
        date: z.string().optional(),
        expiry_date: z.string().optional(),
        reference: z.string().optional(),
        dry_run: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "create_xero_quote", input);
        const ctx = await createXeroContext(env);
        return jsonTool(
          await createDraft(ctx.client, {
            kind: "quote",
            contact: input.contact,
            lineItems: input.line_items,
            date: input.date,
            dueDate: input.expiry_date,
            reference: input.reference,
            dryRun: input.dry_run,
            confirm: input.confirm,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "create_xero_draft_bill",
    {
      description: "Preview or create a DRAFT Elvex supplier bill. Defaults to dry_run. Requires confirm=true to execute. Does not approve or pay.",
      inputSchema: {
        contact: z.string(),
        line_items: z.array(lineItemSchema),
        date: z.string().optional(),
        due_date: z.string().optional(),
        reference: z.string().optional(),
        dry_run: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "create_xero_draft_bill", input);
        const ctx = await createXeroContext(env);
        return jsonTool(
          await createDraft(ctx.client, {
            kind: "bill",
            contact: input.contact,
            lineItems: input.line_items,
            date: input.date,
            dueDate: input.due_date,
            reference: input.reference,
            dryRun: input.dry_run,
            confirm: input.confirm,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "create_xero_draft_credit_note",
    {
      description: "Preview or create a DRAFT Elvex sales credit note. Defaults to dry_run. Requires confirm=true to execute.",
      inputSchema: {
        contact: z.string(),
        line_items: z.array(lineItemSchema),
        date: z.string().optional(),
        reference: z.string().optional(),
        dry_run: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        await requireXeroTool(env, "create_xero_draft_credit_note", input);
        const ctx = await createXeroContext(env);
        return jsonTool(
          await createDraft(ctx.client, {
            kind: "credit_note",
            contact: input.contact,
            lineItems: input.line_items,
            date: input.date,
            reference: input.reference,
            dryRun: input.dry_run,
            confirm: input.confirm,
          })
        );
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );
}
