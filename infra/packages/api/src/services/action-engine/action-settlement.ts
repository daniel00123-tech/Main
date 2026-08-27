/**
 * Wallet settlement for Action Engine executions — mirrors gateway billing path.
 * Failed or uncertain executions must never create unexplained customer charges.
 */

import type { ChargeResult } from "../pricing";
import { appendLedgerEntry, getWalletBalance } from "../ledger";
import { allocateDebitCreditClasses, consumePromotionalGrants } from "../promotional-grants";
import {
  calculateChargeCents,
  resolvePricingPolicy,
  resolvePricingRule,
} from "../pricing";
import { markUsageSettled, recordUsageEvent } from "../usage";
import { decideTestBilling } from "../billing-policy";
import { recordAuditEvent } from "../control-plane";
import type { Env } from "../../env";

export type ActionSettlementResult = {
  usageId: string;
  alreadyExists: boolean;
  chargeCents: number | null;
  settlementStatus: "settled" | "zero_charge" | "failed" | "unsettled";
  ledgerEntryId: string | null;
  balanceBeforeCents: number;
  balanceAfterCents: number | null;
  charge: ChargeResult;
};

function humanAction(action: string): string {
  return action.replace(/^xero\./, "Xero ").replace(/\./g, " ").replace(/_/g, " ");
}

export async function settleActionExecutionUsage(
  env: Env,
  input: {
    companyId: string;
    action: string;
    actor: string;
    executionId: string;
    planId: string;
    connectorInstanceId?: string | null;
    riskClass?: string | null;
    success: boolean;
    correlationId?: string | null;
    interactionId?: string | null;
    sourceClient?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<ActionSettlementResult> {
  const requestId = `aex_${input.executionId}`;
  const balanceBefore = await getWalletBalance(env.DB, input.companyId);

  const pricing = await resolvePricingRule(env.DB, input.companyId, input.action);
  const policy = await resolvePricingPolicy(env.DB, input.companyId);
  const charge = calculateChargeCents(pricing, {
    success: input.success,
    policy: policy ?? undefined,
  });

  const billing = decideTestBilling({
    action: input.action,
    success: input.success,
    httpStatus: input.success ? 200 : 500,
    ruleBillable: charge.billable,
    chargeOnFailure: pricing?.chargeOnFailure ?? false,
  });

  const usage = await recordUsageEvent(env.DB, {
    companyId: input.companyId,
    action: input.action,
    actorEmail: input.actor,
    resourceType: "action_execution",
    resourceId: input.executionId,
    connectorInstanceId: input.connectorInstanceId ?? null,
    riskClass: input.riskClass ?? null,
    success: input.success,
    correlationId: input.correlationId ?? null,
    interactionId: input.interactionId ?? null,
    requestId,
    sourceClient: input.sourceClient ?? "action-engine",
    charge,
    metadata: {
      planId: input.planId,
      executionId: input.executionId,
      ...(input.metadata ?? {}),
    },
    settlementStatus:
      billing.customerBillable && charge.customerChargeCents
        ? "unsettled"
        : "zero_charge",
  });

  let settlementStatus: ActionSettlementResult["settlementStatus"] =
    usage.settlementStatus === "settled"
      ? "settled"
      : usage.settlementStatus === "zero_charge"
        ? "zero_charge"
        : "unsettled";
  let ledgerEntryId: string | null = usage.ledgerEntryId ?? null;
  let balanceAfterCents: number | null = null;

  if (usage.alreadyExists && usage.ledgerEntryId) {
    const latest = await getWalletBalance(env.DB, input.companyId);
    return {
      usageId: usage.id,
      alreadyExists: true,
      chargeCents: usage.customerChargeCents ?? charge.customerChargeCents,
      settlementStatus: "settled",
      ledgerEntryId: usage.ledgerEntryId,
      balanceBeforeCents: balanceBefore.balanceCents,
      balanceAfterCents: latest.balanceCents,
      charge,
    };
  }

  if (
    billing.customerBillable &&
    charge.customerChargeCents &&
    charge.customerChargeCents > 0 &&
    input.success
  ) {
    const latestWallet = await getWalletBalance(env.DB, input.companyId);
    if (latestWallet.balanceCents < charge.customerChargeCents) {
      settlementStatus = "failed";
      await recordAuditEvent(env.DB, {
        companyId: input.companyId,
        eventType: "permission.denied",
        actor: input.actor,
        resourceType: "billing",
        resourceId: usage.id,
        detail: {
          stage: "action_engine.billing_insufficient_credit",
          executionId: input.executionId,
          balanceCents: latestWallet.balanceCents,
          requiredCents: charge.customerChargeCents,
        },
      });
    } else {
      try {
        const chargeCents = Math.abs(charge.customerChargeCents);
        const allocation = await allocateDebitCreditClasses(
          env.DB,
          input.companyId,
          chargeCents,
        );
        const ledger = await appendLedgerEntry(env.DB, {
          companyId: input.companyId,
          entryType: "usage_debit",
          amountCents: -chargeCents,
          referenceType: "usage",
          referenceId: usage.id,
          description: `Action Engine · ${humanAction(input.action)}`,
          metadata: {
            executionId: input.executionId,
            planId: input.planId,
            isTestConfig: charge.isTestConfig,
            pricingLabel: charge.pricingLabel,
            balanceBeforeCents: latestWallet.balanceCents,
            promotionalCentsUsed: allocation.promotionalCents,
            paidCentsUsed: allocation.paidCents,
          },
          createdBy: input.actor,
        });
        if (allocation.promotionalCents > 0) {
          await consumePromotionalGrants(env.DB, input.companyId, allocation.promotionalCents);
        }
        ledgerEntryId = ledger.entry.id;
        settlementStatus = "settled";
        balanceAfterCents = ledger.entry.balanceAfterCents;
        await markUsageSettled(env.DB, usage.id, ledger.entry.id);
        await recordAuditEvent(env.DB, {
          companyId: input.companyId,
          eventType: "billing.credit_adjusted",
          actor: input.actor,
          resourceType: "ledger",
          resourceId: ledger.entry.id,
          detail: {
            stage: "action_engine.billing_debit_created",
            executionId: input.executionId,
            amountCents: -chargeCents,
            balanceAfterCents: ledger.entry.balanceAfterCents,
          },
        });
      } catch {
        settlementStatus = "failed";
      }
    }
  }

  if (balanceAfterCents == null) {
    balanceAfterCents = (await getWalletBalance(env.DB, input.companyId)).balanceCents;
  }

  return {
    usageId: usage.id,
    alreadyExists: Boolean(usage.alreadyExists),
    chargeCents: charge.customerChargeCents,
    settlementStatus,
    ledgerEntryId,
    balanceBeforeCents: balanceBefore.balanceCents,
    balanceAfterCents,
    charge,
  };
}
