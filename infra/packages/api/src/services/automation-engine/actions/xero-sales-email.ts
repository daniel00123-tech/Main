/**
 * Reusable month-to-date Xero sales email — read-only Xero + transactional email.
 */

import {
  XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
  automationRecipientEmailOf,
  formatCivilDateLong,
  formatClock,
  formatMajorCurrency,
  isValidRecipientEmail,
  monthToDateRangeInTimeZone,
  renderXeroSalesReportEmail,
} from "@infra/shared";
import type { Env } from "../../../env";
import { getCompanyById } from "../../control-plane";
import { sendTransactionalEmail } from "../../email/send-transactional";
import { portalOrigin } from "../../public-urls";
import { executeXeroReadToolOnInfra } from "../../xero-read-execution";
import { recordUsageEvent } from "../../usage";
import { AutomationActionError } from "./errors";
import type { AutomationActionResult, AutomationExecutionContext } from "./types";

const XERO_FAILURE_MESSAGE = "We couldn't retrieve Xero sales data.";
const EMAIL_FAILURE_MESSAGE = "We couldn't send the sales report email.";

function salesInvoiceCount(transactions: unknown): number {
  if (!Array.isArray(transactions)) return 0;
  return transactions.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const item = row as Record<string, unknown>;
    return (
      item.qualifiesForSales === true &&
      item.transactionType === "ACCREC" &&
      item.documentKind === "invoice"
    );
  }).length;
}

export async function executeXeroMonthToDateSalesEmail(
  env: Env,
  ctx: AutomationExecutionContext,
): Promise<AutomationActionResult> {
  const recipient = automationRecipientEmailOf(ctx.automation.configuration);
  if (!recipient || !isValidRecipientEmail(recipient)) {
    throw new AutomationActionError(
      "A valid recipient email is required.",
      false,
      "RECIPIENT_REQUIRED",
    );
  }

  const company = await getCompanyById(env.DB, ctx.companyId);
  if (!company) {
    throw new AutomationActionError("Company not found", false, "COMPANY_NOT_FOUND");
  }

  const timeZone = ctx.automation.timezone || "Europe/London";
  const range = monthToDateRangeInTimeZone(new Date(), timeZone);
  const xero = await executeXeroReadToolOnInfra(env, {
    companyId: ctx.companyId,
    toolName: "xero_sales_summary",
    arguments: { fromDate: range.fromDate, toDate: range.toDate },
    actor: `automation:${ctx.runId}`,
  });

  if (!xero.ok) {
    throw new AutomationActionError(XERO_FAILURE_MESSAGE, false, "XERO_UNAVAILABLE", {
      handler: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
      companyId: ctx.companyId,
      fromDate: range.fromDate,
      toDate: range.toDate,
      xeroOk: false,
      emailSent: false,
      customerSummary: "Couldn't retrieve Xero sales data",
    });
  }

  await recordUsageEvent(env.DB, {
    companyId: ctx.companyId,
    actorEmail: ctx.initiatedBy ?? "system:automation-engine",
    resourceType: "connector",
    resourceId: ctx.automation.id,
    action: "xero.sales.summary",
    toolName: "xero_sales_summary",
    quantity: 1,
    unit: "request",
    success: true,
    durationMs: xero.latencyMs,
    sourceClient: "automation-engine",
    correlationId: `${ctx.runId}:xero`,
    requestId: `automation_xero_${ctx.runId}`,
    metadata: { fromDate: range.fromDate, toDate: range.toDate, readOnly: true },
  });

  const summary = (xero.result.summary ?? {}) as Record<string, unknown>;
  const totalSales = Number(summary.totalSales ?? 0);
  const currency = String(summary.currencyCode ?? xero.result.currencyCode ?? "GBP");
  const invoiceCount = salesInvoiceCount(xero.result.transactions);
  const salesLabel = formatMajorCurrency(totalSales, currency);
  const asOfLabel = `${formatClock(range.hour, range.minute)} on ${formatCivilDateLong(range.toDate)}`;
  const portalUrl = `${portalOrigin(env)}/portal/${company.slug}/automations`;
  const email = renderXeroSalesReportEmail({
    companyDisplayName: company.name,
    fromDateLabel: formatCivilDateLong(range.fromDate),
    toDateLabel: formatCivilDateLong(range.toDate),
    salesLabel,
    invoiceCount,
    asOfLabel,
    portalUrl,
  });

  const report = {
    handler: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
    templateKey: XERO_MONTH_TO_DATE_SALES_EMAIL_TEMPLATE,
    companyId: ctx.companyId,
    fromDate: range.fromDate,
    toDate: range.toDate,
    totalSales,
    currencyCode: currency,
    salesInvoiceCount: invoiceCount,
    recipientEmail: recipient,
    xeroOk: true,
    emailSent: false,
    customerSummary: "Sales report generated",
  };

  const delivery = await sendTransactionalEmail(env, env.DB, {
    companyId: ctx.companyId,
    type: "XERO_SALES_REPORT",
    recipient,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
    actor: `automation:${ctx.runId}`,
  });

  if (!delivery.sent) {
    throw new AutomationActionError(EMAIL_FAILURE_MESSAGE, false, "EMAIL_DELIVERY_FAILED", {
      ...report,
      emailId: delivery.id,
      emailError: delivery.error,
      customerSummary: "Sales report generated, email not sent",
    });
  }

  return {
    summary: "Sales report sent",
    result: {
      ...report,
      emailSent: true,
      emailId: delivery.id,
      customerSummary: "Sales report sent",
    },
  };
}
