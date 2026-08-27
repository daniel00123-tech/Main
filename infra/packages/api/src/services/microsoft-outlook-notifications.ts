/**
 * Outlook mailbox Graph change-notification assessment (distinct from drive/knowledge subscriptions).
 */

import type { Env } from "../env";
import { microsoftGraphNotificationUrl } from "./microsoft-graph-subscriptions";

export function assessOutlookNotificationArchitecture(): {
  supported: boolean;
  resourceExample: string;
  changeTypes: string[];
  flow: string;
  governance: string[];
  implementationStatus: string;
  blocker: string;
} {
  return {
    supported: true,
    resourceExample: "/users/{sharedMailboxUPN}/mailFolders('Inbox')/messages",
    changeTypes: ["created", "updated"],
    flow: "New/changed email → Graph notification → INFRA webhook → mailbox delta/state update (not knowledge indexing)",
    governance: [
      "Separate resource_kind=mailbox in microsoft_graph_subscriptions",
      "Only included shared mailboxes may receive subscriptions",
      "Does not reuse OneDrive/SharePoint drive subscription rows",
      "Requires Mail.Read (Application) — same admin consent boundary as READ tools",
    ],
    implementationStatus:
      "Architecture assessed and schema prepared (0028 resource_kind). Subscription provisioning deferred until Mail.Read admin consent is granted.",
    blocker: "Mail.Read (Application) admin consent + Exchange mailbox scoping required",
  };
}

export async function getOutlookNotificationStatus(
  env: Env,
  companyId: string,
): Promise<
  Array<{
    sourceId: string;
    mailboxAddress: string | null;
    status: string;
    graphSubscriptionId: string | null;
    expiresAt: string | null;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT s.source_id, s.status, s.graph_subscription_id, s.expires_at, src.mailbox_address
     FROM microsoft_graph_subscriptions s
     JOIN microsoft_connector_sources src ON src.id = s.source_id
     WHERE s.company_id = ? AND s.resource_kind = 'mailbox'`,
  )
    .bind(companyId)
    .all<{
      source_id: string;
      status: string;
      graph_subscription_id: string | null;
      expires_at: string | null;
      mailbox_address: string | null;
    }>();

  return (rows.results ?? []).map((row) => ({
    sourceId: row.source_id,
    mailboxAddress: row.mailbox_address,
    status: row.status,
    graphSubscriptionId: row.graph_subscription_id,
    expiresAt: row.expires_at,
  }));
}

export function outlookMailboxNotificationUrl(env: Env): string {
  return microsoftGraphNotificationUrl(env);
}
