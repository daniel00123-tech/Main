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
        "Search Elvex Xero sales invoices. Use for outstanding/overdue invoices, invoice numbers, customer invoices, or date-range sales documents.",
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
      description: "Get one Elvex Xero invoice or bill by InvoiceID, including line items.",
      inputSchema: { invoice_id: z.string() },
    },
    async ({ invoice_id }) => {
      try {
        const ctx = await createXeroContext(env);
        return jsonTool({ organisation: ctx.organisationName, invoice: await getInvoice(ctx.client, invoice_id) });
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
        "Elvex management snapshot: month-to-date sales vs last month, top customers/suppliers, outstanding invoices/bills, P&L and bank summary. Use for 'how much have we sold' or 'current bank position'.",
    },
    async () => {
      try {
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
        "Fetch an Elvex Xero report: profitandloss, balancesheet, trialbalance, banksummary, executivesummary, agedreceivables, agedpayables. Also returns organisation/settings when report=organisation.",
      inputSchema: {
        report: z.string().describe("profitandloss | balancesheet | trialbalance | banksummary | executivesummary | agedreceivables | agedpayables | organisation | settings"),
        from: z.string().optional(),
        to: z.string().optional(),
        date: z.string().optional(),
        periods: z.number().int().min(1).max(12).optional(),
      },
    },
    async (input) => {
      try {
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
        "Analyse Elvex invoiced sales: month-to-date, previous month, month-on-month change, rolling period, largest invoices. Credit notes are subtracted; drafts/voids excluded.",
      inputSchema: { months: z.number().int().min(1).max(12).optional() },
    },
    async ({ months }) => {
      try {
        const ctx = await createXeroContext(env);
        return jsonTool({ organisation: ctx.organisationName, ...(await analyseSales(ctx.client, months ?? 6)) });
      } catch (error) {
        return jsonTool(toolErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "analyse_xero_customers",
    {
      description:
        "Rank Elvex customers by spend over a period and show outstanding debt. Use for biggest customers or how much customer X spent.",
      inputSchema: {
        months: z.number().int().min(1).max(12).optional(),
        top: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ months, top }) => {
      try {
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
