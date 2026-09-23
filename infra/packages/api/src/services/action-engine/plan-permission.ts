import type { Env } from "../../env";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import type { UnifiedPermissionDecision } from "./unified-permission";

/** Protected INFRA-prefix draft cleanup is not a general destructive write. */
const PROTECTED_TEST_DRAFT_DELETE = "xero.test_artefact.delete_draft";

export function actionWriteFlags(env: Env, action?: string) {
  return {
    financialWritesEnabled: FINANCIAL_WRITES_ENABLED,
    writesEnabled: FINANCIAL_WRITES_ENABLED,
    destructiveWritesEnabled:
      env.DESTRUCTIVE_WRITES_ENABLED === "true" || action === PROTECTED_TEST_DRAFT_DELETE,
  };
}

export function isHardPlanDenial(permission: { allowed: boolean }): boolean {
  return permission.allowed === false;
}

export function planPermissionDeniedResponse(
  permission: UnifiedPermissionDecision,
  action: string,
): { status: 403; body: Record<string, unknown> } {
  return {
    status: 403,
    body: {
      error: permission.message ?? "This action is not permitted.",
      code: "ACTION_PERMISSION_DENIED",
      denialCode: permission.denialCode,
      reasonCode: permission.reasonCode,
      action,
    },
  };
}
