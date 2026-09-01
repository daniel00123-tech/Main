import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES, ELVEX_ROLE_LABELS, isElvexRole } from "./elvex-rbac";
import type { CompanyRole } from "../types";

/**
 * Company-connected capability families used for user-facing access outcomes.
 * Invitation/membership/role stay separate: this only describes what a tool
 * is asking to do, and whether the company has that connector.
 */
export type ProtectedCapability =
  | "xero"
  | "finance_mailbox"
  | "info_mailbox"
  | "payments"
  | "admin"
  | "restricted_knowledge";

export type CapabilityAccessOutcome =
  | "allowed"
  | "permission_denied"
  | "not_connected"
  | "technical_failure"
  | "empty_result";

export type StructuredCapabilityDenial = {
  error: "permission_denied";
  capability: ProtectedCapability;
  connected: boolean;
  userAllowed: false;
  userRole: string | null;
  reason: "user_not_authorised";
  message: string;
};

const CONNECTOR_LABEL: Record<ProtectedCapability, string> = {
  xero: "Xero",
  finance_mailbox: "Finance email",
  info_mailbox: "Info email",
  payments: "Payments",
  admin: "administration",
  restricted_knowledge: "restricted knowledge",
};

export function humanRoleLabel(role: string | null | undefined): string {
  if (!role) return "current";
  if (isElvexRole(role)) return ELVEX_ROLE_LABELS[role];
  return role
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function capabilityFromAction(input: {
  action?: string | null;
  toolName?: string | null;
  mailboxAddress?: string | null;
}): ProtectedCapability | null {
  const action = (input.action ?? "").toLowerCase();
  const tool = (input.toolName ?? "").toLowerCase();
  const mailbox = (input.mailboxAddress ?? "").trim().toLowerCase();

  if (action.startsWith("admin.") || tool.includes("admin") || action.includes("users.manage")) {
    return "admin";
  }
  if (
    action.includes("payment") ||
    tool.includes("payment") ||
    action === "xero.payments.allocate"
  ) {
    return "payments";
  }
  if (action.includes("restricted") || tool.includes("restricted")) {
    return "restricted_knowledge";
  }
  if (action.startsWith("xero.") || tool.includes("xero")) {
    return "xero";
  }

  const financeMailbox =
    mailbox &&
    (ELVEX_FINANCE_MAILBOXES.includes(mailbox) ||
      mailbox.startsWith("finance@") ||
      mailbox === "finance" ||
      mailbox.includes("finance inbox"));
  if (
    financeMailbox ||
    action.includes("mail.finance") ||
    ((action.startsWith("outlook.") || action.startsWith("mail.") || tool.includes("outlook") || tool.includes("email")) &&
      financeMailbox)
  ) {
    return "finance_mailbox";
  }

  const infoMailbox =
    mailbox &&
    (ELVEX_INFO_MAILBOXES.includes(mailbox) ||
      mailbox.startsWith("info@") ||
      mailbox === "info" ||
      mailbox.includes("info inbox"));
  if (infoMailbox) return "info_mailbox";

  return null;
}

/**
 * Infer a protected live-system capability from a knowledge-tool query.
 * Used so ChatGPT cannot treat a denied connector as "search returned no results".
 * Document questions about a system stay on the knowledge path.
 */
export function inferProtectedCapabilityFromQuery(query: string | null | undefined): ProtectedCapability | null {
  if (!query?.trim()) return null;
  const q = query.trim().toLowerCase();

  if (
    /\b(make a payment|pay (this |an |the )?invoice|send (a )?payment|allocate (a )?payment)\b/.test(q)
  ) {
    return "payments";
  }
  if (
    /\b(admin users|list users|show (me )?admin|administration|manage (the )?roles|who has admin)\b/.test(q)
  ) {
    return "admin";
  }
  if (/\b(restricted (knowledge|documents?|files?)|confidential (docs?|documents?))\b/.test(q)) {
    return "restricted_knowledge";
  }
  if (
    /\b(finance@|finance inbox|finance emails?|emails? (in |from )?finance)\b/.test(q)
  ) {
    return "finance_mailbox";
  }

  const mentionsXero = /\bxero\b/.test(q);
  const documentQuestion =
    /\b(process|policy|procedure|how do we|where is|written|document|guide|manual)\b/.test(q);
  const liveFinance =
    /\b(sales|invoices?|p&l|profit and loss|balance sheet|overdue|aged receivables|bank transactions|month[- ]to[- ]date|this month|what (are|were|is) (our |the )?sales)\b/.test(
      q,
    );
  if (mentionsXero && liveFinance && !documentQuestion) return "xero";
  if (mentionsXero && /\b(tell me|show me|how much|total)\b/.test(q) && !documentQuestion) {
    return "xero";
  }

  return null;
}

export function actionForProtectedCapability(capability: ProtectedCapability): string {
  switch (capability) {
    case "xero":
      return "xero.sales.read";
    case "finance_mailbox":
      return "outlook.search";
    case "info_mailbox":
      return "outlook.search";
    case "payments":
      return "xero.payments.allocate";
    case "admin":
      return "admin.users.manage";
    case "restricted_knowledge":
      return "knowledge.restricted.read";
  }
}

export function mailboxForCapability(capability: ProtectedCapability): string | null {
  if (capability === "finance_mailbox") return ELVEX_FINANCE_MAILBOXES[0];
  if (capability === "info_mailbox") return ELVEX_INFO_MAILBOXES[0];
  return null;
}

export function userFacingPermissionDeniedMessage(input: {
  capability: ProtectedCapability;
  connected: boolean;
  role?: CompanyRole | string | null;
  companyName?: string | null;
}): string {
  const company = (input.companyName ?? "this company").trim() || "this company";
  const roleLabel = humanRoleLabel(input.role);
  const askAdmin =
    "If you need access, ask your manager or an INFRA administrator to update your permissions.";

  switch (input.capability) {
    case "xero":
      return input.connected
        ? `Xero is connected for ${company}, but your ${roleLabel} permissions don’t allow you to view Xero financial data. ${askAdmin}`
        : `Xero isn’t connected for ${company}.`;
    case "finance_mailbox":
      return input.connected
        ? `Finance email is connected, but your current permissions don’t allow access to that mailbox. ${askAdmin}`
        : "Finance email isn’t connected for this company.";
    case "info_mailbox":
      return input.connected
        ? "Info email is connected, but your current permissions don’t allow access to that mailbox."
        : "Info email isn’t connected for this company.";
    case "payments":
      return "Your current permissions don’t allow you to make payments.";
    case "admin":
      return "Your current permissions don’t allow access to administration.";
    case "restricted_knowledge":
      return "Your current permissions don’t allow access to restricted knowledge.";
  }
}

export function userFacingNotConnectedMessage(capability: ProtectedCapability, companyName?: string | null): string {
  const company = (companyName ?? "this company").trim() || "this company";
  switch (capability) {
    case "xero":
      return `Xero isn’t connected for ${company}.`;
    case "finance_mailbox":
      return "Finance email isn’t connected for this company.";
    case "info_mailbox":
      return "Info email isn’t connected for this company.";
    case "payments":
      return "Payments aren’t connected for this company.";
    case "admin":
      return "Administration isn’t available for this company.";
    case "restricted_knowledge":
      return "Restricted knowledge isn’t available for this company.";
  }
}

export function userFacingTechnicalFailureMessage(capability: ProtectedCapability): string {
  const label = CONNECTOR_LABEL[capability];
  if (capability === "xero") {
    return "I couldn’t retrieve Xero data just now.";
  }
  if (capability === "admin") {
    return "I couldn’t retrieve administration data just now.";
  }
  return `I couldn’t retrieve ${label} data just now.`;
}

export function buildStructuredPermissionDenial(input: {
  capability: ProtectedCapability;
  connected: boolean;
  role?: CompanyRole | string | null;
  companyName?: string | null;
}): StructuredCapabilityDenial {
  return {
    error: "permission_denied",
    capability: input.capability,
    connected: input.connected,
    userAllowed: false,
    userRole: input.role ?? null,
    reason: "user_not_authorised",
    message: userFacingPermissionDeniedMessage(input),
  };
}

export function isKnowledgeDiscoveryTool(toolName: string | null | undefined): boolean {
  const name = (toolName ?? "").toLowerCase();
  return (
    name === "search" ||
    name === "search_company_knowledge" ||
    name === "database_summary"
  );
}
