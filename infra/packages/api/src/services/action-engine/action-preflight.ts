import {
  missingScopesForTier,
  type ActionPlanRecord,
  XERO_SCOPES_DRAFT_INVOICE,
} from "@infra/shared";
import type { Env } from "../../env";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import { getCompanyById, getConnectorInstance } from "../control-plane";
import { evaluateUnifiedActionPermission } from "./unified-permission";
import { actionWriteFlags } from "./plan-permission";
import { isPlanStale } from "./action-engine";
import { revalidateXeroPlanTargets } from "./xero-planner";

export type PreflightCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type PreflightResult =
  | { ok: true; checks: PreflightCheck[] }
  | { ok: false; checks: PreflightCheck[]; code: string; message: string };

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

function requiredScopesForAction(action: string): string[] | undefined {
  if (action === "xero.invoices.create" || action === "xero.invoices.update") {
    return [...XERO_SCOPES_DRAFT_INVOICE];
  }
  return undefined;
}

export async function runActionPreflight(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    actor: string;
    dryRun?: boolean;
    requireApproved?: boolean;
  },
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const { plan } = input;

  const company = await getCompanyById(env.DB, plan.companyId);
  const companyOk = company?.status === "active";
  checks.push({
    name: "company_active",
    ok: Boolean(companyOk),
    detail: company?.status ?? "unknown",
  });

  const writesGateOk = input.dryRun ? true : FINANCIAL_WRITES_ENABLED;
  checks.push({
    name: "financial_writes_enabled",
    ok: writesGateOk,
    detail: FINANCIAL_WRITES_ENABLED ? "enabled" : "BLOCKED — FINANCIAL_WRITES_ENABLED=false",
  });

  const statusOk = Boolean(
    plan.status === "approved" ||
      (input.dryRun &&
        ["awaiting_confirmation", "validated", "approved"].includes(plan.status)),
  );
  checks.push({
    name: "plan_status",
    ok: statusOk,
    detail: plan.status,
  });

  const expired =
    plan.expiresAt != null && Date.parse(plan.expiresAt) <= Date.now();
  checks.push({
    name: "plan_not_expired",
    ok: !expired,
    detail: plan.expiresAt ?? undefined,
  });

  if (plan.confirmationStatus === "awaiting" && !input.dryRun) {
    checks.push({
      name: "confirmation_complete",
      ok: false,
      detail: "awaiting",
    });
  } else {
    checks.push({
      name: "confirmation_complete",
      ok: true,
      detail: plan.confirmationStatus,
    });
  }

  if (plan.approvalStatus === "pending") {
    checks.push({
      name: "approval_complete",
      ok: false,
      detail: "pending",
    });
  } else {
    checks.push({
      name: "approval_complete",
      ok: true,
      detail: plan.approvalStatus,
    });
  }

  if (!plan.connectorInstanceId) {
    checks.push({ name: "connector_connected", ok: false, detail: "missing instance" });
  } else {
    const instance = await getConnectorInstance(env.DB, plan.connectorInstanceId);
    const connected = Boolean(instance && instance.authStatus === "connected");
    checks.push({
      name: "connector_connected",
      ok: connected,
      detail: instance?.authStatus ?? "not_found",
    });

    if (instance) {
      const scopes = grantedScopes(instance);
      const required = requiredScopesForAction(plan.requestedAction);
      const missing = required?.filter((scope) => !scopes.includes(scope)) ?? [];
      checks.push({
        name: "oauth_write_scope",
        ok: missing.length === 0,
        detail: missing.length ? `missing: ${missing.join(", ")}` : "ready",
      });

      const permission = await evaluateUnifiedActionPermission(env.DB, {
        action: plan.requestedAction,
        riskClass: plan.riskClass,
        companyId: plan.companyId,
        companyStatus: company?.status ?? "active",
        connectorConnected: connected,
        connectorAuthStatus: instance.authStatus ?? "unknown",
        grantedScopes: scopes,
        requiredScopes: required,
        flags: actionWriteFlags(env, plan.requestedAction),
        skipRoleCheck: true,
      });
      checks.push({
        name: "permission_decision",
        ok: Boolean(permission.allowed || input.dryRun),
        detail: permission.denialCode ?? permission.reasonCode,
      });
    }
  }

  if (plan.connectorInstanceId && plan.provider === "xero") {
    try {
      const live = await revalidateXeroPlanTargets({
        env,
        companyId: plan.companyId,
        instanceId: plan.connectorInstanceId,
        actor: input.actor,
        requestedAction: plan.requestedAction,
        targets: plan.targets,
      });
      const stale = isPlanStale(plan, live.fingerprint);
      checks.push({
        name: "plan_fingerprint",
        ok: !stale,
        detail: stale ? "PLAN_STALE" : "unchanged",
      });
      const allValid = live.targets.every((t) => t.validation === "valid");
      checks.push({
        name: "targets_valid",
        ok: allValid,
        detail: `${live.targets.filter((t) => t.validation === "valid").length}/${live.targets.length} valid`,
      });
    } catch (err) {
      checks.push({
        name: "live_revalidation",
        ok: false,
        detail: err instanceof Error ? err.message : "revalidation_failed",
      });
    }
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    return { ok: true, checks };
  }

  const primary = failed[0]!;
  return {
    ok: false,
    checks,
    code: primary.name.toUpperCase(),
    message: primary.detail ?? primary.name,
  };
}
