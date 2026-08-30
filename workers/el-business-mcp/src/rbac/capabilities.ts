/**
 * Explicit Elvex capabilities. Read and write are separate.
 * Do not collapse these into a single "finance_access" boolean.
 */

export const ELVEX_CAPABILITIES = [
  "knowledge.engineer.read",
  "knowledge.company.read",
  "knowledge.finance.read",
  "knowledge.restricted.read",
  "mail.info.read",
  "mail.info.write",
  "mail.finance.read",
  "mail.finance.write",
  "calendar.info.read",
  "calendar.info.write",
  "calendar.finance.read",
  "calendar.finance.write",
  "directory.read",
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

export const SENSITIVE_CAPABILITIES: ReadonlySet<ElvexCapability> = new Set([
  "knowledge.restricted.read",
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
]);

export const CONFIRMATION_REQUIRED_CAPABILITIES: ReadonlySet<ElvexCapability> = new Set([
  "xero.draft.write",
  "xero.contacts.write",
  "admin.roles.manage",
  "admin.config.manage",
  "payment.info.access",
]);

export const WRITE_CAPABILITIES: ReadonlySet<ElvexCapability> = new Set([
  "mail.info.write",
  "mail.finance.write",
  "calendar.info.write",
  "calendar.finance.write",
  "xero.draft.write",
  "xero.contacts.write",
  "admin.users.manage",
  "admin.roles.manage",
  "admin.config.manage",
  "payment.info.access",
]);

export function isElvexCapability(value: string): value is ElvexCapability {
  return (ELVEX_CAPABILITIES as readonly string[]).includes(value);
}
