import type { ActionPlanRecord } from "@infra/shared";
import { XERO_SCOPES_DRAFT_INVOICE } from "@infra/shared";
import type { Env } from "../../env";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import { getConnectorInstance } from "../control-plane";
import { getValidXeroAccessToken } from "../xero";
import { runActionPreflight } from "./action-preflight";
import { draftInvoicePayloadFromPlan } from "./company-mcp-xero-write";

function grantedScopes(instance: {
  capabilitiesEnabled?: string[];
  config?: Record<string, unknown>;
}): string[] {
  if (Array.isArray(instance.capabilitiesEnabled) && instance.capabilitiesEnabled.length) {
    return instance.capabilitiesEnabled.map(String);
  }
  const fromConfig = instance.config?.grantedScopes;
  return Array.isArray(fromConfig) ? fromConfig.map(String) : [];
}

export type ActionDryRunReport = {
  readyToExecute: boolean;
  headline: string;
  organisation: string | null;
  action: string;
  actionLabel: string;
  type: string | null;
  contact: { id: string; name: string | null } | null;
  amount: number | null;
  currencyCode: string | null;
  reference: string | null;
  description: string | null;
  risk: string;
  confirmation: string;
  approval: string;
  oauthWriteScope: { required: string[]; missing: string[]; status: "ready" | "missing" };
  executionGate: { blocked: boolean; reason: string | null };
  preflightChecks: Array<{ name: string; ok: boolean; detail?: string }>;
  planId: string;
  planStatus: string;
};

function humanActionLabel(action: string): string {
  if (action === "xero.invoices.create") return "Create Draft Sales Invoice";
  return action;
}

export async function buildActionDryRunReport(
  env: Env,
  input: { plan: ActionPlanRecord; actor: string },
): Promise<ActionDryRunReport> {
  const preflight = await runActionPreflight(env, {
    plan: input.plan,
    actor: input.actor,
    dryRun: true,
  });

  let organisation: string | null = null;
  let oauthMissing: string[] = [...XERO_SCOPES_DRAFT_INVOICE];
  if (input.plan.connectorInstanceId) {
    const instance = await getConnectorInstance(env.DB, input.plan.connectorInstanceId);
    if (instance) {
      const scopes = grantedScopes(instance);
      oauthMissing = XERO_SCOPES_DRAFT_INVOICE.filter((scope) => !scopes.includes(scope));
      const token = await getValidXeroAccessToken({
        env,
        companyId: input.plan.companyId,
        instanceId: instance.id,
        actor: input.actor,
        reason: "dry_run",
      });
      if (token.ok) {
        organisation = token.payload.organisationName ?? null;
      }
    }
  }

  const target = input.plan.targets[0];
  const proposed = target?.proposedState ?? {};
  let contactName: string | null = null;
  if (target?.currentState?.contactName) {
    contactName = String(target.currentState.contactName);
  } else if (target?.humanRef) {
    contactName = String(target.humanRef);
  }

  let payload: ReturnType<typeof draftInvoicePayloadFromPlan> | null = null;
  try {
    if (input.plan.requestedAction === "xero.invoices.create") {
      payload = draftInvoicePayloadFromPlan(input.plan);
    }
  } catch {
    payload = null;
  }

  const amount =
    input.plan.financialImpact?.totalAmount ??
    (payload
      ? payload.lineItems.reduce((sum, row) => sum + row.quantity * row.unitAmount, 0)
      : null);

  const executionBlocked = !FINANCIAL_WRITES_ENABLED;
  const preflightOk = preflight.ok;
  const scopeOk = oauthMissing.length === 0;
  const readyToExecute = preflightOk && scopeOk && !executionBlocked;

  return {
    readyToExecute,
    headline: readyToExecute ? "READY TO EXECUTE" : "NOT READY TO EXECUTE",
    organisation,
    action: input.plan.requestedAction,
    actionLabel: humanActionLabel(input.plan.requestedAction),
    type: proposed.type ? String(proposed.type) : input.plan.requestedAction.includes("invoice") ? "ACCREC" : null,
    contact: target
      ? { id: String(proposed.contactId ?? target.targetId), name: contactName }
      : null,
    amount,
    currencyCode: input.plan.financialImpact?.currencyCode ?? target?.currencyCode ?? null,
    reference: payload?.reference ?? (proposed.reference ? String(proposed.reference) : null),
    description: payload?.lineItems?.[0]?.description ?? null,
    risk: input.plan.riskClass,
    confirmation:
      input.plan.confirmationStatus === "confirmed"
        ? "Confirmed"
        : input.plan.confirmationStatus === "awaiting"
          ? "Awaiting confirmation"
          : "Not required",
    approval:
      input.plan.approvalStatus === "pending"
        ? "Awaiting separate approval"
        : input.plan.approvalStatus === "approved"
          ? "Approved"
          : "Confirmation sufficient (no separate approver required)",
    oauthWriteScope: {
      required: [...XERO_SCOPES_DRAFT_INVOICE],
      missing: oauthMissing,
      status: oauthMissing.length === 0 ? "ready" : "missing",
    },
    executionGate: {
      blocked: executionBlocked,
      reason: executionBlocked ? "BLOCKED — FINANCIAL_WRITES_ENABLED=false" : null,
    },
    preflightChecks: preflight.checks,
    planId: input.plan.id,
    planStatus: input.plan.status,
  };
}
