import type { CapabilityRiskClass, CompanyRole, ConnectorCapability } from "../types";

/** MCP tool / action identifiers grouped by domain. */
export type ToolAction =
  // Read (LOW_RISK)
  | "knowledge.search"
  | "knowledge.read"
  | "system.health"
  | "bigchange.jobs.read"
  | "bigchange.jobs.read_assigned"
  | "bigchange.engineers.read"
  | "bigchange.engineers.schedule.read"
  | "bigchange.customers.read"
  | "bigchange.invoices.read"
  | "bigchange.purchase_orders.read"
  | "commusoft.jobs.read"
  | "commusoft.customers.read"
  | "xero.invoices.read"
  | "xero.invoices.search"
  | "xero.invoices.get"
  | "xero.contacts.read"
  | "xero.contacts.search"
  | "xero.organisation.read"
  | "xero.accounts.list"
  | "xero.credit_notes.read"
  | "xero.payments.read"
  | "xero.bank_transactions.read"
  // Write (WRITE / FINANCIAL_ACTION)
  | "bigchange.jobs.create"
  | "bigchange.jobs.update"
  | "bigchange.jobs.book_engineer"
  | "bigchange.notes.create"
  | "bigchange.purchase_orders.create"
  | "bigchange.invoices.create"
  | "bigchange.invoices.update"
  | "commusoft.jobs.create"
  | "commusoft.quotes.send"
  | "xero.invoices.create"
  | "xero.invoices.create_draft"
  | "xero.invoices.update_draft"
  | "xero.invoices.send"
  // High risk
  | "bigchange.jobs.delete"
  | "bigchange.invoices.delete"
  | "bigchange.batch.update"
  | "commusoft.batch.send";

export interface RolePreset {
  role: CompanyRole;
  displayName: string;
  description: string;
  allowedActions: ToolAction[];
  deniedByDefault: ToolAction[];
}

/** Default permission presets — companies can override per role in v0.2+. */
export const COMPANY_ROLE_PRESETS: RolePreset[] = [
  {
    role: "engineer",
    displayName: "Engineer",
    description:
      "Field staff. Read own schedule and assigned jobs. Add job notes. No financial or booking writes.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.jobs.read_assigned",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "commusoft.jobs.read",
    ],
    deniedByDefault: [
      "bigchange.jobs.book_engineer",
      "bigchange.jobs.create",
      "bigchange.purchase_orders.create",
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "xero.invoices.create",
      "commusoft.quotes.send",
      "bigchange.batch.update",
    ],
  },
  {
    role: "junior_office",
    displayName: "Junior Office",
    description:
      "Junior office staff. Search knowledge and read customers/jobs. Limited notes only.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "commusoft.customers.read",
      "commusoft.jobs.read",
      "xero.contacts.read",
    ],
    deniedByDefault: [
      "bigchange.jobs.book_engineer",
      "bigchange.jobs.create",
      "bigchange.purchase_orders.create",
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "xero.invoices.create",
    ],
  },
  {
    role: "office_staff",
    displayName: "Office Staff",
    description:
      "Office staff. Read/write jobs and bookings. Create POs. No invoice creation above threshold.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.jobs.create",
      "bigchange.jobs.update",
      "bigchange.jobs.book_engineer",
      "bigchange.engineers.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "bigchange.purchase_orders.create",
      "bigchange.purchase_orders.read",
      "commusoft.jobs.read",
      "commusoft.customers.read",
      "xero.contacts.read",
      "xero.contacts.search",
      "xero.invoices.read",
      "xero.invoices.search",
      "xero.organisation.read",
    ],
    deniedByDefault: [
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "bigchange.invoices.delete",
      "xero.invoices.create",
      "xero.invoices.create_draft",
      "xero.invoices.send",
      "commusoft.quotes.send",
      "bigchange.batch.update",
    ],
  },
  {
    role: "supervisor",
    displayName: "Supervisor",
    description:
      "Team supervisor. Broader read access. Book engineers. Create invoices with limits.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.jobs.create",
      "bigchange.jobs.update",
      "bigchange.jobs.book_engineer",
      "bigchange.engineers.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "bigchange.purchase_orders.create",
      "bigchange.purchase_orders.read",
      "bigchange.invoices.read",
      "bigchange.invoices.create",
      "commusoft.jobs.read",
      "commusoft.customers.read",
      "xero.invoices.read",
      "xero.invoices.search",
      "xero.contacts.read",
      "xero.organisation.read",
    ],
    deniedByDefault: [
      "bigchange.invoices.delete",
      "bigchange.jobs.delete",
      "bigchange.batch.update",
      "commusoft.batch.send",
    ],
  },
  {
    role: "manager",
    displayName: "Manager",
    description:
      "Department manager. Full operational read/write including invoices and quote sends.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.jobs.create",
      "bigchange.jobs.update",
      "bigchange.jobs.book_engineer",
      "bigchange.engineers.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "bigchange.purchase_orders.create",
      "bigchange.purchase_orders.read",
      "bigchange.invoices.read",
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "commusoft.jobs.read",
      "commusoft.customers.read",
      "commusoft.quotes.send",
      "xero.invoices.read",
      "xero.invoices.search",
      "xero.invoices.get",
      "xero.invoices.create",
      "xero.invoices.create_draft",
      "xero.contacts.read",
      "xero.contacts.search",
      "xero.organisation.read",
      "xero.accounts.list",
      "xero.credit_notes.read",
      "xero.payments.read",
      "xero.bank_transactions.read",
    ],
    deniedByDefault: ["bigchange.jobs.delete", "bigchange.invoices.delete", "bigchange.batch.update"],
  },
  {
    role: "director",
    displayName: "Director",
    description:
      "Company director. Broad access including financial actions. Batch and delete may require approval.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.jobs.create",
      "bigchange.jobs.update",
      "bigchange.jobs.book_engineer",
      "bigchange.engineers.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "bigchange.purchase_orders.create",
      "bigchange.purchase_orders.read",
      "bigchange.invoices.read",
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "commusoft.jobs.read",
      "commusoft.customers.read",
      "commusoft.quotes.send",
      "xero.invoices.read",
      "xero.invoices.search",
      "xero.invoices.get",
      "xero.invoices.create",
      "xero.invoices.create_draft",
      "xero.invoices.update_draft",
      "xero.contacts.read",
      "xero.organisation.read",
      "xero.accounts.list",
      "xero.credit_notes.read",
      "xero.payments.read",
      "xero.bank_transactions.read",
    ],
    deniedByDefault: ["bigchange.jobs.delete", "bigchange.invoices.delete"],
  },
  {
    role: "company_admin",
    displayName: "Company Admin",
    description:
      "Company administrator (e.g. Charlie). Connector setup, user management, billing. Not platform owner.",
    allowedActions: [
      "knowledge.search",
      "knowledge.read",
      "system.health",
      "bigchange.customers.read",
      "bigchange.jobs.read",
      "bigchange.jobs.create",
      "bigchange.jobs.update",
      "bigchange.jobs.book_engineer",
      "bigchange.engineers.read",
      "bigchange.engineers.schedule.read",
      "bigchange.notes.create",
      "bigchange.purchase_orders.create",
      "bigchange.purchase_orders.read",
      "bigchange.invoices.read",
      "bigchange.invoices.create",
      "bigchange.invoices.update",
      "commusoft.jobs.read",
      "commusoft.customers.read",
      "commusoft.quotes.send",
      "xero.invoices.read",
      "xero.invoices.search",
      "xero.invoices.get",
      "xero.invoices.create",
      "xero.invoices.create_draft",
      "xero.invoices.update_draft",
      "xero.contacts.read",
      "xero.contacts.search",
      "xero.organisation.read",
      "xero.accounts.list",
      "xero.credit_notes.read",
      "xero.payments.read",
      "xero.bank_transactions.read",
    ],
    deniedByDefault: ["bigchange.batch.update", "commusoft.batch.send"],
  },
];

/** Maps tool actions to capability + risk for enforcement. */
export const TOOL_ACTION_RISK: Record<
  ToolAction,
  { capability: ConnectorCapability; riskClass: CapabilityRiskClass }
> = {
  "knowledge.search": { capability: "search", riskClass: "low_risk" },
  "knowledge.read": { capability: "read", riskClass: "low_risk" },
  "system.health": { capability: "read", riskClass: "low_risk" },
  "bigchange.jobs.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.jobs.read_assigned": { capability: "read", riskClass: "low_risk" },
  "bigchange.engineers.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.engineers.schedule.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.customers.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.invoices.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.purchase_orders.read": { capability: "read", riskClass: "low_risk" },
  "commusoft.jobs.read": { capability: "read", riskClass: "low_risk" },
  "commusoft.customers.read": { capability: "read", riskClass: "low_risk" },
  "xero.invoices.read": { capability: "read", riskClass: "low_risk" },
  "xero.invoices.search": { capability: "search", riskClass: "low_risk" },
  "xero.invoices.get": { capability: "read", riskClass: "low_risk" },
  "xero.contacts.read": { capability: "read", riskClass: "low_risk" },
  "xero.contacts.search": { capability: "search", riskClass: "low_risk" },
  "xero.organisation.read": { capability: "read", riskClass: "low_risk" },
  "xero.accounts.list": { capability: "read", riskClass: "low_risk" },
  "xero.credit_notes.read": { capability: "read", riskClass: "low_risk" },
  "xero.payments.read": { capability: "read", riskClass: "low_risk" },
  "xero.bank_transactions.read": { capability: "read", riskClass: "low_risk" },
  "bigchange.jobs.create": { capability: "create", riskClass: "write" },
  "bigchange.jobs.update": { capability: "update", riskClass: "write" },
  "bigchange.jobs.book_engineer": { capability: "update", riskClass: "write" },
  "bigchange.notes.create": { capability: "create", riskClass: "write" },
  "bigchange.purchase_orders.create": { capability: "create", riskClass: "write" },
  "bigchange.invoices.create": { capability: "create", riskClass: "financial_action" },
  "bigchange.invoices.update": { capability: "update", riskClass: "financial_action" },
  "commusoft.jobs.create": { capability: "create", riskClass: "write" },
  "commusoft.quotes.send": { capability: "send", riskClass: "external_send" },
  "xero.invoices.create": { capability: "create", riskClass: "financial_action" },
  "xero.invoices.create_draft": { capability: "create", riskClass: "financial_action" },
  "xero.invoices.update_draft": { capability: "update", riskClass: "financial_action" },
  "xero.invoices.send": { capability: "send", riskClass: "external_send" },
  "bigchange.jobs.delete": { capability: "delete", riskClass: "delete" },
  "bigchange.invoices.delete": { capability: "delete", riskClass: "delete" },
  "bigchange.batch.update": { capability: "batch", riskClass: "batch_write" },
  "commusoft.batch.send": { capability: "batch", riskClass: "batch_write" },
};

export function getRolePreset(role: CompanyRole): RolePreset | undefined {
  return COMPANY_ROLE_PRESETS.find((p) => p.role === role);
}

export function isActionAllowed(role: CompanyRole, action: ToolAction): boolean {
  const preset = getRolePreset(role);
  if (!preset) return false;
  if (preset.deniedByDefault.includes(action)) return false;
  return preset.allowedActions.includes(action);
}
