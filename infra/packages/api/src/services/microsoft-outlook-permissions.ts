/**
 * Outlook shared mailbox permission assessment and admin-consent boundary detection.
 */

import type { Env } from "../env";
import {
  OUTLOOK_DISCOVERY_APP_PERMISSION,
  OUTLOOK_REQUIRED_APP_PERMISSION,
} from "@infra/shared";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { probeMailboxReadAccess, probeUserReadAllAccess } from "./microsoft-outlook-graph";

export type OutlookPermissionAssessment = {
  appConfigured: boolean;
  mailRead: {
    permission: typeof OUTLOOK_REQUIRED_APP_PERMISSION;
    permissionType: "Application";
    required: true;
    granted: boolean | null;
    probe: Awaited<ReturnType<typeof probeMailboxReadAccess>> | null;
  };
  userReadAll: {
    permission: typeof OUTLOOK_DISCOVERY_APP_PERMISSION;
    permissionType: "Application";
    required: false;
    granted: boolean | null;
    probe: Awaited<ReturnType<typeof probeUserReadAllAccess>> | null;
  };
  restrictionMechanism: {
    infraAllowlist: string;
    exchangePolicyRequired: string;
    exchangePolicyLegacy: string;
    exchangePolicyModern: string;
  };
  adminConsentRequired: boolean;
  adminConsentBlocker: string | null;
  entraSteps: string[];
  whatMailReadProvides: string;
  howInfraRestrictsDespiteBroadPermission: string;
};

export function outlookPermissionAssessmentTemplate(): Omit<
  OutlookPermissionAssessment,
  "appConfigured" | "mailRead" | "userReadAll" | "adminConsentRequired" | "adminConsentBlocker"
> {
  return {
    restrictionMechanism: {
      infraAllowlist:
        "INFRA only calls Graph for mailbox addresses stored in microsoft_connector_sources with source_type=outlook_shared AND inclusion_status=included for that company.",
      exchangePolicyRequired:
        "Microsoft grants Mail.Read (Application) tenant-wide by default. Daniel MUST additionally scope the app in Exchange Online so Graph cannot read unapproved mailboxes even if INFRA were misconfigured.",
      exchangePolicyLegacy:
        "New-ApplicationAccessPolicy -AppId <CLIENT_ID> -PolicyScopeGroupId <MailEnabledSecurityGroup> -AccessRight RestrictAccess",
      exchangePolicyModern:
        "RBAC for Applications: assign Application Mail.Read role to the service principal with a management scope limited to approved shared mailboxes (preferred long-term).",
    },
    entraSteps: [
      "Azure Portal → Microsoft Entra ID → App registrations → INFRA Microsoft 365 Connector app",
      "API permissions → Add a permission → Microsoft Graph → Application permissions",
      `Add ${OUTLOOK_REQUIRED_APP_PERMISSION} (Application)`,
      "Grant admin consent for the tenant",
      "Exchange Online PowerShell → restrict app to approved shared mailboxes via Application Access Policy or RBAC for Applications",
      "Add approved shared mailbox addresses to a mail-enabled security group used by the policy scope",
    ],
    whatMailReadProvides:
      "Allows the INFRA app (without a signed-in user) to read mail folders, messages, bodies, recipients, attachments and metadata in mailboxes the Exchange policy permits — by default ALL mailboxes until scoped.",
    howInfraRestrictsDespiteBroadPermission:
      "Defense in depth: (1) INFRA database allowlist — excluded by default, personal mailboxes never auto-included; (2) Exchange Application Access Policy or RBAC for Applications limiting the app to a mail-enabled security group of approved shared mailboxes; (3) company/tenant isolation on every API and MCP tool call.",
  };
}

export async function assessOutlookPermissions(
  env: Env,
  input?: { probeMailboxAddress?: string | null; companyId?: string; connectorInstanceId?: string },
): Promise<OutlookPermissionAssessment> {
  const template = outlookPermissionAssessmentTemplate();
  const token = await acquireMicrosoftAppToken(env, {
    companyId: input?.companyId,
    connectorInstanceId: input?.connectorInstanceId,
  });

  if (!token.ok) {
    return {
      appConfigured: false,
      mailRead: {
        permission: OUTLOOK_REQUIRED_APP_PERMISSION,
        permissionType: "Application",
        required: true,
        granted: null,
        probe: null,
      },
      userReadAll: {
        permission: OUTLOOK_DISCOVERY_APP_PERMISSION,
        permissionType: "Application",
        required: false,
        granted: null,
        probe: null,
      },
      adminConsentRequired: true,
      adminConsentBlocker: token.message,
      ...template,
    };
  }

  const config = { accessToken: token.accessToken, tenantId: token.tenantId };
  const userProbe = await probeUserReadAllAccess(config);
  const mailProbe = input?.probeMailboxAddress
    ? await probeMailboxReadAccess(config, input.probeMailboxAddress)
    : null;

  const mailReadGranted = mailProbe?.ok === true;
  const adminConsentRequired = !mailReadGranted;

  return {
    appConfigured: true,
    mailRead: {
      permission: OUTLOOK_REQUIRED_APP_PERMISSION,
      permissionType: "Application",
      required: true,
      granted: mailProbe ? mailReadGranted : null,
      probe: mailProbe,
    },
    userReadAll: {
      permission: OUTLOOK_DISCOVERY_APP_PERMISSION,
      permissionType: "Application",
      required: false,
      granted: userProbe.ok,
      probe: userProbe,
    },
    adminConsentRequired,
    adminConsentBlocker: adminConsentRequired
      ? mailProbe?.code === "MAIL_READ_DENIED"
        ? `${OUTLOOK_REQUIRED_APP_PERMISSION} (Application) admin consent and Exchange mailbox scoping required before live mailbox retrieval.`
        : `Unable to confirm ${OUTLOOK_REQUIRED_APP_PERMISSION}. Provide a probe mailbox address or grant admin consent.`
      : null,
    ...template,
  };
}
