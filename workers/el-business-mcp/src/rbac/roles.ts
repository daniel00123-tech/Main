import type { ElvexCapability } from "./capabilities";

export const ELVEX_ROLES = [
  "engineer",
  "office_staff",
  "finance_team",
  "operations_manager",
  "finance_manager",
  "director",
  "company_admin",
] as const;

export type ElvexRole = (typeof ELVEX_ROLES)[number];

export const ELVEX_ROLE_LABELS: Record<ElvexRole, string> = {
  engineer: "Engineer",
  office_staff: "Office Staff",
  finance_team: "Finance Team",
  operations_manager: "Operations Manager",
  finance_manager: "Finance Manager",
  director: "Director",
  company_admin: "Company Admin",
};

/**
 * Explicit capability grants. Higher operational seniority does not inherit
 * adjacent specialist access (e.g. Operations Manager does not get Finance mailbox
 * or full Xero finance read).
 */
const ENGINEER_CAPS: ElvexCapability[] = ["knowledge.engineer.read", "system.health"];

const OFFICE_STAFF_CAPS: ElvexCapability[] = [
  ...ENGINEER_CAPS,
  "knowledge.company.read",
  "mail.info.read",
  "mail.info.write",
  "calendar.info.read",
  "calendar.info.write",
  "directory.read",
];

const FINANCE_TEAM_CAPS: ElvexCapability[] = [
  ...OFFICE_STAFF_CAPS,
  "knowledge.finance.read",
  "mail.finance.read",
  "mail.finance.write",
  "calendar.finance.read",
  "calendar.finance.write",
  "xero.sales.read",
  "xero.finance.read",
];

const OPERATIONS_MANAGER_CAPS: ElvexCapability[] = [
  ...OFFICE_STAFF_CAPS,
  "xero.sales.read",
];

const FINANCE_MANAGER_CAPS: ElvexCapability[] = [
  ...FINANCE_TEAM_CAPS,
  "xero.draft.write",
  "xero.contacts.write",
  "xero.settings.read",
];

const DIRECTOR_CAPS: ElvexCapability[] = [
  ...FINANCE_MANAGER_CAPS,
  "knowledge.restricted.read",
  "admin.portal.access",
  "admin.users.manage",
  "admin.config.manage",
  "payment.info.access",
];

const COMPANY_ADMIN_CAPS: ElvexCapability[] = [
  ...DIRECTOR_CAPS,
  "admin.roles.manage",
];

export const ELVEX_ROLE_GRANTS: Record<ElvexRole, ReadonlySet<ElvexCapability>> = {
  engineer: new Set(ENGINEER_CAPS),
  office_staff: new Set(OFFICE_STAFF_CAPS),
  finance_team: new Set(FINANCE_TEAM_CAPS),
  operations_manager: new Set(OPERATIONS_MANAGER_CAPS),
  finance_manager: new Set(FINANCE_MANAGER_CAPS),
  director: new Set(DIRECTOR_CAPS),
  company_admin: new Set(COMPANY_ADMIN_CAPS),
};

/** Explicit denies win over grants. Currently unused by presets; reserved for overrides. */
export const ELVEX_ROLE_DENIES: Record<ElvexRole, ReadonlySet<ElvexCapability>> = {
  engineer: new Set(),
  office_staff: new Set(),
  finance_team: new Set(),
  operations_manager: new Set(),
  finance_manager: new Set(),
  director: new Set(),
  company_admin: new Set(),
};

export function isElvexRole(value: string | null | undefined): value is ElvexRole {
  return Boolean(value && (ELVEX_ROLES as readonly string[]).includes(value));
}

export function roleDisplayName(role: ElvexRole): string {
  return ELVEX_ROLE_LABELS[role];
}

export function capabilitiesForRole(role: ElvexRole): ElvexCapability[] {
  return [...ELVEX_ROLE_GRANTS[role]].sort();
}
