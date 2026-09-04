/**
 * Live EL mailbox access probe — independent of the ingestion scheduler.
 * Never prints secrets. Subjects/timestamps only for message lists.
 */

import { ELVEX_COMPANY_ID, isElvexCompany } from "@infra/shared";
import type { Env } from "../env";
import { acquireMicrosoftAppToken, microsoftCredentialStatus } from "./microsoft-auth";
import { loadMicrosoftConnectorBinding, parseStoredMicrosoftCredentialFields } from "./microsoft-credentials";
import { resolveConnectorCredentialForExecution } from "./connector-credentials";
import {
  getMessageAttachmentContent,
  listMailboxMessages,
  listMessageAttachments,
} from "./microsoft-outlook-graph";
import { executeCompanyMcpOutlookRead } from "./microsoft-outlook-company-mcp";
import { discoverEntraTenantIdFromDomain, resolveOutlookGraphAccess } from "./outlook-graph-access";
import { discoverCompanyUserMailboxes, listCompanyMailboxRegistry } from "./mailbox-registry";
import { resolveMailboxIngestionPolicy } from "./mailbox-ingestion-policy";
import { listMcpEnvironments } from "./control-plane";

const COMPANY_ID = ELVEX_COMPANY_ID;
const TARGETS = [
  "michael@elvexpropertyservices.com",
  "sharon@elvexpropertyservices.com",
  "lauren@elvexpropertyservices.com",
  "info@elvexpropertyservices.com",
  "finance@elvexpropertyservices.com",
] as const;

export type PathVerdict = "PASS" | "FAIL" | "SKIP";

export type MailboxPathProbe = {
  path: "graph_app_only" | "company_mcp" | "delegated_shared" | "mailbox_connector";
  auth: PathVerdict;
  listMessages: PathVerdict;
  listAttachments: PathVerdict;
  getBytes: PathVerdict;
  detail: string;
  messageCount?: number;
  latestTimestamp?: string | null;
  attachmentSubjects?: Array<{ subject: string | null; received: string | null; hasAttachments: boolean }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function summariseMessages(
  rows: Array<{ subject?: string | null; receivedDateTime?: string | null; sentDateTime?: string | null; hasAttachments?: boolean }>,
): {
  count: number;
  latestTimestamp: string | null;
  attachmentSubjects: Array<{ subject: string | null; received: string | null; hasAttachments: boolean }>;
} {
  const latest = rows
    .map((row) => row.receivedDateTime || row.sentDateTime || null)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  return {
    count: rows.length,
    latestTimestamp: latest,
    attachmentSubjects: rows
      .filter((row) => row.hasAttachments)
      .map((row) => ({
        subject: row.subject ?? null,
        received: row.receivedDateTime || row.sentDateTime || null,
        hasAttachments: true,
      })),
  };
}

export async function probeFreshGraphToken(env: Env, actor: string): Promise<Record<string, unknown>> {
  const status = microsoftCredentialStatus(env);
  const binding = await loadMicrosoftConnectorBinding(env.DB, { companyId: COMPANY_ID });
  const envTenant = String(env.MICROSOFT_TENANT_ID ?? "").trim() || null;
  const envClient = String(env.MICROSOFT_CLIENT_ID ?? "").trim() || null;
  const domainTenant = await discoverEntraTenantIdFromDomain("elvexpropertyservices.com");
  let storedClientId: string | null = null;
  if (binding?.credentialRefId) {
    const resolved = await resolveConnectorCredentialForExecution({
      env,
      companyId: COMPANY_ID,
      instanceId: binding.instanceId,
      actor,
      reason: "execution",
    }).catch(() => null);
    if (resolved && resolved.ok) {
      storedClientId = parseStoredMicrosoftCredentialFields(resolved.payload).clientId;
    }
  }
  const access = await resolveOutlookGraphAccess(env, {
    companyId: COMPANY_ID,
    mailboxAddress: "finance@elvexpropertyservices.com",
    actor,
    bypassCache: true,
  });
  const companyToken = await acquireMicrosoftAppToken(env, {
    companyId: COMPANY_ID,
    actor,
    bypassCache: true,
  });
  const domainToken = domainTenant
    ? await acquireMicrosoftAppToken(env, { tenantId: domainTenant, actor, bypassCache: true })
    : { ok: false as const, code: "TENANT_UNDISCOVERED", message: "EL domain tenant was not discoverable" };

  const fail = !access.ok ? access : !domainToken.ok ? domainToken : null;
  return {
    result: access.ok ? "PASS" : "FAIL",
    freshRequest: true,
    environment: String(env.ENVIRONMENT ?? "unknown"),
    platformTenantId: envTenant,
    platformClientId: envClient,
    domainDiscoveredTenantId: domainTenant,
    companyBindingTenantId: binding?.tenantId ?? null,
    companyBindingAuthMode: binding?.authMode ?? null,
    companyBindingInstanceId: binding?.instanceId ?? null,
    storedCompanyClientId: storedClientId,
    runtimeTenantUsed: access.ok ? access.tenantId : domainTenant,
    runtimeClientUsed: access.ok ? access.clientId ?? envClient : envClient,
    authority: `https://login.microsoftonline.com/${access.ok ? access.tenantId : domainTenant ?? envTenant ?? "unknown"}`,
    tokenEndpoint: `https://login.microsoftonline.com/${access.ok ? access.tenantId : domainTenant ?? envTenant ?? "unknown"}/oauth2/v2.0/token`,
    companyTokenCode: companyToken.ok ? "OK" : companyToken.code,
    companyTokenMessage: companyToken.ok ? null : companyToken.message,
    httpStatus: fail && "httpStatus" in fail ? fail.httpStatus ?? null : access.ok ? 200 : null,
    aadError: fail && "aadError" in fail ? fail.aadError ?? null : null,
    aadErrorCodes: fail && "aadErrorCodes" in fail ? fail.aadErrorCodes ?? [] : [],
    correlationId: fail && "correlationId" in fail ? fail.correlationId ?? null : null,
    traceId: fail && "traceId" in fail ? fail.traceId ?? null : null,
    timestamp: fail && "timestamp" in fail ? fail.timestamp ?? new Date().toISOString() : new Date().toISOString(),
    tokenUrl: fail && "tokenUrl" in fail ? fail.tokenUrl ?? null : null,
    source: access.ok ? access.source : "none",
    platformConfigured: status.configured,
    clientIdMatchesPrevious: envClient === "e5fd0533-ce51-43b8-999c-152f1e268246",
    tenantMatchesEl: (access.ok ? access.tenantId : domainTenant) === "af32e619-3647-44a2-85d9-1c45457c0e91",
    message: access.ok ? "Fresh app-only token acquired" : access.message,
    secretRotated: false,
    microsoftReconnected: false,
  };
}

async function probeGraphPath(
  env: Env,
  mailboxAddress: string,
  actor: string,
): Promise<MailboxPathProbe> {
  const access = await resolveOutlookGraphAccess(env, { companyId: COMPANY_ID, mailboxAddress, actor, bypassCache: true });
  if (!access.ok) {
    return {
      path: "graph_app_only",
      auth: "FAIL",
      listMessages: "FAIL",
      listAttachments: "FAIL",
      getBytes: "FAIL",
      detail: `${access.code}: ${access.message}`,
    };
  }
  const config = { accessToken: access.accessToken, tenantId: access.tenantId };
  try {
    const listed = await listMailboxMessages(config, { mailboxAddress, top: 50 });
    const summary = summariseMessages(listed);
    const withAtt = listed.find((row) => row.hasAttachments && row.id);
    if (!withAtt?.id) {
      return {
        path: "graph_app_only",
        auth: "PASS",
        listMessages: "PASS",
        listAttachments: listed.length ? "PASS" : "SKIP",
        getBytes: "SKIP",
        detail: listed.length ? "List succeeded; no attachment-bearing message in top 50" : "List succeeded; mailbox empty in page",
        messageCount: summary.count,
        latestTimestamp: summary.latestTimestamp,
        attachmentSubjects: summary.attachmentSubjects,
      };
    }
    const attachments = await listMessageAttachments(config, mailboxAddress, withAtt.id);
    if (!attachments[0]?.id) {
      return {
        path: "graph_app_only",
        auth: "PASS",
        listMessages: "PASS",
        listAttachments: attachments.length ? "PASS" : "FAIL",
        getBytes: "FAIL",
        detail: "Attachment list empty on a hasAttachments=true message",
        messageCount: summary.count,
        latestTimestamp: summary.latestTimestamp,
        attachmentSubjects: summary.attachmentSubjects,
      };
    }
    const content = await getMessageAttachmentContent(config, mailboxAddress, withAtt.id, attachments[0].id);
    return {
      path: "graph_app_only",
      auth: "PASS",
      listMessages: "PASS",
      listAttachments: "PASS",
      getBytes: content.contentBytes ? "PASS" : "FAIL",
      detail: content.contentBytes ? "Graph list/attachments/bytes succeeded" : "Graph bytes empty",
      messageCount: summary.count,
      latestTimestamp: summary.latestTimestamp,
      attachmentSubjects: summary.attachmentSubjects,
    };
  } catch (err) {
    return {
      path: "graph_app_only",
      auth: "PASS",
      listMessages: "FAIL",
      listAttachments: "FAIL",
      getBytes: "FAIL",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeMcpPath(
  env: Env,
  mailboxAddress: string,
  actor: string,
): Promise<MailboxPathProbe> {
  const listed = await executeCompanyMcpOutlookRead(env, {
    companyId: COMPANY_ID,
    toolName: "outlook_list_messages",
    arguments: { mailboxAddress, mailbox: mailboxAddress, limit: 50 },
    actor,
  });
  if (!listed.ok) {
    return {
      path: "company_mcp",
      auth: /401|TOKEN|reconnect/i.test(listed.code) ? "FAIL" : "PASS",
      listMessages: "FAIL",
      listAttachments: "FAIL",
      getBytes: "FAIL",
      detail: `${listed.code}: ${listed.message}`,
    };
  }
  const record = asRecord(listed.result);
  const rows = Array.isArray(record?.messages) ? record!.messages : [];
  const mapped = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({
      id: asText(row.id),
      subject: asText(row.subject) || null,
      receivedDateTime: asText(row.receivedDateTime) || null,
      hasAttachments: Boolean(row.hasAttachments),
    }));
  const summary = summariseMessages(mapped);
  const withAtt = mapped.find((row) => row.hasAttachments && row.id);
  if (!withAtt?.id) {
    return {
      path: "company_mcp",
      auth: "PASS",
      listMessages: rows.length > 0 ? "PASS" : "FAIL",
      listAttachments: "SKIP",
      getBytes: "SKIP",
      detail: rows.length
        ? "MCP list succeeded; no attachment-bearing message in page"
        : "MCP list returned zero messages",
      messageCount: summary.count,
      latestTimestamp: summary.latestTimestamp,
      attachmentSubjects: summary.attachmentSubjects,
    };
  }
  const attachments = await executeCompanyMcpOutlookRead(env, {
    companyId: COMPANY_ID,
    toolName: "outlook_list_attachments",
    arguments: { mailboxAddress, mailbox: mailboxAddress, messageId: withAtt.id },
    actor,
  });
  const expanded = attachments.ok
    ? attachments
    : await executeCompanyMcpOutlookRead(env, {
        companyId: COMPANY_ID,
        toolName: "outlook_get_message",
        arguments: {
          mailboxAddress,
          mailbox: mailboxAddress,
          messageId: withAtt.id,
          includeAttachments: true,
          expand: "attachments",
        },
        actor,
      });
  const attRecord = expanded.ok ? asRecord(expanded.result) : null;
  const attRows = Array.isArray(attRecord?.attachments) ? attRecord!.attachments : [];
  const first = attRows.map((row) => asRecord(row)).find((row) => row && asText(row.id));
  if (!first) {
    return {
      path: "company_mcp",
      auth: "PASS",
      listMessages: "PASS",
      listAttachments: "FAIL",
      getBytes: "FAIL",
      detail: "MCP could not enumerate attachments",
      messageCount: summary.count,
      latestTimestamp: summary.latestTimestamp,
      attachmentSubjects: summary.attachmentSubjects,
    };
  }
  const bytes = await executeCompanyMcpOutlookRead(env, {
    companyId: COMPANY_ID,
    toolName: "outlook_get_attachment",
    arguments: {
      mailboxAddress,
      mailbox: mailboxAddress,
      messageId: withAtt.id,
      attachmentId: asText(first.id),
    },
    actor,
  });
  const byteRecord = bytes.ok ? asRecord(bytes.result) : null;
  const encoded = asText(byteRecord?.contentBytesBase64) || asText(byteRecord?.contentBytes);
  return {
    path: "company_mcp",
    auth: "PASS",
    listMessages: "PASS",
    listAttachments: "PASS",
    getBytes: encoded ? "PASS" : "FAIL",
    detail: encoded ? "MCP list/attachments/bytes succeeded" : "MCP attachment bytes unavailable",
    messageCount: summary.count,
    latestTimestamp: summary.latestTimestamp,
    attachmentSubjects: summary.attachmentSubjects,
  };
}

export async function probeElMailboxLiveAccess(
  env: Env,
  input?: { actor?: string; windowFrom?: Date; windowTo?: Date },
): Promise<Record<string, unknown>> {
  const actor = input?.actor ?? "system:el-mailbox-live-access";
  const windowFrom = input?.windowFrom ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const windowTo = input?.windowTo ?? new Date();
  const token = await probeFreshGraphToken(env, actor);
  const discovered = await discoverCompanyUserMailboxes(env, COMPANY_ID);
  const registry = await listCompanyMailboxRegistry(env.DB, COMPANY_ID);
  const mcp = (await listMcpEnvironments(env.DB, COMPANY_ID)).find((item) => item.enabled);
  const connector = await env.DB.prepare(
    `SELECT id, name, connector_definition_id, auth_status, health_status
     FROM connector_instances
     WHERE company_id = ? AND (
       connector_definition_id IN ('conn_microsoft_365', 'conn_outlook_shared')
       OR lower(name) LIKE '%outlook%' OR lower(name) LIKE '%microsoft%'
     )`,
  )
    .bind(COMPANY_ID)
    .all<{ id: string; name: string; connector_definition_id: string; auth_status: string; health_status: string }>();

  const mailboxes: Record<string, unknown>[] = [];
  for (const address of TARGETS) {
    const user = discovered.find((row) => row.mailboxAddress.toLowerCase() === address);
    const row = registry.find((item) => item.mailbox_address.toLowerCase() === address);
    const policy = await resolveMailboxIngestionPolicy(env.DB, COMPANY_ID, {
      mailboxAddress: address,
      displayName: user?.displayName ?? row?.display_name,
      userId: user?.userId ?? row?.mailbox_id,
      mailboxId: row?.mailbox_id ?? user?.userId,
    });
    const graph = await probeGraphPath(env, address, actor);
    const mcpPath = await probeMcpPath(env, address, actor);
    const sharedDelegated: MailboxPathProbe = {
      path: "delegated_shared",
      auth: mcpPath.auth,
      listMessages: /info@|finance@/i.test(address) ? mcpPath.listMessages : mcpPath.listMessages,
      listAttachments: mcpPath.listAttachments,
      getBytes: mcpPath.getBytes,
      detail: /info@|finance@/i.test(address)
        ? `Shared-mailbox control path via existing EL Outlook MCP (${mcpPath.detail})`
        : `Same MCP argument shape as info/finance (${mcpPath.detail})`,
      messageCount: mcpPath.messageCount,
      latestTimestamp: mcpPath.latestTimestamp,
      attachmentSubjects: mcpPath.attachmentSubjects,
    };
    const connectorPath: MailboxPathProbe = {
      path: "mailbox_connector",
      auth: (connector.results ?? []).some((item) => item.auth_status === "connected") ? "PASS" : "FAIL",
      listMessages: mcpPath.listMessages,
      listAttachments: mcpPath.listAttachments,
      getBytes: mcpPath.getBytes,
      detail: `ci_el_outlook / ${mcp?.serviceBindingRef ?? "no MCP"} — ${mcpPath.detail}`,
      messageCount: mcpPath.messageCount,
      latestTimestamp: mcpPath.latestTimestamp,
      attachmentSubjects: mcpPath.attachmentSubjects,
    };
    mailboxes.push({
      mailboxAddress: address,
      displayName: user?.displayName ?? row?.display_name ?? null,
      userId: user?.userId ?? row?.mailbox_id ?? null,
      mailboxType: row?.mailbox_type ?? (/info@|finance@/i.test(address) ? "shared_mailbox" : "user_mailbox"),
      active: Boolean(user) || Boolean(row),
      tenant: "af32e619-3647-44a2-85d9-1c45457c0e91",
      companyId: COMPANY_ID,
      graphAccessible: graph.listMessages === "PASS",
      mcpAccessible: mcpPath.listMessages === "PASS",
      chatSearchEnabled: row?.enabled_for_mail_search === 1,
      ingestionEligible: policy.effective === "INCLUDE",
      effectivePolicy: policy.effective,
      policyReason: policy.reason,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      liveList: {
        graphCount: graph.messageCount ?? 0,
        mcpCount: mcpPath.messageCount ?? 0,
        latest: graph.latestTimestamp || mcpPath.latestTimestamp || null,
        attachmentBearing: [
          ...(graph.attachmentSubjects ?? []),
          ...(mcpPath.attachmentSubjects ?? []),
        ],
      },
      paths: [graph, mcpPath, sharedDelegated, connectorPath],
    });
  }

  return {
    companyId: COMPANY_ID,
    elvexCompany: isElvexCompany({ id: COMPANY_ID }),
    token,
    discoveredUsers: discovered.map((row) => ({
      mailboxAddress: row.mailboxAddress,
      displayName: row.displayName,
      role: row.role,
    })),
    registry: registry.map((row) => ({
      mailboxAddress: row.mailbox_address,
      mailboxType: row.mailbox_type,
      enabledForMailSearch: row.enabled_for_mail_search === 1,
      enabledForAttachmentIngestion: row.enabled_for_attachment_ingestion === 1,
      status: row.status,
      lastScanAt: row.last_attachment_scan_at,
      lastError: row.last_error,
      lastCheckpoint: row.last_checkpoint,
    })),
    connectors: connector.results ?? [],
    mcp: mcp
      ? { id: mcp.id, endpointUrl: mcp.endpointUrl, serviceBindingRef: mcp.serviceBindingRef, enabled: mcp.enabled }
      : null,
    mailboxes,
  };
}
