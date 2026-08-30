import type { Env } from "../env";

export const DEFAULT_APPROVED_MAILBOXES = [
  "finance@elvexpropertyservices.com",
  "info@elvexpropertyservices.com",
] as const;

export const DEFAULT_PROTECTED_USER_HINTS = ["William", "Ella"] as const;

export const DEFAULT_SHAREPOINT_HOSTNAME = "elvexpropertyservicesltd.sharepoint.com";
export const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const DEFAULT_MAIL_DOMAIN = "elvexpropertyservices.com";

export const MICROSOFT_CONNECTOR_CODES = new Set([
  "sharepoint",
  "onedrive",
  "outlook_shared_mailbox",
  "outlook_calendar",
]);

/**
 * Conservative calendar policy for EL Business MCP.
 *
 * The Worker has no end-user / role permission layer that can distinguish
 * personal calendars from company calendars. Therefore:
 * - only approved shared-mailbox calendars are exposed
 * - personal staff calendars are never listed, searched, or mutated
 * - attendee resolution may use the directory, but events themselves
 *   stay scoped to finance@ and info@ unless EL_MS_CALENDAR_MAILBOXES is set
 */
export const CALENDAR_POLICY_SUMMARY =
  "Calendar access is limited to approved shared mailboxes (finance@ and info@ by default). Personal staff calendars are not exposed.";

export type ElMicrosoftConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  graphBaseUrl: string;
  sharePointHostname: string;
  approvedMailboxes: string[];
  calendarMailboxes: string[];
  protectedUserHints: string[];
  mailDomain: string;
};

function splitCsv(value: string | undefined, fallback: readonly string[]): string[] {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return [...fallback];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeMailbox(value: string): string {
  return value.trim().toLowerCase();
}

export function microsoftCredentialsPresent(env: Env): boolean {
  return Boolean(
    env.EL_MS_TENANT_ID?.trim() &&
      env.EL_MS_CLIENT_ID?.trim() &&
      env.EL_MS_CLIENT_SECRET?.trim()
  );
}

export function loadMicrosoftConfig(env: Env): ElMicrosoftConfig | null {
  if (!microsoftCredentialsPresent(env)) return null;
  const approvedMailboxes = splitCsv(env.EL_MS_APPROVED_MAILBOXES, DEFAULT_APPROVED_MAILBOXES).map(
    normalizeMailbox
  );
  const calendarMailboxes = splitCsv(env.EL_MS_CALENDAR_MAILBOXES, approvedMailboxes).map(
    normalizeMailbox
  );
  return {
    tenantId: env.EL_MS_TENANT_ID!.trim(),
    clientId: env.EL_MS_CLIENT_ID!.trim(),
    clientSecret: env.EL_MS_CLIENT_SECRET!.trim(),
    graphBaseUrl: (env.EL_MS_GRAPH_BASE_URL?.trim() || DEFAULT_GRAPH_BASE_URL).replace(/\/$/, ""),
    sharePointHostname: env.EL_MS_SHAREPOINT_HOSTNAME?.trim() || DEFAULT_SHAREPOINT_HOSTNAME,
    approvedMailboxes,
    calendarMailboxes,
    protectedUserHints: splitCsv(env.EL_MS_PROTECTED_USERS, DEFAULT_PROTECTED_USER_HINTS),
    mailDomain: env.EL_MS_MAIL_DOMAIN?.trim().toLowerCase() || DEFAULT_MAIL_DOMAIN,
  };
}

export function publicMicrosoftPolicy(config: ElMicrosoftConfig | null): {
  configured: boolean;
  approvedMailboxes: string[];
  calendarMailboxes: string[];
  protectedUserHints: string[];
  sharePointHostname: string | null;
  graphBaseUrl: string | null;
  calendarPolicy: string;
  tenantIdConfigured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
} {
  return {
    configured: Boolean(config),
    approvedMailboxes: config?.approvedMailboxes ?? [...DEFAULT_APPROVED_MAILBOXES],
    calendarMailboxes: config?.calendarMailboxes ?? [...DEFAULT_APPROVED_MAILBOXES],
    protectedUserHints: config?.protectedUserHints ?? [...DEFAULT_PROTECTED_USER_HINTS],
    sharePointHostname: config?.sharePointHostname ?? DEFAULT_SHAREPOINT_HOSTNAME,
    graphBaseUrl: config?.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL,
    calendarPolicy: CALENDAR_POLICY_SUMMARY,
    tenantIdConfigured: Boolean(config?.tenantId),
    clientIdConfigured: Boolean(config?.clientId),
    clientSecretConfigured: Boolean(config?.clientSecret),
  };
}
