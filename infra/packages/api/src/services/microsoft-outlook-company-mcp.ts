/**
 * Company-MCP Outlook read fallback.
 * Used when INFRA has no Graph mailbox sources for the company (Elvex)
 * but the downstream MCP already owns the Microsoft mailbox connection.
 */

import {
  ELVEX_INFO_MAILBOXES,
  isElvexCompany,
  resolveElvexConfiguredMailbox,
} from "@infra/shared";
import type { Env } from "../env";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { listMcpTools } from "./mcp-client";
import { unwrapToolPayload } from "./mcp-knowledge-standard";
import { newId, nowIso } from "../db/mappers";

const ELVEX_EMAIL_READ_TOOLS = ["search_elvex_email", "get_elvex_email"] as const;

function isWriteLikeTool(name: string): boolean {
  return /send|write|delete|draft|manage|create|update|reply/i.test(name);
}

export function isOutlookGetTool(name: string): boolean {
  return /get.*message|get.*email|get.*mail|fetch.*message|read.*message|read.*email/i.test(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatOutlookFrom(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.address === "string" && record.address.trim()) {
    return record.name ? `${record.name} <${record.address}>` : record.address;
  }
  const nested = asRecord(record.emailAddress);
  if (nested && typeof nested.address === "string" && nested.address.trim()) {
    return nested.name ? `${nested.name} <${nested.address}>` : nested.address;
  }
  return asNonEmptyString(record.email) || asNonEmptyString(record.fromAddress) || null;
}

function pickMessageBody(raw: Record<string, unknown>): { body: string; bodyContentType: string | null } {
  const nested = asRecord(raw.body);
  const body =
    asNonEmptyString(raw.bodyContent) ||
    asNonEmptyString(raw.content) ||
    asNonEmptyString(raw.text) ||
    asNonEmptyString(raw.html) ||
    (nested ? asNonEmptyString(nested.content) || asNonEmptyString(nested.text) : "") ||
    asNonEmptyString(raw.body);
  const bodyContentType =
    asNonEmptyString(raw.bodyContentType) ||
    (nested ? asNonEmptyString(nested.contentType) : "") ||
    null;
  return { body, bodyContentType: bodyContentType || null };
}

export function composeOutlookMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const id =
    asNonEmptyString(raw.id) ||
    asNonEmptyString(raw.messageId) ||
    asNonEmptyString(raw.graphId) ||
    asNonEmptyString(raw.internetMessageId);
  const { body, bodyContentType } = pickMessageBody(raw);
  const bodyPreview =
    asNonEmptyString(raw.bodyPreview) ||
    asNonEmptyString(raw.preview) ||
    asNonEmptyString(raw.snippet) ||
    body.slice(0, 240);
  return {
    id,
    internetMessageId: asNonEmptyString(raw.internetMessageId) || asNonEmptyString(raw.internet_message_id) || id,
    subject: asNonEmptyString(raw.subject) || asNonEmptyString(raw.title) || null,
    from: formatOutlookFrom(raw.from ?? raw.sender ?? raw.fromAddress),
    to: raw.to ?? raw.toRecipients ?? [],
    cc: raw.cc ?? raw.ccRecipients ?? [],
    receivedDateTime: asNonEmptyString(raw.receivedDateTime) || asNonEmptyString(raw.received) || asNonEmptyString(raw.date) || null,
    sentDateTime: asNonEmptyString(raw.sentDateTime) || null,
    conversationId: asNonEmptyString(raw.conversationId) || null,
    hasAttachments: Boolean(raw.hasAttachments),
    body,
    bodyPreview,
    bodyContentType,
    webLink: asNonEmptyString(raw.webLink) || asNonEmptyString(raw.webUrl) || null,
  };
}

export function unwrapOutlookMessage(upstream: unknown): Record<string, unknown> | null {
  if (typeof upstream === "string" && upstream.trim()) {
    const parsed = unwrapToolPayload(upstream);
    if (parsed !== upstream) return unwrapOutlookMessage(parsed);
    return { body: upstream, bodyContentType: /<\/?[a-z][\s\S]*>/i.test(upstream) ? "html" : "text" };
  }
  const unwrapped = unwrapToolPayload(upstream);
  const record = asRecord(unwrapped);
  if (!record) return null;
  const nested =
    asRecord(record.message) ||
    asRecord(record.email) ||
    asRecord(record.item) ||
    asRecord(record.value) ||
    (Array.isArray(record.messages) ? asRecord(record.messages[0]) : null) ||
    (Array.isArray(record.emails) ? asRecord(record.emails[0]) : null) ||
    (Array.isArray(record.value) ? asRecord(record.value[0]) : null) ||
    (Array.isArray(record.items) ? asRecord(record.items[0]) : null);
  if (nested) return nested;
  if (
    asNonEmptyString(record.id) ||
    asNonEmptyString(record.subject) ||
    asNonEmptyString(record.body) ||
    asNonEmptyString(record.bodyPreview) ||
    asRecord(record.body)
  ) {
    return record;
  }
  return null;
}

export function mapOutlookGetArgs(args: Record<string, unknown>): Record<string, unknown> {
  const messageId =
    asNonEmptyString(args.messageId) ||
    asNonEmptyString(args.message_id) ||
    asNonEmptyString(args.emailId) ||
    asNonEmptyString(args.email_id) ||
    asNonEmptyString(args.id) ||
    asNonEmptyString(args.documentRef);
  const internetMessageId = asNonEmptyString(args.internetMessageId);
  return {
    messageId,
    id: messageId,
    emailId: messageId,
    email_id: messageId,
    message_id: messageId,
    internetMessageId: internetMessageId || undefined,
    documentRef: messageId,
    query: messageId,
  };
}

export function composeOutlookGetResult(
  upstream: unknown,
  mailboxAddress: string,
): Record<string, unknown> {
  const raw = unwrapOutlookMessage(upstream);
  if (!raw) {
    const unwrapped = unwrapToolPayload(upstream);
    const record = asRecord(unwrapped);
    return {
      mailboxAddress,
      count: 0,
      messages: [],
      via: "company_mcp",
      upstreamType: unwrapped == null ? "null" : Array.isArray(unwrapped) ? "array" : typeof unwrapped,
      upstreamKeys: record ? Object.keys(record).slice(0, 20) : undefined,
      upstreamPreview: typeof unwrapped === "string" ? unwrapped.slice(0, 160) : undefined,
    };
  }
  const message = composeOutlookMessage(raw);
  return {
    mailboxAddress,
    count: message.id || message.body || message.subject ? 1 : 0,
    messages: message.id || message.body || message.subject ? [message] : [],
    message,
    id: message.id,
    subject: message.subject,
    from: message.from,
    receivedDateTime: message.receivedDateTime,
    body: message.body,
    bodyPreview: message.bodyPreview,
    bodyContentType: message.bodyContentType,
    hasAttachments: message.hasAttachments,
    webLink: message.webLink,
    via: "company_mcp",
  };
}

export function composeOutlookListResult(
  upstream: unknown,
  mailboxAddress: string,
): Record<string, unknown> {
  const unwrapped = unwrapToolPayload(upstream);
  const record = asRecord(unwrapped);
  const rawMessages = Array.isArray(record?.messages)
    ? record!.messages
    : Array.isArray(record?.emails)
      ? record!.emails
      : Array.isArray(record?.value)
        ? record!.value
        : Array.isArray(record?.results)
          ? record!.results
          : Array.isArray(record?.items)
            ? record!.items
            : Array.isArray(record?.data)
              ? record!.data
              : Array.isArray(unwrapped)
                ? unwrapped
                : [];
  const messages = rawMessages
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => composeOutlookMessage(item));
  return {
    mailboxAddress,
    count: messages.length,
    messages,
    via: "company_mcp",
  };
}

function pickCompanyOutlookTool(
  available: string[],
  desired: string,
): string | null {
  const names = new Set(available);
  if (desired === "outlook_get_message") {
    if (names.has("get_elvex_email")) return "get_elvex_email";
    const match = available.find((name) => /email|outlook|mailbox|mail/i.test(name) && /get|read|fetch/i.test(name) && !isWriteLikeTool(name));
    return match ?? null;
  }
  if (desired === "outlook_search_mailbox" || desired === "outlook_list_messages") {
    if (names.has("search_elvex_email")) return "search_elvex_email";
    if (desired === "outlook_list_messages" && names.has("outlook_list_messages")) {
      return "outlook_list_messages";
    }
    if (names.has("outlook_search_mailbox")) return "outlook_search_mailbox";
    const match = available.find(
      (name) => /email|outlook|mailbox|mail/i.test(name) && /search|list/i.test(name) && !isWriteLikeTool(name),
    );
    return match ?? null;
  }
  return null;
}

async function ensureEmailToolsAllowlisted(
  db: D1Database,
  companyId: string,
  mcpEnvironmentId: string,
  toolNames: string[],
): Promise<void> {
  const now = nowIso();
  for (const toolName of toolNames) {
    if (isWriteLikeTool(toolName)) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_allowlist
          (id, company_id, mcp_environment_id, tool_name, risk_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'low_risk', 1, ?, ?)`,
      )
      .bind(newId("allow"), companyId, mcpEnvironmentId, toolName, now, now)
      .run();
  }
}

export async function companyHasMcpOutlookConnection(
  db: D1Database,
  companyId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM connector_instances
       WHERE company_id = ? AND (
         connector_definition_id = 'conn_outlook_shared'
         OR lower(name) LIKE '%outlook%'
       ) AND auth_status = 'connected'
       LIMIT 1`,
    )
    .bind(companyId)
    .first();
  return Boolean(row?.id);
}

export function resolveCompanyOutlookMailbox(input: {
  companyId: string;
  mailboxAddress?: string | null;
}): { ok: true; mailboxAddress: string } | { ok: false; code: string; message: string } {
  if (isElvexCompany({ id: input.companyId })) {
    const resolved =
      resolveElvexConfiguredMailbox(input.mailboxAddress) ?? ELVEX_INFO_MAILBOXES[0];
    if (!resolved) {
      return { ok: false, code: "OUTLOOK_MAILBOX_NOT_FOUND", message: "Mailbox source not found" };
    }
    return { ok: true, mailboxAddress: resolved };
  }
  if (input.mailboxAddress?.trim()) {
    return { ok: true, mailboxAddress: input.mailboxAddress.trim() };
  }
  return { ok: false, code: "OUTLOOK_MAILBOX_NOT_FOUND", message: "Mailbox source not found" };
}

export async function executeCompanyMcpOutlookRead(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; code: string; message: string }> {
  const mailbox = resolveCompanyOutlookMailbox({
    companyId: input.companyId,
    mailboxAddress:
      typeof input.arguments.mailboxAddress === "string"
        ? input.arguments.mailboxAddress
        : typeof input.arguments.mailbox === "string"
          ? input.arguments.mailbox
          : null,
  });
  if (!mailbox.ok) return { ok: false, status: 404, ...mailbox };

  const mcp = (await listMcpEnvironments(env.DB, input.companyId)).find((item) => item.enabled);
  if (!mcp) {
    return {
      ok: false,
      status: 503,
      code: "OUTLOOK_MCP_UNAVAILABLE",
      message: "Business MCP unavailable",
    };
  }

  let listedNames: string[] = [];
  try {
    const listed = await listMcpTools(env, mcp.endpointUrl, mcp.authSecretRef, mcp.serviceBindingRef);
    listedNames = listed.tools.map((tool) => tool.name);
  } catch {
    listedNames = [...ELVEX_EMAIL_READ_TOOLS];
  }

  const forwardName =
    pickCompanyOutlookTool(listedNames, input.toolName) ??
    (input.toolName === "outlook_get_message" ? "get_elvex_email" : "search_elvex_email");

  if (isWriteLikeTool(forwardName)) {
    return {
      ok: false,
      status: 403,
      code: "OUTLOOK_WRITE_DENIED",
      message: "Outlook write tools are not available on this read path",
    };
  }

  await ensureEmailToolsAllowlisted(env.DB, input.companyId, mcp.id, [
    forwardName,
    ...ELVEX_EMAIL_READ_TOOLS,
  ]);

  const isGet = isOutlookGetTool(input.toolName) || isOutlookGetTool(forwardName);
  const query =
    typeof input.arguments.query === "string" && input.arguments.query.trim()
      ? input.arguments.query.trim()
      : "";
  const limit = Number(input.arguments.limit ?? input.arguments.top ?? 5);
  const getArgs = isGet ? mapOutlookGetArgs(input.arguments) : input.arguments;

  const forwarded: Record<string, unknown> = {
    mailbox: mailbox.mailboxAddress,
  };
  if (!isGet) {
    forwarded.folder = typeof input.arguments.folderName === "string" ? input.arguments.folderName : "inbox";
    forwarded.limit = limit;
    if (query && input.toolName !== "outlook_list_messages") forwarded.query = query;
  } else {
    Object.assign(forwarded, getArgs, { mailbox: mailbox.mailboxAddress });
  }
  if (typeof input.arguments.conversationId === "string") {
    forwarded.conversationId = input.arguments.conversationId;
  }

  const execution = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: forwardName,
    arguments: forwarded,
    actorUserId: input.actorUserId ?? "system",
    actorEmail: input.actor,
    sourceClient: "infra-outlook",
    skipUsageRecording: true,
  });

  if (execution.status !== 200) {
    const raw = execution.error ?? "";
    const status = execution.status;
    if (status === 401 || /401|unauthorized|invalid.?grant|token/i.test(raw)) {
      return {
        ok: false,
        status: 401,
        code: "OUTLOOK_NEEDS_RECONNECT",
        message: "Outlook needs reconnecting",
      };
    }
    if (status === 403) {
      return {
        ok: false,
        status: 403,
        code: "OUTLOOK_GRAPH_FORBIDDEN",
        message: "Microsoft denied mailbox access",
      };
    }
    if (status === 404) {
      return {
        ok: false,
        status: 404,
        code: "OUTLOOK_MAILBOX_NOT_FOUND",
        message: "Outlook mailbox is not available",
      };
    }
    return {
      ok: false,
      status: status >= 400 && status < 600 ? status : 502,
      code: "OUTLOOK_MCP_UPSTREAM",
      message: "Microsoft temporarily rejected the request",
    };
  }

  const upstream = "data" in execution ? execution.data?.result : undefined;
  let composed =
    isGet
      ? composeOutlookGetResult(upstream, mailbox.mailboxAddress)
      : composeOutlookListResult(upstream, mailbox.mailboxAddress);

  if (
    !isGet &&
    input.toolName === "outlook_list_messages" &&
    Number(composed.count ?? 0) === 0 &&
    !query
  ) {
    const relisted = await executeRegisteredMcpTool(env, {
      mcpId: mcp.id,
      toolName: forwardName,
      arguments: {
        ...forwarded,
        query: "received>=2020-01-01",
        newest: true,
      },
      actorUserId: input.actorUserId ?? "system",
      actorEmail: input.actor,
      sourceClient: "infra-outlook",
      skipUsageRecording: true,
    });
    if (relisted.status === 200) {
      composed = composeOutlookListResult(
        "data" in relisted ? relisted.data?.result : undefined,
        mailbox.mailboxAddress,
      );
    }
  }

  if (isGet && Number(composed.count ?? 0) === 0 && typeof forwarded.messageId === "string") {
    const searchName =
      pickCompanyOutlookTool(listedNames, "outlook_search_mailbox") ?? "search_elvex_email";
    if (!isWriteLikeTool(searchName)) {
      const searched = await executeRegisteredMcpTool(env, {
        mcpId: mcp.id,
        toolName: searchName,
        arguments: {
          mailbox: mailbox.mailboxAddress,
          query: forwarded.messageId,
          limit: 5,
        },
        actorUserId: input.actorUserId ?? "system",
        actorEmail: input.actor,
        sourceClient: "infra-outlook",
        skipUsageRecording: true,
      });
      if (searched.status === 200) {
        const listed = composeOutlookListResult(
          "data" in searched ? searched.data?.result : undefined,
          mailbox.mailboxAddress,
        );
        const wanted = String(forwarded.messageId);
        const match = (Array.isArray(listed.messages) ? listed.messages : []).find((row) => {
          const record = asRecord(row);
          if (!record) return false;
          return [record.id, record.messageId, record.internetMessageId].some(
            (value) => typeof value === "string" && value === wanted,
          );
        });
        if (match) {
          composed = composeOutlookGetResult(match, mailbox.mailboxAddress);
        }
      }
    }
  }

  return {
    ok: true,
    result: {
      ...composed,
      via: "company_mcp",
      toolName: forwardName,
    },
  };
}
