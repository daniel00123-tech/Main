/**
 * Microsoft Graph change notifications — near-real-time delta sync trigger.
 * Notifications enqueue delta discovery only; queue handles per-file ingestion.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../env";
import { newId, nowIso } from "../db/mappers";
import { acquireMicrosoftAppToken, resolveMicrosoftTenantId } from "./microsoft-auth";
import {
  createGraphSubscription,
  deleteGraphSubscription,
  renewGraphSubscription,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import { syncMicrosoftSource } from "./microsoft-sync";
import { recordAuditEvent } from "./control-plane";

export const MICROSOFT_GRAPH_WEBHOOK_PATH = "/api/webhooks/microsoft/graph";

/** Max subscription lifetime for drive root resources (~4230 minutes). Renew before expiry. */
export const MICROSOFT_SUBSCRIPTION_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;

export type GraphNotificationPayload = {
  value?: Array<{
    subscriptionId?: string;
    clientState?: string;
    resource?: string;
    changeType?: string;
    tenantId?: string;
  }>;
};

export function microsoftGraphNotificationUrl(env: Env): string {
  const base = (env.INFRA_PUBLIC_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(
    /\/$/,
    "",
  );
  return `${base}${MICROSOFT_GRAPH_WEBHOOK_PATH}`;
}

export function buildMicrosoftSubscriptionClientState(
  env: Env,
  input: { companyId: string; sourceId: string },
): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`microsoft-graph-sub:${input.companyId}:${input.sourceId}`)
    .digest("hex");
}

export function verifyMicrosoftSubscriptionClientState(
  env: Env,
  input: { companyId: string; sourceId: string; clientState: string },
): boolean {
  const expected = buildMicrosoftSubscriptionClientState(env, input);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(input.clientState));
  } catch {
    return false;
  }
}

function subscriptionResourceForDrive(driveId: string): string {
  return `/drives/${driveId}/root`;
}

function subscriptionExpirationIso(fromMs = Date.now()): string {
  return new Date(fromMs + MICROSOFT_SUBSCRIPTION_LIFETIME_MS).toISOString();
}

export async function ensureMicrosoftGraphSubscription(
  env: Env,
  input: {
    companyId: string;
    connectorInstanceId: string;
    sourceId: string;
    driveId: string;
    actor?: string;
  },
): Promise<{ ok: boolean; subscriptionId?: string; error?: string; skipped?: string }> {
  const existing = await env.DB.prepare(
    `SELECT id, graph_subscription_id, expires_at, status FROM microsoft_graph_subscriptions
     WHERE source_id = ? AND company_id = ? LIMIT 1`,
  )
    .bind(input.sourceId, input.companyId)
    .first<{
      id: string;
      graph_subscription_id: string | null;
      expires_at: string;
      status: string;
    }>();

  const expiresAtMs = existing?.expires_at ? Date.parse(existing.expires_at) : 0;
  if (
    existing?.graph_subscription_id &&
    existing.status === "active" &&
    expiresAtMs > Date.now() + 12 * 60 * 60 * 1000
  ) {
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
  const resourcePath = subscriptionResourceForDrive(input.driveId);
  const expirationDateTime = subscriptionExpirationIso();

  try {
    if (existing?.graph_subscription_id) {
      try {
        await deleteGraphSubscription(config, existing.graph_subscription_id);
      } catch {
        // Stale subscription — Graph may have already expired it.
      }
    }

    const created = await createGraphSubscription(config, {
      resource: resourcePath,
      changeType: "updated",
      notificationUrl,
      expirationDateTime,
      clientState,
    });

    const rowId = existing?.id ?? newId("mgs");
    const now = nowIso();
    if (existing?.id) {
      await env.DB.prepare(
        `UPDATE microsoft_graph_subscriptions SET
          graph_subscription_id = ?, resource_path = ?, notification_url = ?, client_state = ?,
          expires_at = ?, status = 'active', last_error = NULL, updated_at = ?
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
          resource_path, notification_url, client_state, expires_at, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
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
      actor: input.actor ?? "system:microsoft-graph-subscriptions",
      resourceType: "connector",
      resourceId: input.sourceId,
      detail: {
        stage: "microsoft.graph.subscription.created",
        graphSubscriptionId: created.id,
        resourcePath,
        expiresAt: created.expirationDateTime ?? expirationDateTime,
      },
    });

    return { ok: true, subscriptionId: created.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Subscription creation failed";
    const rowId = existing?.id ?? newId("mgs");
    const now = nowIso();
    if (existing?.id) {
      await env.DB.prepare(
        `UPDATE microsoft_graph_subscriptions SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(message, now, rowId)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO microsoft_graph_subscriptions (
          id, company_id, connector_instance_id, source_id, resource_path,
          notification_url, client_state, expires_at, status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
      )
        .bind(
          rowId,
          input.companyId,
          input.connectorInstanceId,
          input.sourceId,
          resourcePath,
          notificationUrl,
          clientState,
          expirationDateTime,
          message,
          now,
          now,
        )
        .run();
    }
    return { ok: false, error: message };
  }
}

export async function renewExpiringMicrosoftGraphSubscriptions(env: Env): Promise<{
  renewed: number;
  failed: number;
  errors: string[];
}> {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.company_id, s.connector_instance_id, s.source_id, s.graph_subscription_id,
            src.external_id AS drive_id
     FROM microsoft_graph_subscriptions s
     JOIN microsoft_connector_sources src ON src.id = s.source_id
     WHERE s.status = 'active'
       AND s.graph_subscription_id IS NOT NULL
       AND s.expires_at <= datetime('now', '+24 hours')
       AND src.inclusion_status = 'included'`,
  ).all<{
    id: string;
    company_id: string;
    connector_instance_id: string;
    source_id: string;
    graph_subscription_id: string;
    drive_id: string;
  }>();

  let renewed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows.results ?? []) {
    const token = await acquireMicrosoftAppToken(env, {
      companyId: row.company_id,
      connectorInstanceId: row.connector_instance_id,
    });
    if (!token.ok) {
      failed++;
      errors.push(`${row.source_id}: ${token.message}`);
      continue;
    }

    const config: MicrosoftGraphConfig = {
      accessToken: token.accessToken,
      tenantId: token.tenantId,
    };
    const expirationDateTime = subscriptionExpirationIso();

    try {
      const updated = await renewGraphSubscription(
        config,
        row.graph_subscription_id,
        expirationDateTime,
      );
      await env.DB.prepare(
        `UPDATE microsoft_graph_subscriptions SET expires_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
      )
        .bind(updated.expirationDateTime ?? expirationDateTime, nowIso(), row.id)
        .run();
      renewed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Renewal failed";
      errors.push(`${row.source_id}: ${message}`);
      await env.DB.prepare(
        `UPDATE microsoft_graph_subscriptions SET status = 'expired', last_error = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(message, nowIso(), row.id)
        .run();
      await ensureMicrosoftGraphSubscription(env, {
        companyId: row.company_id,
        connectorInstanceId: row.connector_instance_id,
        sourceId: row.source_id,
        driveId: row.drive_id,
        actor: "system:microsoft-graph-renewal",
      });
    }
  }

  return { renewed, failed, errors };
}

export async function provisionMicrosoftGraphSubscriptionsForIncludedSources(env: Env): Promise<{
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
}> {
  const sources = await env.DB.prepare(
    `SELECT id, company_id, connector_instance_id, external_id, source_type, inclusion_status
     FROM microsoft_connector_sources
     WHERE inclusion_status = 'included'
       AND source_type IN ('onedrive', 'sharepoint')`,
  ).all<{
    id: string;
    company_id: string;
    connector_instance_id: string;
    external_id: string;
    source_type: string;
  }>();

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const source of sources.results ?? []) {
    const result = await ensureMicrosoftGraphSubscription(env, {
      companyId: source.company_id,
      connectorInstanceId: source.connector_instance_id,
      sourceId: source.id,
      driveId: source.external_id,
      actor: "system:microsoft-graph-provision",
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

export async function handleMicrosoftGraphNotification(
  env: Env,
  payload: GraphNotificationPayload,
): Promise<{ processed: number; ignored: number; errors: string[] }> {
  let processed = 0;
  let ignored = 0;
  const errors: string[] = [];

  for (const notification of payload.value ?? []) {
    const graphSubscriptionId = notification.subscriptionId;
    if (!graphSubscriptionId || !notification.clientState) {
      ignored++;
      continue;
    }

    const sub = await env.DB.prepare(
      `SELECT s.id, s.company_id, s.connector_instance_id, s.source_id, s.client_state,
              src.inclusion_status
       FROM microsoft_graph_subscriptions s
       JOIN microsoft_connector_sources src ON src.id = s.source_id
       WHERE s.graph_subscription_id = ? LIMIT 1`,
    )
      .bind(graphSubscriptionId)
      .first<{
        id: string;
        company_id: string;
        connector_instance_id: string;
        source_id: string;
        client_state: string;
        inclusion_status: string;
      }>();

    if (!sub) {
      ignored++;
      continue;
    }

    if (
      !verifyMicrosoftSubscriptionClientState(env, {
        companyId: sub.company_id,
        sourceId: sub.source_id,
        clientState: notification.clientState,
      }) ||
      notification.clientState !== sub.client_state
    ) {
      errors.push(`Invalid clientState for subscription ${graphSubscriptionId}`);
      ignored++;
      continue;
    }

    if (sub.inclusion_status !== "included") {
      ignored++;
      continue;
    }

    await env.DB.prepare(
      `UPDATE microsoft_graph_subscriptions SET last_notification_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), nowIso(), sub.id)
      .run();

    try {
      await syncMicrosoftSource(env, {
        companyId: sub.company_id,
        connectorInstanceId: sub.connector_instance_id,
        sourceId: sub.source_id,
        actor: "system:microsoft-graph-notification",
        useDelta: true,
        maxFiles: 50,
      });
      processed++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "Delta sync failed");
    }
  }

  return { processed, ignored, errors };
}

/** Persist tenant ID on connector instance when discovered (multi-tenant readiness). */
export async function ensureConnectorMicrosoftTenant(
  env: Env,
  input: { companyId: string; connectorInstanceId: string },
): Promise<string | null> {
  const tenantId = await resolveMicrosoftTenantId(env, env.DB, input);
  if (!tenantId) return null;

  await env.DB.prepare(
    `UPDATE connector_instances SET microsoft_tenant_id = ?, updated_at = ?
     WHERE id = ? AND company_id = ? AND (microsoft_tenant_id IS NULL OR microsoft_tenant_id = '')`,
  )
    .bind(tenantId, nowIso(), input.connectorInstanceId, input.companyId)
    .run();

  return tenantId;
}

export async function getMicrosoftGraphSubscriptionStatus(
  env: Env,
  companyId: string,
): Promise<
  Array<{
    sourceId: string;
    status: string;
    graphSubscriptionId: string | null;
    expiresAt: string | null;
    lastNotificationAt: string | null;
    lastError: string | null;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT source_id, status, graph_subscription_id, expires_at, last_notification_at, last_error
     FROM microsoft_graph_subscriptions WHERE company_id = ? ORDER BY updated_at DESC`,
  )
    .bind(companyId)
    .all<{
      source_id: string;
      status: string;
      graph_subscription_id: string | null;
      expires_at: string | null;
      last_notification_at: string | null;
      last_error: string | null;
    }>();

  return (rows.results ?? []).map((row) => ({
    sourceId: row.source_id,
    status: row.status,
    graphSubscriptionId: row.graph_subscription_id,
    expiresAt: row.expires_at,
    lastNotificationAt: row.last_notification_at,
    lastError: row.last_error,
  }));
}
