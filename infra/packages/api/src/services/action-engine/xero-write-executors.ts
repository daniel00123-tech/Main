import type { ActionPlanRecord } from "@infra/shared";
import {
  betaGateForAction,
  isActionProductionEnabled,
  XERO_WRITE_PRODUCTION_GATES,
} from "@infra/shared";
import type { Env } from "../../env";
import type { ExecutionOutcome } from "./action-executor";
import { executeXeroMcpTool, executeXeroDraftInvoiceViaCompanyMcp } from "./company-mcp-xero-write";
import { draftInvoicePayloadFromProposedState } from "./draft-invoice-plan";
import { verifyCreatedDraftInvoice, draftInvoiceExpectedFromTarget } from "./xero-write-verification";
import { getValidXeroAccessToken } from "../xero";
import { XERO_AUTH } from "@infra/shared";
import { getInvoiceWithFetch } from "@infra/xero-core";
import { finalizeExecution } from "./execution-store";
import { updateActionPlanStatus } from "./action-engine";
import { recordAuditEvent } from "../control-plane";

export function checkBetaProductionGate(action: string): ExecutionOutcome | null {
  const gate = betaGateForAction(action);
  if (!gate) return null;
  if (!isActionProductionEnabled(gate, XERO_WRITE_PRODUCTION_GATES)) {
    return {
      ok: false,
      status: "blocked",
      error: `Action ${action} is implemented but not production-enabled.`,
      code: "BETA_GATE_BLOCKED",
    };
  }
  return null;
}

async function finalizeSuccess(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    executionId: string;
    resourceId: string | null;
    humanReference: string | null;
    results: Record<string, unknown>;
    auditEvent?: string;
  },
): Promise<ExecutionOutcome> {
  await finalizeExecution(env.DB, {
    executionId: input.executionId,
    companyId: input.plan.companyId,
    status: "succeeded",
    verificationStatus: "verified",
    xeroResourceId: input.resourceId,
    humanReference: input.humanReference,
    resultJson: input.results,
  });
  await updateActionPlanStatus(env.DB, {
    planId: input.plan.id,
    companyId: input.plan.companyId,
    status: "completed",
    actor: input.actor,
  });
  await recordAuditEvent(env.DB, {
    companyId: input.plan.companyId,
    eventType: input.auditEvent ?? "action_plan.completed",
    actor: input.actor,
    resourceType: "action_execution",
    resourceId: input.executionId,
    detail: { planId: input.plan.id, xeroResourceId: input.resourceId },
  });
  return {
    ok: true,
    status: "completed",
    executionId: input.executionId,
    xeroResourceId: input.resourceId,
    humanReference: input.humanReference,
    verificationStatus: "verified",
    results: input.results,
  };
}

async function finalizeFailure(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    executionId: string;
    code: string;
    message: string;
    results?: Record<string, unknown>;
  },
): Promise<ExecutionOutcome> {
  await finalizeExecution(env.DB, {
    executionId: input.executionId,
    companyId: input.plan.companyId,
    status: "failed",
    errorCode: input.code,
    errorMessage: input.message,
    resultJson: input.results,
  });
  await updateActionPlanStatus(env.DB, {
    planId: input.plan.id,
    companyId: input.plan.companyId,
    status: "failed",
    actor: input.actor,
  });
  return {
    ok: false,
    status: "failed",
    executionId: input.executionId,
    error: input.message,
    code: input.code,
    results: input.results,
  };
}

export async function executeXeroActionPlan(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const gateBlock = checkBetaProductionGate(input.plan.requestedAction);
  if (gateBlock) {
    await finalizeFailure(env, {
      ...input,
      code: gateBlock.code ?? "BETA_GATE_BLOCKED",
      message: gateBlock.error,
    });
    return gateBlock;
  }

  switch (input.plan.requestedAction) {
    case "xero.invoices.create":
      return executeDraftInvoice(env, input);
    case "xero.invoices.approve":
      return executeSimpleInvoiceMutation(env, input, "xero_approve_invoice", "AUTHORISED");
    case "xero.invoices.send":
      return executeSendInvoice(env, input);
    case "xero.bills.create":
      return executeDraftBill(env, input);
    case "xero.bills.approve":
      return executeSimpleBillMutation(env, input);
    case "xero.credit_notes.create_draft":
      return executeDraftCreditNote(env, input);
    case "xero.contacts.create":
      return executeCreateContact(env, input);
    case "xero.invoices.create_approve_send":
      return executeCombinedWorkflow(env, input);
    default:
      return {
        ok: false,
        status: "failed",
        error: `No executor for ${input.plan.requestedAction}`,
        code: "ACTION_NOT_EXECUTABLE",
      };
  }
}

async function executeDraftInvoice(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const writeResult = await executeXeroDraftInvoiceViaCompanyMcp(env, input);
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  const target = input.plan.targets[0];
  const expected = target ? draftInvoiceExpectedFromTarget(target) : null;
  const invoiceId = writeResult.invoiceId;
  if (!invoiceId || !expected || !input.plan.connectorInstanceId) {
    return finalizeFailure(env, {
      ...input,
      code: "VERIFICATION_INCOMPLETE",
      message: "Draft created but verification could not complete.",
      results: writeResult.result,
    });
  }
  const verified = await verifyCreatedDraftInvoice({
    env,
    companyId: input.plan.companyId,
    instanceId: input.plan.connectorInstanceId,
    actor: input.actor,
    invoiceId,
    expected,
  });
  if (!verified.ok) {
    return finalizeFailure(env, {
      ...input,
      code: verified.code,
      message: verified.message,
      results: writeResult.result,
    });
  }
  const total = Number(verified.invoice.Total ?? expected.total);
  return finalizeSuccess(env, {
    ...input,
    resourceId: invoiceId,
    humanReference: writeResult.invoiceNumber,
    results: {
      xeroInvoiceId: invoiceId,
      invoiceNumber: writeResult.invoiceNumber,
      status: "DRAFT",
      type: "ACCREC",
      total,
    },
  });
}

async function executeSimpleInvoiceMutation(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
  toolName: string,
  expectedStatus: string,
): Promise<ExecutionOutcome> {
  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const invoiceId = String(proposed.invoiceId ?? input.plan.targets[0]?.targetId ?? "");
  const writeResult = await executeXeroMcpTool(env, {
    ...input,
    toolName,
    arguments: { invoiceId },
  });
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  const verified = await verifyInvoiceStatus(env, input, invoiceId, expectedStatus, "ACCREC");
  if (!verified.ok) {
    return finalizeFailure(env, { ...input, code: verified.code, message: verified.message, results: writeResult.result });
  }
  return finalizeSuccess(env, {
    ...input,
    resourceId: invoiceId,
    humanReference: writeResult.humanReference ?? verified.invoiceNumber,
    results: {
      xeroInvoiceId: invoiceId,
      invoiceNumber: verified.invoiceNumber,
      status: expectedStatus,
      total: verified.total,
    },
  });
}

async function executeSendInvoice(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const invoiceId = String(proposed.invoiceId ?? input.plan.targets[0]?.targetId ?? "");
  const email = proposed.destinationEmail ? String(proposed.destinationEmail) : undefined;
  const writeResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_send_invoice",
    arguments: { invoiceId, emailAddress: email },
  });
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  return finalizeSuccess(env, {
    ...input,
    resourceId: invoiceId,
    humanReference: writeResult.humanReference,
    results: { xeroInvoiceId: invoiceId, sent: true, sentTo: email ?? null },
    auditEvent: "xero.external_send_executed",
  });
}

async function executeDraftBill(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const payload = draftInvoicePayloadFromProposedState(input.plan);
  const writeResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_create_draft_bill",
    arguments: payload,
  });
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  const billId = writeResult.resourceId ?? writeResult.invoiceId;
  if (!billId || !input.plan.connectorInstanceId) {
    return finalizeFailure(env, { ...input, code: "VERIFICATION_INCOMPLETE", message: "Bill created but unverified.", results: writeResult.result });
  }
  const verified = await verifyInvoiceStatus(env, input, billId, "DRAFT", "ACCPAY");
  if (!verified.ok) {
    return finalizeFailure(env, { ...input, code: verified.code, message: verified.message, results: writeResult.result });
  }
  return finalizeSuccess(env, {
    ...input,
    resourceId: billId,
    humanReference: writeResult.humanReference ?? verified.invoiceNumber,
    results: {
      xeroBillId: billId,
      invoiceNumber: verified.invoiceNumber,
      status: "DRAFT",
      type: "ACCPAY",
      total: verified.total,
      documentKind: "SUPPLIER BILL",
    },
  });
}

async function executeSimpleBillMutation(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  return executeSimpleInvoiceMutation(env, input, "xero_approve_bill", "AUTHORISED");
}

async function executeDraftCreditNote(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const writeResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_create_draft_credit_note",
    arguments: {
      contactId: proposed.contactId,
      lineItems: proposed.lineItems,
      reference: proposed.reference ?? undefined,
    },
  });
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  return finalizeSuccess(env, {
    ...input,
    resourceId: writeResult.resourceId ?? null,
    humanReference: writeResult.humanReference,
    results: { ...writeResult.result, status: "DRAFT" },
  });
}

async function executeCreateContact(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const writeResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_create_contact",
    arguments: {
      name: proposed.name,
      email: proposed.email ?? undefined,
      phone: proposed.phone ?? undefined,
      isCustomer: proposed.isCustomer ?? true,
      isSupplier: proposed.isSupplier ?? false,
    },
  });
  if (!writeResult.ok) {
    return finalizeFailure(env, { ...input, code: writeResult.code, message: writeResult.message });
  }
  return finalizeSuccess(env, {
    ...input,
    resourceId: writeResult.resourceId ?? null,
    humanReference: writeResult.humanReference,
    results: writeResult.result,
  });
}

async function executeCombinedWorkflow(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string; executionId: string },
): Promise<ExecutionOutcome> {
  const partialSteps: string[] = [];
  const draftResult = await executeDraftInvoice(env, input);
  if (!draftResult.ok || !("xeroResourceId" in draftResult) || !draftResult.xeroResourceId) {
    return {
      ...draftResult,
      results: { partialSteps: ["Draft creation: FAILED"], ...(draftResult.results ?? {}) },
    };
  }
  partialSteps.push(`Draft created: PASS (${draftResult.humanReference ?? draftResult.xeroResourceId})`);
  const invoiceId = draftResult.xeroResourceId;

  const approveResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_approve_invoice",
    arguments: { invoiceId },
  });
  if (!approveResult.ok) {
    partialSteps.push("Approval: FAILED");
    return finalizeFailure(env, {
      ...input,
      code: approveResult.code,
      message: `Draft created but approval failed: ${approveResult.message}`,
      results: { partialSteps, xeroInvoiceId: invoiceId, invoiceNumber: draftResult.humanReference, status: "DRAFT" },
    });
  }
  partialSteps.push("Approval: PASS");

  const proposed = input.plan.targets[0]?.proposedState ?? {};
  const email = proposed.destinationEmail ? String(proposed.destinationEmail) : undefined;
  const sendResult = await executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_send_invoice",
    arguments: { invoiceId, emailAddress: email },
  });
  if (!sendResult.ok) {
    partialSteps.push("Send: FAILED");
    return finalizeFailure(env, {
      ...input,
      code: sendResult.code,
      message: `Invoice ${draftResult.humanReference ?? invoiceId} was created and approved but was not sent: ${sendResult.message}`,
      results: {
        partialSteps,
        xeroInvoiceId: invoiceId,
        invoiceNumber: draftResult.humanReference,
        status: "AUTHORISED",
      },
    });
  }
  partialSteps.push("Send: PASS");
  return finalizeSuccess(env, {
    ...input,
    resourceId: invoiceId,
    humanReference: draftResult.humanReference,
    results: {
      xeroInvoiceId: invoiceId,
      invoiceNumber: draftResult.humanReference,
      status: "AUTHORISED",
      sent: true,
      sentTo: email ?? null,
      partialSteps,
    },
    auditEvent: "xero.external_send_executed",
  });
}

async function verifyInvoiceStatus(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string },
  invoiceId: string,
  expectedStatus: string,
  expectedType: string,
): Promise<
  | { ok: true; invoiceNumber: string | null; total: number | null }
  | { ok: false; code: string; message: string }
> {
  if (!input.plan.connectorInstanceId) {
    return { ok: false, code: "CONNECTOR_MISSING", message: "No connector instance." };
  }
  const token = await getValidXeroAccessToken({
    env,
    companyId: input.plan.companyId,
    instanceId: input.plan.connectorInstanceId,
    actor: input.actor,
    reason: "action_verify",
  });
  if (!token.ok) return { ok: false, code: "XERO_AUTH_FAILED", message: token.body.error };
  const fetched = await getInvoiceWithFetch(
    { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl },
    { invoiceId },
  );
  const invoice = fetched.invoice as Record<string, unknown> | null;
  if (!invoice) return { ok: false, code: "VERIFICATION_NOT_FOUND", message: "Invoice not found after execution." };
  if (String(invoice.Type ?? "") !== expectedType) {
    return { ok: false, code: "VERIFICATION_WRONG_TYPE", message: `Expected ${expectedType}, got ${invoice.Type}.` };
  }
  if (String(invoice.Status ?? "") !== expectedStatus) {
    return { ok: false, code: "VERIFICATION_WRONG_STATUS", message: `Expected ${expectedStatus}, got ${invoice.Status}.` };
  }
  return {
    ok: true,
    invoiceNumber: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null,
    total: invoice.Total != null ? Number(invoice.Total) : null,
  };
}
