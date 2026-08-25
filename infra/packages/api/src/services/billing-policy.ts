/**
 * TEST billing policy — what may debit a company wallet.
 *
 * Health, initialize, and tools/list never reach this module.
 * Do not change commercial amounts here; this only classifies outcomes.
 */

export type BillingOutcome =
  | "success_with_results"
  | "success_zero_results"
  | "downstream_error"
  | "authentication_failure"
  | "permission_denial"
  | "insufficient_credit"
  | "infra_internal_failure"
  | "idempotent_replay"
  | "non_billable_tool";

export type BillingDecision = {
  outcome: BillingOutcome;
  customerBillable: boolean;
  reason: string;
};

/**
 * TEST rule:
 * - Charge only a successful, billable tool execution that is not a replay.
 * - Zero-result knowledge searches remain billable (same as current 1p TEST).
 * - Auth, permission, credit, downstream, and internal failures do not charge.
 * - Health / discovery are non-billable tools.
 */
export function decideTestBilling(input: {
  toolName?: string | null;
  action?: string | null;
  success: boolean;
  httpStatus: number;
  idempotentReplay?: boolean;
  ruleBillable?: boolean;
  chargeOnFailure?: boolean;
}): BillingDecision {
  const action = input.action ?? "";
  const tool = input.toolName ?? "";

  if (input.idempotentReplay) {
    return {
      outcome: "idempotent_replay",
      customerBillable: false,
      reason: "Replay of an already-settled operation does not charge again",
    };
  }

  if (
    action === "system.health" ||
    action === "xero.health" ||
    action === "xero.token_refresh" ||
    tool === "system_health" ||
    tool === "initialize" ||
    tool === "tools/list" ||
    tool === "xero_connection_test"
  ) {
    return {
      outcome: "non_billable_tool",
      customerBillable: false,
      reason: "Health and discovery are not customer-billable",
    };
  }

  if (input.httpStatus === 401) {
    return {
      outcome: "authentication_failure",
      customerBillable: false,
      reason: "Authentication failures are not charged",
    };
  }
  if (input.httpStatus === 403) {
    return {
      outcome: "permission_denial",
      customerBillable: false,
      reason: "Permission denials are not charged",
    };
  }
  if (input.httpStatus === 402) {
    return {
      outcome: "insufficient_credit",
      customerBillable: false,
      reason: "Blocked before execution; no usage debit",
    };
  }

  if (!input.success) {
    if (input.httpStatus >= 500) {
      return {
        outcome: "infra_internal_failure",
        customerBillable: Boolean(input.chargeOnFailure && input.ruleBillable),
        reason: "TEST: internal/downstream failure is not charged",
      };
    }
    return {
      outcome: "downstream_error",
      customerBillable: Boolean(input.chargeOnFailure && input.ruleBillable),
      reason: "TEST: failed operations are not charged",
    };
  }

  if (!input.ruleBillable) {
    return {
      outcome: "non_billable_tool",
      customerBillable: false,
      reason: "Pricing rule is not billable",
    };
  }

  return {
    outcome: "success_with_results",
    customerBillable: true,
    reason:
      "TEST: successful billable operations charge, including zero-result searches",
  };
}

export function classifyZeroResultSuccess(): BillingDecision {
  return {
    outcome: "success_zero_results",
    customerBillable: true,
    reason:
      "TEST: a successful knowledge search with no hits still used the company MCP and remains 1p",
  };
}
