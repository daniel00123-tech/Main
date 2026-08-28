/**
 * Xero read/write governance — mutation semantics derived from existing contracts.
 * Reuses riskClass / Action Engine risk model; does not introduce a competing framework.
 */

import { actionRiskProfile, riskLevelForAction } from "../action-engine/risk-model";
import type { XeroToolContract } from "./xero-spec";
import { XERO_TOOL_CONTRACTS } from "./xero-spec";

/** Standard mutation semantics for tools and actions. */
export type XeroMutationType = "none" | "create" | "update" | "delete" | "financial";

/** Product-facing risk level for documentation and gates. */
export type XeroGovernanceRiskLevel = "read" | "low" | "medium" | "high" | "critical";

/** Per-company Xero write authority (additive kill-switch). */
export type XeroCompanyWriteMode =
  | "READ_ONLY"
  | "CONTROLLED_WRITE"
  | "FULL_APPROVED_WRITE";

/** Server-side execution context — authoritative over client intent. */
export type XeroExecutionContextMode =
  | "read_only"
  | "controlled_write"
  | "action_engine_execute";

export type XeroToolGovernance = {
  toolName: string;
  action: string;
  mutationType: XeroMutationType;
  riskLevel: XeroGovernanceRiskLevel;
  requiresExplicitWriteIntent: boolean;
  requiresConfirmation: boolean;
  requiresApproval: boolean;
  riskClass: XeroToolContract["riskClass"];
};

const WRITE_TOOL_PREFIXES: Record<string, XeroMutationType> = {
  xero_create_: "create",
  xero_update_: "update",
  xero_approve_: "financial",
  xero_send_: "financial",
  xero_allocate_: "financial",
  xero_void_: "delete",
  xero_delete_: "delete",
};

function mutationTypeFromToolName(toolName: string, riskClass: XeroToolContract["riskClass"]): XeroMutationType {
  if (riskClass === "low_risk") return "none";
  for (const [prefix, type] of Object.entries(WRITE_TOOL_PREFIXES)) {
    if (toolName.startsWith(prefix)) return type;
  }
  if (riskClass === "delete") return "delete";
  if (riskClass === "external_send") return "financial";
  if (riskClass === "financial_action") return "financial";
  if (riskClass === "write") return "create";
  return "financial";
}

function governanceRiskLevel(
  mutationType: XeroMutationType,
  riskClass: XeroToolContract["riskClass"],
  action: string,
): XeroGovernanceRiskLevel {
  if (mutationType === "none") return "read";
  const profile = actionRiskProfile(action);
  switch (profile.level) {
    case "READ":
      return "read";
    case "DRAFT_WRITE":
      return "low";
    case "ACCOUNTING_COMMITMENT":
    case "EXTERNAL_COMMUNICATION":
      return "high";
    case "MONEY_MOVEMENT":
      return "critical";
    case "DESTRUCTIVE":
      return "critical";
    default:
      break;
  }
  if (riskClass === "delete") return "critical";
  if (riskClass === "write") return "low";
  return "medium";
}

export function xeroToolContractByName(toolName: string): XeroToolContract | undefined {
  return XERO_TOOL_CONTRACTS.find(
    (row) => row.mcpToolName === toolName || row.name === toolName,
  );
}

export function isXeroReadToolName(toolName: string): boolean {
  const contract = xeroToolContractByName(toolName);
  return Boolean(contract?.riskClass === "low_risk");
}

export function isXeroMutationToolName(toolName: string): boolean {
  const contract = xeroToolContractByName(toolName);
  return Boolean(contract && contract.riskClass !== "low_risk");
}

export function xeroToolGovernance(toolName: string): XeroToolGovernance | null {
  const contract = xeroToolContractByName(toolName);
  if (!contract) return null;
  const mutationType = mutationTypeFromToolName(contract.mcpToolName, contract.riskClass);
  const profile = actionRiskProfile(contract.action);
  return {
    toolName: contract.mcpToolName,
    action: contract.action,
    mutationType,
    riskLevel: governanceRiskLevel(mutationType, contract.riskClass, contract.action),
    requiresExplicitWriteIntent: mutationType !== "none",
    requiresConfirmation: profile.requiresConfirmation,
    requiresApproval: profile.requiresApproval,
    riskClass: contract.riskClass,
  };
}

export function xeroActionGovernance(action: string): Omit<XeroToolGovernance, "toolName"> & { toolName: null } {
  const level = riskLevelForAction(action);
  const profile = actionRiskProfile(action);
  const mutationType: XeroMutationType =
    level === "READ"
      ? "none"
      : action.includes(".void") || action.includes("delete")
        ? "delete"
        : action.includes(".update")
          ? "update"
          : action.includes(".create")
            ? "create"
            : "financial";
  return {
    toolName: null,
    action,
    mutationType,
    riskLevel: governanceRiskLevel(mutationType, profile.riskClass, action),
    requiresExplicitWriteIntent: mutationType !== "none",
    requiresConfirmation: profile.requiresConfirmation,
    requiresApproval: profile.requiresApproval,
    riskClass: profile.riskClass,
  };
}

export type XeroExecutionGateResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

export function assertXeroToolAllowedInContext(input: {
  executionMode: XeroExecutionContextMode;
  toolName: string;
  companyWriteMode?: XeroCompanyWriteMode;
}): XeroExecutionGateResult {
  const governance = xeroToolGovernance(input.toolName);
  if (!governance) {
    return { allowed: false, code: "XERO_TOOL_UNKNOWN", message: "Unknown Xero tool." };
  }

  if (input.executionMode === "read_only") {
    if (governance.mutationType !== "none") {
      return {
        allowed: false,
        code: "XERO_READ_ONLY_CONTEXT",
        message: "Read-only execution context cannot invoke mutating Xero tools.",
      };
    }
    return { allowed: true };
  }

  if (governance.mutationType === "none") {
    return { allowed: true };
  }

  const companyMode = input.companyWriteMode ?? "READ_ONLY";
  if (companyMode === "READ_ONLY") {
    return {
      allowed: false,
      code: "XERO_COMPANY_READ_ONLY",
      message: "Xero writes are disabled for this company (READ_ONLY mode).",
    };
  }

  if (input.executionMode === "controlled_write" && governance.mutationType !== "none") {
    return {
      allowed: false,
      code: "ACTION_ENGINE_REQUIRED",
      message: "Mutating Xero tools must execute via the Action Engine.",
    };
  }

  if (input.executionMode !== "action_engine_execute") {
    return {
      allowed: false,
      code: "XERO_WRITE_CONTEXT_REQUIRED",
      message: "Xero mutation requires Action Engine execution context.",
    };
  }

  if (
    companyMode === "CONTROLLED_WRITE" &&
    (governance.riskLevel === "critical" || governance.riskClass === "delete")
  ) {
    return {
      allowed: false,
      code: "XERO_WRITE_NOT_APPROVED",
      message: "This Xero operation exceeds CONTROLLED_WRITE policy for this company.",
    };
  }

  return { allowed: true };
}

export function assertXeroActionAllowedInContext(input: {
  executionMode: XeroExecutionContextMode;
  action: string;
  companyWriteMode?: XeroCompanyWriteMode;
}): XeroExecutionGateResult {
  const governance = xeroActionGovernance(input.action);
  if (governance.mutationType === "none") {
    return { allowed: true };
  }

  const companyMode = input.companyWriteMode ?? "READ_ONLY";
  if (companyMode === "READ_ONLY") {
    return {
      allowed: false,
      code: "XERO_COMPANY_READ_ONLY",
      message: "Xero writes are disabled for this company (READ_ONLY mode).",
    };
  }

  if (input.executionMode === "read_only") {
    return {
      allowed: false,
      code: "XERO_READ_ONLY_CONTEXT",
      message: "Read-only execution context cannot execute mutating Xero actions.",
    };
  }

  if (input.executionMode !== "action_engine_execute") {
    return {
      allowed: false,
      code: "ACTION_ENGINE_REQUIRED",
      message: "Mutating Xero actions must execute via the Action Engine.",
    };
  }

  if (
    companyMode === "CONTROLLED_WRITE" &&
    (governance.riskLevel === "critical" || governance.mutationType === "delete")
  ) {
    return {
      allowed: false,
      code: "XERO_WRITE_NOT_APPROVED",
      message: "This Xero action exceeds CONTROLLED_WRITE policy for this company.",
    };
  }

  return { allowed: true };
}

/** Ambiguous natural-language should default to read — explicit write verbs required upstream. */
export const XERO_READ_INTENT_PATTERNS = [
  /\bshow\b/i,
  /\blist\b/i,
  /\bfind\b/i,
  /\bsearch\b/i,
  /\bget\b/i,
  /\bcheck\b/i,
  /\banalys/i,
  /\breport\b/i,
  /\bwhat were\b/i,
  /\btell me\b/i,
  /\boverdue\b/i,
  /\breconcil/i,
];

export const XERO_WRITE_INTENT_PATTERNS = [
  /\bcreate\b/i,
  /\braise\b/i,
  /\bdraft\b/i,
  /\bupdate\b/i,
  /\bchange\b/i,
  /\bapprove\b/i,
  /\bsend\b/i,
  /\bvoid\b/i,
  /\bdelete\b/i,
  /\ballocate\b/i,
  /\breconcile\b.*\b(to|with)\b/i,
];

export function classifyNaturalLanguageXeroIntent(text: string): "read" | "write" | "ambiguous" {
  const normalized = text.trim();
  if (!normalized) return "ambiguous";
  const write = XERO_WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
  const read = XERO_READ_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
  if (write && !read) return "write";
  if (read && !write) return "read";
  if (write && read) return "ambiguous";
  return "ambiguous";
}
