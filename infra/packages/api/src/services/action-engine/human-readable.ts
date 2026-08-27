import type { ActionPlanRecord, ActionTarget } from "@infra/shared";
import type { ExecutionOutcome } from "./action-executor";

function contactNameFromTarget(target: ActionTarget | undefined): string | null {
  const proposed = target?.proposedState ?? {};
  const current = target?.currentState ?? {};
  return (
    (proposed.contactName ? String(proposed.contactName) : null) ??
    (current.contactName ? String(current.contactName) : null) ??
    target?.humanRef ??
    null
  );
}

function formatMoney(amount: number | null | undefined, currency = "GBP"): string {
  if (amount == null) return "unknown amount";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
}

export function humanReadablePlanPreview(plan: ActionPlanRecord): Record<string, unknown> {
  const target = plan.targets[0];
  const review = target?.proposedState ?? {};
  const current = target?.currentState ?? {};
  const customer = contactNameFromTarget(target);
  const amount = plan.financialImpact?.totalAmount ?? target?.amount ?? null;
  const currency = plan.financialImpact?.currencyCode ?? target?.currencyCode ?? "GBP";

  const base = {
    action: plan.requestedAction,
    company: plan.companyId,
    counterparty: customer,
    document: target?.humanRef ?? null,
    amount: amount != null ? formatMoney(amount, currency ?? "GBP") : null,
    vat: review.taxTreatment ?? review.taxTypeLabel ?? null,
    resultIfConfirmed: plan.summary,
    riskWarning: review.riskWarning ?? null,
    documentKind: review.documentKind ?? null,
  };

  if (plan.requestedAction === "xero.invoices.approve") {
    return {
      ...base,
      actionLabel: "Approve sales invoice",
      currentStatus: current.status ?? "DRAFT",
      resultingStatus: "AUTHORISED",
      confirmationPrompt: `Approve invoice ${target?.humanRef ?? ""} for ${formatMoney(amount, currency ?? "GBP")}${customer ? ` to ${customer}` : ""}?`,
    };
  }

  if (plan.requestedAction === "xero.invoices.send") {
    const email = review.destinationEmail ?? current.emailAddress ?? null;
    return {
      ...base,
      actionLabel: "Send sales invoice",
      destinationEmail: email,
      confirmationPrompt: email
        ? `Send invoice ${target?.humanRef ?? ""} for ${formatMoney(amount, currency ?? "GBP")} to ${email}?`
        : `Send invoice ${target?.humanRef ?? ""} — no destination email available.`,
    };
  }

  if (plan.requestedAction === "xero.bills.create") {
    return {
      ...base,
      actionLabel: "Create draft supplier bill",
      documentKind: "SUPPLIER BILL",
      confirmationPrompt: `Create draft supplier bill for ${formatMoney(amount, currency ?? "GBP")}${customer ? ` from ${customer}` : ""}?`,
    };
  }

  if (plan.requestedAction === "xero.bills.approve") {
    return {
      ...base,
      actionLabel: "Approve supplier bill",
      documentKind: "SUPPLIER BILL",
      currentStatus: current.status ?? "DRAFT",
      resultingStatus: "AUTHORISED",
      confirmationPrompt: `Approve supplier bill ${target?.humanRef ?? ""} — total liability ${formatMoney(amount, currency ?? "GBP")}?`,
    };
  }

  if (plan.requestedAction === "xero.credit_notes.create_draft") {
    return {
      ...base,
      actionLabel: "Create draft sales credit note",
      confirmationPrompt: `Create draft credit note for ${formatMoney(amount, currency ?? "GBP")}${customer ? ` to ${customer}` : ""}?`,
    };
  }

  if (plan.requestedAction === "xero.invoices.create_approve_send") {
    const steps = Array.isArray(review.workflowSteps) ? review.workflowSteps : [];
    return {
      ...base,
      actionLabel: "Create, approve, and send sales invoice",
      workflowSteps: steps,
      confirmationPrompt: `Create, approve, and send invoice for ${formatMoney(amount, currency ?? "GBP")}${customer ? ` to ${customer}` : ""}?`,
    };
  }

  return {
    ...base,
    actionLabel: plan.summary,
    confirmationPrompt: plan.summary,
  };
}

export function humanReadableExecutionSummary(
  plan: ActionPlanRecord,
  outcome: ExecutionOutcome,
): string {
  const target = plan.targets[0];
  const customer = contactNameFromTarget(target);
  const ref = outcome.ok && "humanReference" in outcome ? outcome.humanReference : target?.humanRef;
  const results = outcome.ok && "results" in outcome ? outcome.results : {};
  const total = results.total != null ? Number(results.total) : plan.financialImpact?.totalAmount;

  if (!outcome.ok) {
    const partial = results && typeof results === "object" && "partialSteps" in results
      ? (results as { partialSteps?: unknown[] }).partialSteps
      : null;
    if (Array.isArray(partial) && partial.length > 0) {
      return `Workflow incomplete. ${partial.map(String).join("; ")} Nothing further was attempted.`;
    }
    return `${plan.summary} — failed: ${"error" in outcome ? outcome.error : "unknown error"}. No further changes were made unless noted in diagnostics.`;
  }

  switch (plan.requestedAction) {
    case "xero.invoices.create":
      return `Draft invoice ${ref ?? "created"} for ${formatMoney(total)} was created successfully${customer ? ` for ${customer}` : ""}.`;
    case "xero.invoices.approve":
      return `Invoice ${ref ?? ""} was approved successfully. It has not been sent.`;
    case "xero.invoices.send":
      return `Invoice ${ref ?? ""} was sent successfully${results.sentTo ? ` to ${results.sentTo}` : ""}.`;
    case "xero.invoices.update":
      return `Draft invoice ${ref ?? ""} was updated successfully.`;
    case "xero.bills.create":
      return `Draft supplier bill ${ref ?? ""} for ${formatMoney(total)} was created successfully${customer ? ` from ${customer}` : ""}.`;
    case "xero.bills.approve":
      return `Supplier bill ${ref ?? ""} for ${formatMoney(total)} was approved successfully.`;
    case "xero.credit_notes.create_draft":
      return `Draft credit note ${ref ?? ""} for ${formatMoney(total)} was created successfully${customer ? ` for ${customer}` : ""}.`;
    case "xero.contacts.create":
      return `Contact "${customer ?? ref ?? "created"}" was created successfully in Xero.`;
    case "xero.invoices.create_approve_send":
      return `Invoice ${ref ?? ""} was created, approved, and sent successfully${customer ? ` for ${customer}` : ""}.`;
    default:
      return plan.summary ?? "Action completed successfully.";
  }
}
