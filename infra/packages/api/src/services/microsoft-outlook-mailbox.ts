/**
 * Outlook shared mailbox discovery and allowlist governance.
 */

import type { Env } from "../env";
import type { OutlookMailboxType } from "@infra/shared";
import { newId, nowIso } from "../db/mappers";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { recordAuditEvent } from "./control-plane";
import { listTenantMailUsers, type GraphTenantUser } from "./microsoft-outlook-graph";
import { assessOutlookPermissions } from "./microsoft-outlook-permissions";

export type DiscoveredOutlookMailbox = {
  graphUserId: string;
  mailboxAddress: string;
  displayName: string;
  userPrincipalName: string | null;
  mailboxType: OutlookMailboxType;
  suggestedDefaultInclusion: "excluded";
  classificationReason: string;
};

export function classifyOutlookMailbox(user: GraphTenantUser): {
  mailboxType: OutlookMailboxType;
  classificationReason: string;
  isPersonalLikely: boolean;
} {
  const upn = (user.userPrincipalName ?? user.mail ?? "").toLowerCase();
  const licenses = user.assignedLicenses?.length ?? 0;

  if (upn.includes("room") || upn.startsWith("room-")) {
    return {
      mailboxType: "room_mailbox",
      classificationReason: "UPN suggests room resource mailbox",
      isPersonalLikely: false,
    };
  }
  if (upn.includes("equipment")) {
    return {
      mailboxType: "equipment_mailbox",
      classificationReason: "UPN suggests equipment resource mailbox",
      isPersonalLikely: false,
    };
  }

  if (user.mail && licenses === 0 && user.accountEnabled !== false) {
    return {
      mailboxType: "shared_mailbox",
      classificationReason: "Mail-enabled user without assigned license (typical shared mailbox pattern)",
      isPersonalLikely: false,
    };
  }

  if (user.mail && licenses > 0) {
    return {
      mailboxType: "personal_mailbox",
      classificationReason: "Licensed user mailbox — personal/work mailbox, not auto-included",
      isPersonalLikely: true,
    };
  }

  return {
    mailboxType: "unknown",
    classificationReason: "Could not classify from Graph user properties alone",
    isPersonalLikely: true,
  };
}

export async function discoverOutlookMailboxes(
  env: Env,
  input: { companyId: string; connectorInstanceId: string; actor: string },
): Promise<{
  discovered: DiscoveredOutlookMailbox[];
  permissions: Awaited<ReturnType<typeof assessOutlookPermissions>>;
  verdict: string;
}> {
  const permissions = await assessOutlookPermissions(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
  });

  if (!permissions.userReadAll.granted) {
    return {
      discovered: [],
      permissions,
      verdict: permissions.adminConsentRequired
        ? "STOPPED_REQUIRES_USER_READ_ALL"
        : "STOPPED_MICROSOFT_NOT_CONFIGURED",
    };
  }

  const token = await acquireMicrosoftAppToken(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
  });
  if (!token.ok) {
    return { discovered: [], permissions, verdict: "STOPPED_TOKEN_DENIED" };
  }

  const users = await listTenantMailUsers({
    accessToken: token.accessToken,
    tenantId: token.tenantId,
  });

  const discovered: DiscoveredOutlookMailbox[] = [];
  for (const user of users) {
    const mailboxAddress = user.mail ?? user.userPrincipalName;
    if (!mailboxAddress || !user.id) continue;
    const classification = classifyOutlookMailbox(user);
    discovered.push({
      graphUserId: user.id,
      mailboxAddress,
      displayName: user.displayName ?? mailboxAddress,
      userPrincipalName: user.userPrincipalName,
      mailboxType: classification.mailboxType,
      suggestedDefaultInclusion: "excluded",
      classificationReason: classification.classificationReason,
    });
  }

  const now = nowIso();
  for (const mailbox of discovered) {
    const existing = await env.DB.prepare(
      `SELECT id FROM microsoft_connector_sources
       WHERE company_id = ? AND connector_instance_id = ? AND source_type = 'outlook_shared'
         AND mailbox_address = ? LIMIT 1`,
    )
      .bind(input.companyId, input.connectorInstanceId, mailbox.mailboxAddress)
      .first<{ id: string }>();

    if (existing?.id) {
      await env.DB.prepare(
        `UPDATE microsoft_connector_sources SET
          external_id = ?, display_name = ?, mailbox_type = ?, owner_upn = ?,
          metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          mailbox.graphUserId,
          mailbox.displayName,
          mailbox.mailboxType,
          mailbox.userPrincipalName,
          JSON.stringify({ classificationReason: mailbox.classificationReason }),
          now,
          existing.id,
        )
        .run();
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO microsoft_connector_sources (
        id, company_id, connector_instance_id, source_type, external_id, display_name,
        mailbox_address, mailbox_type, owner_upn, inclusion_status, sync_status,
        items_discovered, items_indexed, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'outlook_shared', ?, ?, ?, ?, ?, 'available', 'pending', 0, 0, ?, ?, ?)`,
    )
      .bind(
        newId("mss"),
        input.companyId,
        input.connectorInstanceId,
        mailbox.graphUserId,
        mailbox.displayName,
        mailbox.mailboxAddress,
        mailbox.mailboxType,
        mailbox.userPrincipalName,
        JSON.stringify({
          classificationReason: mailbox.classificationReason,
          suggestedDefaultInclusion: "excluded",
        }),
        now,
        now,
      )
      .run();
  }

  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "connector.discovery_completed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.connectorInstanceId,
    detail: {
      stage: "outlook.mailbox.discovery",
      discovered: discovered.length,
      sharedMailboxes: discovered.filter((m) => m.mailboxType === "shared_mailbox").length,
      personalMailboxes: discovered.filter((m) => m.mailboxType === "personal_mailbox").length,
    },
  });

  return { discovered, permissions, verdict: "DISCOVERY_COMPLETE" };
}

export async function resolveIncludedOutlookMailbox(
  env: Env,
  input: { companyId: string; mailboxAddress?: string | null; sourceId?: string | null },
): Promise<
  | {
      ok: true;
      sourceId: string;
      mailboxAddress: string;
      displayName: string;
      connectorInstanceId: string;
      mailboxType: string | null;
    }
  | { ok: false; code: string; message: string }
> {
  const row = input.sourceId
    ? await env.DB.prepare(
        `SELECT id, mailbox_address, display_name, connector_instance_id, mailbox_type, inclusion_status, company_id
         FROM microsoft_connector_sources WHERE id = ? LIMIT 1`,
      )
        .bind(input.sourceId)
        .first<{
          id: string;
          mailbox_address: string | null;
          display_name: string;
          connector_instance_id: string;
          mailbox_type: string | null;
          inclusion_status: string;
          company_id: string;
        }>()
    : await env.DB.prepare(
        `SELECT id, mailbox_address, display_name, connector_instance_id, mailbox_type, inclusion_status, company_id
         FROM microsoft_connector_sources
         WHERE company_id = ? AND source_type = 'outlook_shared' AND mailbox_address = ? LIMIT 1`,
      )
        .bind(input.companyId, input.mailboxAddress)
        .first<{
          id: string;
          mailbox_address: string | null;
          display_name: string;
          connector_instance_id: string;
          mailbox_type: string | null;
          inclusion_status: string;
          company_id: string;
        }>();

  if (!row?.id || !row.mailbox_address) {
    return { ok: false, code: "OUTLOOK_MAILBOX_NOT_FOUND", message: "Mailbox source not found" };
  }
  if (row.company_id !== input.companyId) {
    return { ok: false, code: "OUTLOOK_TENANT_ISOLATION", message: "Mailbox belongs to another company" };
  }
  if (row.inclusion_status !== "included") {
    return {
      ok: false,
      code: "OUTLOOK_MAILBOX_NOT_INCLUDED",
      message: "Mailbox is not explicitly included for READ access",
    };
  }
  if (row.mailbox_type === "personal_mailbox") {
    return {
      ok: false,
      code: "OUTLOOK_PERSONAL_MAILBOX_DENIED",
      message: "Personal mailboxes cannot be accessed unless explicitly reclassified and included by an administrator",
    };
  }

  return {
    ok: true,
    sourceId: row.id,
    mailboxAddress: row.mailbox_address,
    displayName: row.display_name,
    connectorInstanceId: row.connector_instance_id,
    mailboxType: row.mailbox_type,
  };
}

export async function setOutlookMailboxInclusion(
  db: D1Database,
  input: {
    companyId: string;
    sourceId: string;
    inclusionStatus: "included" | "excluded" | "available";
    actor: string;
    allowPersonalOverride?: boolean;
  },
): Promise<{ ok: boolean; message?: string }> {
  const source = await db
    .prepare(
      `SELECT display_name, mailbox_address, mailbox_type FROM microsoft_connector_sources
       WHERE id = ? AND company_id = ? AND source_type = 'outlook_shared' LIMIT 1`,
    )
    .bind(input.sourceId, input.companyId)
    .first<{
      display_name: string;
      mailbox_address: string | null;
      mailbox_type: string | null;
    }>();

  if (!source) return { ok: false, message: "Outlook mailbox source not found" };
  if (
    input.inclusionStatus === "included" &&
    source.mailbox_type === "personal_mailbox" &&
    !input.allowPersonalOverride
  ) {
    return {
      ok: false,
      message:
        "Personal mailboxes are excluded by default. Explicit administrator override is required.",
    };
  }

  await db
    .prepare(
      `UPDATE microsoft_connector_sources SET inclusion_status = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
    )
    .bind(input.inclusionStatus, nowIso(), input.sourceId, input.companyId)
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "connector.changed",
    actor: input.actor,
    resourceType: "connector",
    resourceId: input.sourceId,
    detail: {
      stage:
        input.inclusionStatus === "included"
          ? "outlook.mailbox.included"
          : input.inclusionStatus === "excluded"
            ? "outlook.mailbox.excluded"
            : "outlook.mailbox.available",
      mailboxAddress: source.mailbox_address,
      mailboxType: source.mailbox_type,
    },
  });

  return { ok: true };
}
