import type { CompanyRole } from "../types";

export const ELVEX_COMPANY_ID = "co_el";
export const ELVEX_COMPANY_SLUG = "el-business";

export const ELVEX_CANONICAL_ROLES = [
  "engineer",
  "office_staff",
  "finance_team",
  "operations_manager",
  "finance_manager",
  "director",
  "company_admin",
] as const;

export type ElvexRole = (typeof ELVEX_CANONICAL_ROLES)[number];

export const ELVEX_ROLE_LABELS: Record<ElvexRole, string> = {
  engineer: "Engineer",
  office_staff: "Office Staff",
  finance_team: "Finance Team",
  operations_manager: "Operations Manager",
  finance_manager: "Finance Manager",
  director: "Director",
  company_admin: "Company Admin",
};

export const ELVEX_CAPABILITIES = [
  "knowledge.engineer.read",
  "knowledge.company.read",
  "knowledge.finance.read",
  "knowledge.restricted.read",
  "mail.info.read",
  "mail.info.write",
  "mail.finance.read",
  "mail.finance.write",
  "xero.sales.read",
  "xero.finance.read",
  "xero.draft.write",
  "xero.contacts.write",
  "xero.settings.read",
  "admin.portal.access",
  "admin.users.manage",
  "admin.roles.manage",
  "admin.config.manage",
  "payment.info.access",
  "system.health",
] as const;

export type ElvexCapability = (typeof ELVEX_CAPABILITIES)[number];

const ENGINEER: ElvexCapability[] = ["knowledge.engineer.read", "system.health"];
const OFFICE: ElvexCapability[] = [
  ...ENGINEER,
  "knowledge.company.read",
  "mail.info.read",
  "mail.info.write",
];
const FINANCE_TEAM: ElvexCapability[] = [
  ...OFFICE,
  "knowledge.finance.read",
  "mail.finance.read",
  "mail.finance.write",
  "xero.sales.read",
  "xero.finance.read",
];
const OPERATIONS: ElvexCapability[] = [...OFFICE, "xero.sales.read"];
const FINANCE_MANAGER: ElvexCapability[] = [
  ...FINANCE_TEAM,
  "xero.draft.write",
  "xero.contacts.write",
  "xero.settings.read",
];
const DIRECTOR: ElvexCapability[] = [
  ...FINANCE_MANAGER,
  "knowledge.restricted.read",
  "admin.portal.access",
  "admin.users.manage",
  "admin.config.manage",
  "payment.info.access",
];
const COMPANY_ADMIN: ElvexCapability[] = [...DIRECTOR, "admin.roles.manage"];

export const ELVEX_ROLE_GRANTS: Record<ElvexRole, ReadonlySet<ElvexCapability>> = {
  engineer: new Set(ENGINEER),
  office_staff: new Set(OFFICE),
  finance_team: new Set(FINANCE_TEAM),
  operations_manager: new Set(OPERATIONS),
  finance_manager: new Set(FINANCE_MANAGER),
  director: new Set(DIRECTOR),
  company_admin: new Set(COMPANY_ADMIN),
};

export const ELVEX_INFO_MAILBOXES = ["info@elvexpropertyservices.com"];
export const ELVEX_FINANCE_MAILBOXES = ["finance@elvexpropertyservices.com"];

export function isElvexRole(role: string | null | undefined): role is ElvexRole {
  return Boolean(role && (ELVEX_CANONICAL_ROLES as readonly string[]).includes(role));
}

export function isElvexCompany(input: { id?: string | null; slug?: string | null }): boolean {
  return input.id === ELVEX_COMPANY_ID || input.slug === ELVEX_COMPANY_SLUG;
}

export function elvexCan(role: CompanyRole | null, capability: ElvexCapability): boolean {
  if (!isElvexRole(role)) return false;
  return ELVEX_ROLE_GRANTS[role].has(capability);
}

export function elvexCapabilitiesForRole(role: ElvexRole): ElvexCapability[] {
  return [...ELVEX_ROLE_GRANTS[role]].sort();
}

export function elvexMailboxCapability(
  mailbox: string | null | undefined,
  write: boolean,
): ElvexCapability | null {
  if (!mailbox?.trim()) return null;
  const addr = mailbox.trim().toLowerCase();
  if (addr.includes("finance@") || ELVEX_FINANCE_MAILBOXES.includes(addr)) {
    return write ? "mail.finance.write" : "mail.finance.read";
  }
  if (addr.includes("info@") || ELVEX_INFO_MAILBOXES.includes(addr)) {
    return write ? "mail.info.write" : "mail.info.read";
  }
  return null;
}

/** Map INFRA/MCP tool actions onto Elvex capabilities. Unknown privileged tools fail closed. */
export function mapActionToElvexCapability(
  action: string,
  context?: { toolName?: string | null; mailboxAddress?: string | null },
): ElvexCapability | "engineer_or_company" | null {
  if (context?.toolName && ELVEX_MCP_TOOL_CAPABILITIES[context.toolName]) {
    const mapped = ELVEX_MCP_TOOL_CAPABILITIES[context.toolName];
    if (mapped.startsWith("mail.") && context.mailboxAddress) {
      return (
        elvexMailboxCapability(context.mailboxAddress, mapped.includes("write")) ?? mapped
      );
    }
    return mapped;
  }

  if ((ELVEX_CAPABILITIES as readonly string[]).includes(action)) {
    return action as ElvexCapability;
  }
  if (action === "system.health") return "system.health";
  if (action === "knowledge.search" || action === "knowledge.read") {
    return "engineer_or_company";
  }
  if (action.startsWith("xero.reports.profit") || action.includes("profit_and_loss")) {
    return "xero.finance.read";
  }
  if (
    action === "xero.invoices.read" ||
    action === "xero.invoices.search" ||
    action === "xero.invoices.get" ||
    action === "xero.contacts.read" ||
    action === "xero.contacts.search"
  ) {
    return "xero.sales.read";
  }
  if (
    action.startsWith("xero.bills") ||
    action === "xero.accounts.list" ||
    action === "xero.bank_transactions.read" ||
    action === "xero.credit_notes.read" ||
    action === "xero.payments.read" ||
    action === "xero.reports.profit_and_loss" ||
    action === "xero.organisation.read" ||
    action === "xero.health" ||
    action === "xero.token_refresh"
  ) {
    return "xero.finance.read";
  }
  if (
    action.includes("create_draft") ||
    action === "xero.invoices.create" ||
    action === "xero.invoices.update_draft" ||
    action === "xero.invoices.approve" ||
    action === "xero.invoices.send" ||
    action === "xero.bills.create" ||
    action === "xero.credit_notes.create_draft" ||
    action === "xero.credit_notes.approve" ||
    action === "xero.payments.allocate" ||
    action === "xero.invoice.void"
  ) {
    return "xero.draft.write";
  }
  if (action === "xero.contacts.create") return "xero.contacts.write";
  if (action.startsWith("outlook.") || action.startsWith("mail.")) {
    const write = action.includes("write") || action.includes("send");
    return elvexMailboxCapability(context?.mailboxAddress, write);
  }
  return null;
}

export function elvexAllowsAction(
  role: CompanyRole | null,
  action: string,
  context?: { toolName?: string | null; mailboxAddress?: string | null },
): { allowed: boolean; capability: string | null; reason?: string } {
  const capability = mapActionToElvexCapability(action, context);
  if (capability === "engineer_or_company") {
    const allowed =
      elvexCan(role, "knowledge.engineer.read") || elvexCan(role, "knowledge.company.read");
    return {
      allowed,
      capability,
      reason: allowed ? undefined : "Elvex role cannot read company or engineer knowledge",
    };
  }
  if (capability) {
    const allowed = elvexCan(role, capability);
    return {
      allowed,
      capability,
      reason: allowed ? undefined : `Elvex role does not grant ${capability}`,
    };
  }
  if (
    action.startsWith("xero.") ||
    action.startsWith("outlook.") ||
    action.startsWith("mail.") ||
    action.startsWith("admin.") ||
    action.startsWith("mcp.")
  ) {
    return {
      allowed: false,
      capability: null,
      reason: "Elvex privileged action is not granted to this role",
    };
  }
  return { allowed: false, capability: null, reason: "unmapped" };
}

export const ELVEX_MCP_TOOL_CAPABILITIES: Record<string, ElvexCapability> = {
  search_elvex_email: "mail.info.read",
  get_elvex_email: "mail.info.read",
  send_elvex_email: "mail.info.write",
  manage_elvex_email: "mail.info.write",
  search_xero_invoices: "xero.sales.read",
  analyse_xero_sales: "xero.sales.read",
  search_xero_bills: "xero.finance.read",
  get_xero_financial_summary: "xero.finance.read",
  create_xero_draft_invoice: "xero.draft.write",
};
