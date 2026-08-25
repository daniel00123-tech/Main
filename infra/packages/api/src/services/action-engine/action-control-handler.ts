import type { Env } from "../../env";
import type { GatewayActor } from "../gateway";
import {
  cancelActionPlan,
  confirmActionPlan,
  createActionPlan,
  getActionPlan,
  listActionPlans,
  isPlanStale,
  markPlanStale,
  fingerprintTargets,
} from "./action-engine";
import { evaluateActionPermission } from "./permission-engine";
import {
  planXeroCreditInvoices,
  planXeroDraftInvoice,
  planXeroRemittanceAllocation,
  resolveConnectedXeroInstance,
  revalidateXeroPlanTargets,
} from "./xero-planner";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import { xeroToolContract } from "../xero-tools";
import { missingScopesForTier, tierFromGrantedScopes } from "@infra/shared";

function actorLabel(actor: GatewayActor): string {
  return actor.type === "service" ? actor.identity.name : actor.user.email;
}

function grantedScopes(instance: { capabilitiesEnabled?: string[]; config?: Record<string, unknown> }) {
  if (Array.isArray(instance.capabilitiesEnabled) && instance.capabilitiesEnabled.length) {
    return instance.capabilitiesEnabled.map(String);
  }
  const fromConfig = instance.config?.grantedScopes;
  return Array.isArray(fromConfig) ? fromConfig.map(String) : [];
}

export async function executeActionControlTool(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor: GatewayActor;
    sourceClient: string;
    correlationId?: string;
    interactionId?: string;
  },
): Promise<{ status: 200 | 400 | 403 | 404 | 409; body: Record<string, unknown> }> {
  const actor = actorLabel(input.actor);

  if (input.toolName === "get_action_plan") {
    const planId = String(input.arguments.planId ?? "");
    const plan = await getActionPlan(env.DB, input.companyId, planId);
    if (!plan) return { status: 404, body: { error: "Action plan not found", code: "PLAN_NOT_FOUND" } };
    return { status: 200, body: sanitizePlanForClient(plan) };
  }

  if (input.toolName === "list_pending_actions") {
    const plans = await listActionPlans(env.DB, input.companyId, {
      limit: Number(input.arguments.limit ?? 20),
    });
    const pending = plans.filter((plan) =>
      ["awaiting_confirmation", "awaiting_approval", "validated", "approved"].includes(plan.status),
    );
    return {
      status: 200,
      body: {
        plans: pending.map(sanitizePlanForClient),
        writesEnabled: FINANCIAL_WRITES_ENABLED,
      },
    };
  }

  if (input.toolName === "cancel_action_plan") {
    const plan = await cancelActionPlan(env.DB, {
      companyId: input.companyId,
      planId: String(input.arguments.planId ?? ""),
      actor,
      reason: input.arguments.reason ? String(input.arguments.reason) : undefined,
    });
    if (!plan) return { status: 404, body: { error: "Action plan not found", code: "PLAN_NOT_FOUND" } };
    return { status: 200, body: sanitizePlanForClient(plan) };
  }

  if (input.toolName === "confirm_action_plan") {
    const planId = String(input.arguments.planId ?? "");
    const plan = await getActionPlan(env.DB, input.companyId, planId);
    if (!plan) return { status: 404, body: { error: "Action plan not found", code: "PLAN_NOT_FOUND" } };

    if (plan.connectorInstanceId && plan.provider === "xero") {
      try {
        const live = await revalidateXeroPlanTargets({
          env,
          companyId: input.companyId,
          instanceId: plan.connectorInstanceId,
          actor,
          requestedAction: plan.requestedAction,
          targets: plan.targets,
        });
        if (isPlanStale(plan, live.fingerprint)) {
          await markPlanStale(env.DB, { companyId: input.companyId, planId, actor });
          return {
            status: 409,
            body: {
              error: "Source state changed since plan was created. Regenerate the plan.",
              code: "PLAN_STALE",
              liveTargets: live.targets,
            },
          };
        }
      } catch {
        return {
          status: 503,
          body: { error: "Unable to revalidate plan against live Xero.", code: "REVALIDATION_FAILED" },
        };
      }
    }

    const result = await confirmActionPlan(env.DB, {
      companyId: input.companyId,
      planId,
      actor,
      confirmationToken: input.arguments.confirmationToken
        ? String(input.arguments.confirmationToken)
        : null,
    });
    if (!result.ok) return { status: 409, body: { error: result.message, code: result.code } };

    let executionResult: Record<string, unknown> | null = null;
    if (!result.executionBlocked && result.plan.status === "approved") {
      const { executeApprovedActionPlan } = await import("./action-executor");
      const exec = await executeApprovedActionPlan(env, {
        plan: result.plan,
        actor,
        correlationId: input.correlationId,
      });
      executionResult = exec as Record<string, unknown>;
    }

    return {
      status: 200,
      body: {
        ...sanitizePlanForClient(result.plan),
        executionBlocked: result.executionBlocked,
        blockReason: result.blockReason ?? null,
        executionResult,
        message: result.executionBlocked
          ? "Plan confirmed but financial writes are disabled in production."
          : "Plan confirmed and ready for execution.",
      },
    };
  }

  const instance = await resolveConnectedXeroInstance(env, input.companyId);
  if (!instance) {
    return {
      status: 409,
      body: { error: "Xero is not connected for this company.", code: "CONNECTOR_NOT_CONNECTED" },
    };
  }

  if (input.toolName === "plan_xero_credit_invoices") {
    const invoiceNumbers = Array.isArray(input.arguments.invoiceNumbers)
      ? input.arguments.invoiceNumbers.map(String)
      : [];
    const contract = xeroToolContract("xero_create_credit_note");
    const permission = evaluateActionPermission({
      action: contract?.action ?? "xero.credit_notes.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: instance.authStatus,
      grantedScopes: grantedScopes(instance),
      requiredScopes: missingScopesForTier(grantedScopes(instance), "write").length
        ? missingScopesForTier(grantedScopes(instance), "write")
        : undefined,
      flags: { financialWritesEnabled: FINANCIAL_WRITES_ENABLED, writesEnabled: FINANCIAL_WRITES_ENABLED },
    });
    const planned = await planXeroCreditInvoices({
      env,
      companyId: input.companyId,
      instanceId: instance.id,
      actor,
      invoiceNumbers,
    });
    const { plan, confirmationToken } = await createActionPlan(env.DB, {
      companyId: input.companyId,
      connectorInstanceId: instance.id,
      requestedAction: "xero.credit_notes.create",
      idempotencyKey: input.arguments.idempotencyKey ? String(input.arguments.idempotencyKey) : null,
      actor,
      sourceClient: input.sourceClient,
      correlationId: input.correlationId ?? null,
      interactionId: input.interactionId ?? null,
      targets: planned.targets,
      summary: planned.summary,
      financialImpact: planned.financialImpact,
      permissionDecision: permission,
      riskClass: "financial_action",
    });
    return {
      status: 200,
      body: {
        ...sanitizePlanForClient(plan),
        confirmationToken,
        allTargetsValid: planned.allValid,
        permission: permission.reasonCode,
        writesEnabled: FINANCIAL_WRITES_ENABLED,
      },
    };
  }

  if (input.toolName === "plan_xero_draft_invoice") {
    const contract = xeroToolContract("xero_create_draft_invoice");
    const permission = evaluateActionPermission({
      action: contract?.action ?? "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: instance.authStatus,
      grantedScopes: grantedScopes(instance),
      flags: { financialWritesEnabled: FINANCIAL_WRITES_ENABLED, writesEnabled: FINANCIAL_WRITES_ENABLED },
    });
    const planned = await planXeroDraftInvoice({
      env,
      companyId: input.companyId,
      instanceId: instance.id,
      actor,
      contactId: String(input.arguments.contactId ?? ""),
      lineItems: Array.isArray(input.arguments.lineItems)
        ? (input.arguments.lineItems as Array<{
            description: string;
            quantity: number;
            unitAmount: number;
            accountCode?: string;
          }>)
        : [],
      reference: input.arguments.reference ? String(input.arguments.reference) : undefined,
      date: input.arguments.date ? String(input.arguments.date) : undefined,
    });
    const { plan, confirmationToken } = await createActionPlan(env.DB, {
      companyId: input.companyId,
      connectorInstanceId: instance.id,
      requestedAction: "xero.invoices.create",
      idempotencyKey: input.arguments.idempotencyKey ? String(input.arguments.idempotencyKey) : null,
      actor,
      sourceClient: input.sourceClient,
      correlationId: input.correlationId ?? null,
      interactionId: input.interactionId ?? null,
      targets: planned.targets,
      summary: planned.summary,
      financialImpact: planned.financialImpact,
      permissionDecision: permission,
      riskClass: "financial_action",
    });
    return {
      status: 200,
      body: {
        ...sanitizePlanForClient(plan),
        confirmationToken,
        permission: permission.reasonCode,
        writesEnabled: FINANCIAL_WRITES_ENABLED,
      },
    };
  }

  if (input.toolName === "plan_xero_remittance_allocation") {
    const permission = evaluateActionPermission({
      action: "xero.payments.allocate",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: instance.authStatus,
      grantedScopes: grantedScopes(instance),
      flags: { financialWritesEnabled: FINANCIAL_WRITES_ENABLED, writesEnabled: FINANCIAL_WRITES_ENABLED },
    });
    const planned = await planXeroRemittanceAllocation({
      env,
      companyId: input.companyId,
      instanceId: instance.id,
      actor,
      paymentAmount: Number(input.arguments.paymentAmount ?? 0),
      currencyCode: String(input.arguments.currencyCode ?? "GBP"),
      invoiceHints: Array.isArray(input.arguments.invoiceHints)
        ? (input.arguments.invoiceHints as Array<{ invoiceNumber?: string; amount?: number }>)
        : [],
    });
    const { plan, confirmationToken } = await createActionPlan(env.DB, {
      companyId: input.companyId,
      connectorInstanceId: instance.id,
      requestedAction: "xero.payments.allocate",
      idempotencyKey: input.arguments.idempotencyKey ? String(input.arguments.idempotencyKey) : null,
      actor,
      sourceClient: input.sourceClient,
      correlationId: input.correlationId ?? null,
      interactionId: input.interactionId ?? null,
      targets: planned.targets,
      summary: planned.summary,
      financialImpact: planned.financialImpact,
      permissionDecision: permission,
      riskClass: "financial_action",
    });
    return {
      status: 200,
      body: {
        ...sanitizePlanForClient(plan),
        confirmationToken,
        candidates: planned.candidates,
        matchConfidence: planned.confidence,
        permission: permission.reasonCode,
        writesEnabled: FINANCIAL_WRITES_ENABLED,
      },
    };
  }

  return { status: 400, body: { error: "Unknown action control tool", code: "UNKNOWN_TOOL" } };
}

function sanitizePlanForClient(plan: Awaited<ReturnType<typeof getActionPlan>> & object) {
  return {
    planId: plan.id,
    status: plan.status,
    requestedAction: plan.requestedAction,
    provider: plan.provider,
    summary: plan.summary,
    targets: plan.targets,
    financialImpact: plan.financialImpact,
    permission: plan.permissionDecision?.reasonCode ?? null,
    confirmationStatus: plan.confirmationStatus,
    approvalStatus: plan.approvalStatus,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    writesEnabled: FINANCIAL_WRITES_ENABLED,
  };
}
