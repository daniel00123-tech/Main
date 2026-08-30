/**
 * Outlook mailbox Graph change notifications — distinct from drive/knowledge subscriptions.
 */

import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import {
  buildMicrosoftSubscriptionClientState,
  microsoftGraphNotificationUrl,
  MICROSOFT_SUBSCRIPTION_LIFETIME_MS,
  shouldReuseActiveGraphSubscription,
  verifyMicrosoftSubscriptionClientState,
} from "./microsoft-graph-subscriptions";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { createReplacingGraphSubscription, type MicrosoftGraphConfig } from "./microsoft-graph";
import { recordAuditEvent } from "./control-plane";

export function assessOutlookNotificationArchitecture(): {
  supported: boolean;
  resourceExample: string;
  changeTypes: string[];
  flow: string;
  governance: string[];
  implementationStatus: string;
  blocker: string | null;
} {
  return {
    supported: true,
    resourceExample: "/users/{mailboxUPN}/mailFolders('Inbox')/messages",
    changeTypes: ["created", "updated"],
    flow: "New/changed email → Graph notification → INFRA webhook → outlook mailbox sync → queue → Company Knowledge",
    governance: [
      "Separate resource_kind=mailbox in microsoft_graph_subscriptions",
      "Only included shared mailboxes may receive subscriptions",
      "Does not reuse OneDrive/SharePoint drive subscription rows",
      "Requires Mail.Read (Application) + Exchange Application RBAC scope",
    ],
    implementationStatus:
      "Mailbox subscription provisioning active for included outlook_shared sources.",
    blocker: null,
  };
}

function mailboxSubscriptionResource(mailboxAddress: string): string {
  return `/users/${encodeURIComponent(mailboxAddress)}/mailFolders('Inbox')/messages`;
}

function subscriptionExpirationIso(fromMs = Date.now()): string {
  return new Date(fromMs + MICROSOFT_SUBSCRIPTION_LIFETIME_MS).toISOString();
}

export async function ensureOutlookMailboxGraphSubscription(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    mailboxAddress: string;
    actor?: string;
    force?: boolean;
  },
): Promise<{ ok: boolean; subscriptionId?: string; error?: string; skipped?: string }> {
  const existing = await env.DB.prepare(
    `SELECT id, graph_subscription_id, expires_at, status FROM microsoft_graph_subscriptions
     WHERE source_id = ? AND company_id = ? AND resource_kind = 'mailbox' LIMIT 1`,
  )
    .bind(input.sourceId, input.companyId)
    .first<{
      id: string;
      graph_subscription_id: string | null;
      expires_at: string;
      status: string;
    }>();

  const reuse = shouldReuseActiveGraphSubscription({
    status: existing?.status,
    graphSubscriptionId: existing?.graph_subscription_id,
    expiresAt: existing?.expires_at,
    force: input.force,
  });
  if (reuse.reuse && existing?.graph_subscription_id) {
    return { ok: true, subscriptionId: existing.graph_subscription_id, skipped: "already_active" };
  }

  const token = await acquireMicrosoftAppToken(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
  });
  if (!token.ok) return { ok: false, error: token.message };

  const config: MicrosoftGraphConfig = {
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  };

  const notificationUrl = microsoftGraphNotificationUrl(env);
  const clientState = buildMicrosoftSubscriptionClientState(env, {
    companyId: input.companyId,
    sourceId: input.sourceId,
  });
  const resourcePath = mailboxSubscriptionResource(input.mailboxAddress);
  const expirationDateTime = subscriptionExpirationIso();

  try {
    const created = await createReplacingGraphSubscription(
      config,
      {
        resource: resourcePath,
        changeType: "created,updated",
        notificationUrl,
        expirationDateTime,
        clientState,
      },
      existing?.graph_subscription_id,
    );

    const rowId = existing?.id ?? newId("mgs");
    const now = nowIso();
    if (existing?.id) {
      await env.DB.prepare(
        `UPDATE microsoft_graph_subscriptions SET
          graph_subscription_id = ?, resource_path = ?, resource_kind = 'mailbox',
          notification_url = ?, client_state = ?, expires_at = ?, status = 'active',
          last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          created.id,
          resourcePath,
          notificationUrl,
          clientState,
          created.expirationDateTime ?? expirationDateTime,
          now,
          rowId,
        )
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO microsoft_graph_subscriptions (
          id, company_id, connector_instance_id, source_id, graph_subscription_id,
          resource_path, resource_kind, notification_url, client_state, expires_at, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'mailbox', ?, ?, ?, 'active', ?, ?)`,
      )
        .bind(
          rowId,
          input.companyId,
          input.connectorInstanceId,
          input.sourceId,
          created.id,
          resourcePath,
          notificationUrl,
          clientState,
          created.expirationDateTime ?? expirationDateTime,
          now,
          now,
        )
        .run();
    }

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "connector.changed",
      actor: input.actor ?? "system:outlook-graph-subscriptions",
      resourceType: "connector",
      resourceId: input.sourceId,
      detail: {
        stage: "outlook.graph.subscription.created",
        graphSubscriptionId: created.id,
        resourcePath,
        mailboxAddress: input.mailboxAddress,
      },
    });

    return { ok: true, subscriptionId: created.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Mailbox subscription failed" };
  }
}

export async function provisionOutlookMailboxGraphSubscriptions(env: Env): Promise<{
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
}> {
  const sources = await env.DB.prepare(
    `SELECT id, company_id, connector_instance_id, mailbox_address
     FROM microsoft_connector_sources
     WHERE inclusion_status = 'included' AND source_type = 'outlook_shared' AND mailbox_address IS NOT NULL`,
  ).all<{
    id: string;
    company_id: string;
    connector_instance_id: string;
    mailbox_address: string;
  }>();

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const source of sources.results ?? []) {
    const result = await ensureOutlookMailboxGraphSubscription(env, {
      companyId: source.company_id,
      connectorInstanceId: source.connector_instance_id,
      sourceId: source.id,
      mailboxAddress: source.mailbox_address,
      actor: "system:outlook-graph-provision",
    });
    if (result.skipped) skipped++;
    else if (result.ok) created++;
    else {
      failed++;
      if (result.error) errors.push(`${source.id}: ${result.error}`);
    }
  }

  return { created, skipped, failed, errors };
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
