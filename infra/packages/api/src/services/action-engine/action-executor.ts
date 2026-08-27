/**
 * Action execution orchestrator — real provider path via Company MCP.
 * Production mutation gated by FINANCIAL_WRITES_ENABLED (must remain false until operator approval).
 */

import type { ActionPlanRecord } from "@infra/shared";
import { xeroActionDefinition } from "@infra/shared";
import type { Env } from "../../env";
import { recordAuditEvent } from "../control-plane";
import { recordUsageEvent } from "../usage";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import { updateActionPlanStatus } from "./action-engine";
import { runActionPreflight } from "./action-preflight";
import {
  claimExecution,
  finalizeExecution,
  getExecutionByPlanId,
} from "./execution-store";
import { executeXeroDraftInvoiceViaCompanyMcp } from "./company-mcp-xero-write";
import {
  draftInvoiceExpectedFromTarget,
  verifyCreatedDraftInvoice,
} from "./xero-write-verification";

export type ExecutionOutcome =
  | {
      ok: true;
      status: "completed";
      executionId: string;
      xeroResourceId: string | null;
      humanReference: string | null;
      verificationStatus: "verified";
      results: Record<string, unknown>;
    }
  | {
      ok: false;
      status: "failed" | "partial_failure" | "execution_uncertain" | "blocked";
      executionId?: string;
      error: string;
      code?: string;
      results?: Record<string, unknown>;
    };

export async function executeApprovedActionPlan(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    correlationId?: string | null;
  },
): Promise<ExecutionOutcome> {
  if (!FINANCIAL_WRITES_ENABLED) {
    return {
      ok: false,
      status: "blocked",
      error: "Financial writes are disabled in production.",
      code: "FINANCIAL_WRITES_DISABLED",
    };
  }

  const { plan, actor } = input;

  const preflight = await runActionPreflight(env, { plan, actor, requireApproved: true });
  if (!preflight.ok) {
    return {
      ok: false,
      status: "failed",
      error: preflight.message,
      code: preflight.code,
    };
  }

  const claim = await claimExecution(env.DB, {
    planId: plan.id,
    companyId: plan.companyId,
    requestedAction: plan.requestedAction,
    provider: plan.provider,
  });

  if (!claim.ok) {
    return { ok: false, status: "failed", error: claim.message, code: claim.code };
  }

  if (!claim.claimed) {
    const existing = claim.execution;
    if (existing.status === "succeeded") {
      return {
        ok: true,
        status: "completed",
        executionId: existing.id,
        xeroResourceId: existing.xeroResourceId,
        humanReference: existing.humanReference,
        verificationStatus: "verified",
        results: existing.resultJson ?? {},
      };
    }
    return {
      ok: false,
      status: existing.status === "uncertain" ? "execution_uncertain" : "failed",
      executionId: existing.id,
      error: `Execution already recorded: ${claim.reason}`,
      code: claim.reason,
      results: existing.resultJson ?? undefined,
    };
  }

  const execution = claim.execution;
  const def = xeroActionDefinition(plan.requestedAction);

  await recordAuditEvent(env.DB, {
    companyId: plan.companyId,
    eventType: "action_plan.execution_started",
    actor,
    resourceType: "action_execution",
    resourceId: execution.id,
    detail: { planId: plan.id, action: plan.requestedAction },
  });

  await updateActionPlanStatus(env.DB, {
    planId: plan.id,
    companyId: plan.companyId,
    status: "executing",
    actor,
    detail: { executionId: execution.id },
  });

  try {
    const { isBatchPlan } = await import("./batch-executor");
    if (isBatchPlan(plan)) {
      const { executeBatchActionPlan } = await import("./batch-runner");
      return executeBatchActionPlan(env, {
        plan: input.plan,
        actor: input.actor,
        executionId: execution.id,
      });
    }
    const { executeXeroActionPlan } = await import("./xero-write-executors");
    return executeXeroActionPlan(env, {
      plan: input.plan,
      actor: input.actor,
      executionId: execution.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeExecution(env.DB, {
      executionId: execution.id,
      companyId: plan.companyId,
      status: "uncertain",
      verificationStatus: "uncertain",
      errorCode: "EXECUTION_EXCEPTION",
      errorMessage: message,
    });
    await updateActionPlanStatus(env.DB, {
      planId: plan.id,
      companyId: plan.companyId,
      status: "execution_uncertain",
      actor,
      detail: { error: message },
    });
    await recordAuditEvent(env.DB, {
      companyId: plan.companyId,
      eventType: "action_plan.execution_uncertain",
      actor,
      resourceType: "action_execution",
      resourceId: execution.id,
      detail: { planId: plan.id, error: message },
    });
    return {
      ok: false,
      status: "execution_uncertain",
      executionId: execution.id,
      error: message,
      code: "EXECUTION_EXCEPTION",
    };
  }
}

async function executeDraftInvoicePlan(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    executionId: string;
    def: ReturnType<typeof xeroActionDefinition>;
    correlationId?: string | null;
  },
): Promise<ExecutionOutcome> {
  const writeResult = await executeXeroDraftInvoiceViaCompanyMcp(env, {
    plan: input.plan,
    executionId: input.executionId,
    actor: input.actor,
  });

  if (!writeResult.ok) {
    await finalizeExecution(env.DB, {
      executionId: input.executionId,
      companyId: input.plan.companyId,
      status: "failed",
      verificationStatus: "verification_failed",
      errorCode: writeResult.code,
      errorMessage: writeResult.message,
      resultJson: { providerError: writeResult.message },
    });
    await updateActionPlanStatus(env.DB, {
      planId: input.plan.id,
      companyId: input.plan.companyId,
      status: "failed",
      actor: input.actor,
      detail: { code: writeResult.code },
    });
    await recordAuditEvent(env.DB, {
      companyId: input.plan.companyId,
      eventType: input.def?.auditEvent ?? "action_plan.execution_failed",
      actor: input.actor,
      resourceType: "action_execution",
      resourceId: input.executionId,
      detail: { planId: input.plan.id, code: writeResult.code },
    });
    return {
      ok: false,
      status: "failed",
      executionId: input.executionId,
      error: writeResult.message,
      code: writeResult.code,
    };
  }

  const target = input.plan.targets[0];
  const expected = target ? draftInvoiceExpectedFromTarget(target) : null;
  const invoiceId = writeResult.invoiceId;

  if (!invoiceId || !expected || !input.plan.connectorInstanceId) {
    await finalizeExecution(env.DB, {
      executionId: input.executionId,
      companyId: input.plan.companyId,
      status: "uncertain",
      verificationStatus: "uncertain",
      xeroResourceId: invoiceId,
      humanReference: writeResult.invoiceNumber,
      resultJson: writeResult.result,
      errorCode: "VERIFICATION_INCOMPLETE",
      errorMessage: "Provider responded but invoice id missing for verification.",
    });
    await updateActionPlanStatus(env.DB, {
      planId: input.plan.id,
      companyId: input.plan.companyId,
      status: "execution_uncertain",
      actor: input.actor,
    });
    await recordAuditEvent(env.DB, {
      companyId: input.plan.companyId,
      eventType: "action_plan.execution_uncertain",
      actor: input.actor,
      resourceType: "action_execution",
      resourceId: input.executionId,
      detail: { planId: input.plan.id, reason: "missing_invoice_id" },
    });
    return {
      ok: false,
      status: "execution_uncertain",
      executionId: input.executionId,
      error: "Xero may have created a record but verification could not complete.",
      code: "VERIFICATION_INCOMPLETE",
      results: writeResult.result,
    };
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
    await finalizeExecution(env.DB, {
      executionId: input.executionId,
      companyId: input.plan.companyId,
      status: "uncertain",
      verificationStatus: "verification_failed",
      xeroResourceId: invoiceId,
      humanReference: writeResult.invoiceNumber,
      amount: expected.total,
      resultJson: { writeResult: writeResult.result, verification: verified.message },
      errorCode: verified.code,
      errorMessage: verified.message,
    });
    await updateActionPlanStatus(env.DB, {
      planId: input.plan.id,
      companyId: input.plan.companyId,
      status: "execution_uncertain",
      actor: input.actor,
      detail: { verificationCode: verified.code },
    });
    await recordAuditEvent(env.DB, {
      companyId: input.plan.companyId,
      eventType: "action_plan.verification_failed",
      actor: input.actor,
      resourceType: "action_execution",
      resourceId: input.executionId,
      detail: { planId: input.plan.id, code: verified.code, xeroInvoiceId: invoiceId },
    });
    return {
      ok: false,
      status: "execution_uncertain",
      executionId: input.executionId,
      error: verified.message,
      code: verified.code,
      results: writeResult.result,
    };
  }

  const invoice = verified.invoice;
  const total = Number(invoice.Total ?? expected.total);
  const currency = invoice.CurrencyCode ? String(invoice.CurrencyCode) : null;

  await finalizeExecution(env.DB, {
    executionId: input.executionId,
    companyId: input.plan.companyId,
    status: "succeeded",
    verificationStatus: "verified",
    xeroResourceId: invoiceId,
    humanReference: writeResult.invoiceNumber ?? (invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null),
    amount: total,
    currencyCode: currency,
    resultJson: {
      xeroInvoiceId: invoiceId,
      invoiceNumber: writeResult.invoiceNumber ?? invoice.InvoiceNumber ?? null,
      status: invoice.Status ?? null,
      type: invoice.Type ?? null,
      total,
      currencyCode: currency,
    },
  });

  await updateActionPlanStatus(env.DB, {
    planId: input.plan.id,
    companyId: input.plan.companyId,
    status: "completed",
    actor: input.actor,
    detail: { xeroInvoiceId: invoiceId, executionId: input.executionId },
  });

  if (input.def?.billingOperation) {
    await recordUsageEvent(env.DB, {
      companyId: input.plan.companyId,
      action: input.def.billingOperation,
      actorEmail: input.actor,
      resourceType: "action_execution",
      resourceId: input.executionId,
      connectorInstanceId: input.plan.connectorInstanceId,
      riskClass: input.plan.riskClass,
      success: true,
      correlationId: input.correlationId ?? input.plan.correlationId ?? null,
      interactionId: input.plan.interactionId ?? null,
      requestId: `aex_${input.executionId}`,
      sourceClient: input.plan.sourceClient ?? "action-engine",
      metadata: {
        planId: input.plan.id,
        executionId: input.executionId,
        xeroInvoiceId: invoiceId,
      },
    });
  }

  await recordAuditEvent(env.DB, {
    companyId: input.plan.companyId,
    eventType: input.def?.auditEvent ?? "action_plan.completed",
    actor: input.actor,
    resourceType: "action_execution",
    resourceId: input.executionId,
    detail: {
      planId: input.plan.id,
      xeroInvoiceId: invoiceId,
      invoiceNumber: writeResult.invoiceNumber ?? null,
      verificationStatus: "verified",
    },
  });

  return {
    ok: true,
    status: "completed",
    executionId: input.executionId,
    xeroResourceId: invoiceId,
    humanReference: writeResult.invoiceNumber,
    verificationStatus: "verified",
    results: {
      xeroInvoiceId: invoiceId,
      invoiceNumber: writeResult.invoiceNumber,
      status: "DRAFT",
      type: "ACCREC",
      total,
      currencyCode: currency,
    },
  };
}

export async function getExecutionEvidence(
  env: Env,
  companyId: string,
  planId: string,
) {
  return getExecutionByPlanId(env.DB, companyId, planId);
}
