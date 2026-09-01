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
import { newId, nowIso } from "../db/mappers";

const ELVEX_EMAIL_READ_TOOLS = ["search_elvex_email", "get_elvex_email"] as const;

function isWriteLikeTool(name: string): boolean {
  return /send|write|delete|draft|manage|create|update|reply/i.test(name);
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

  const query =
    typeof input.arguments.query === "string" && input.arguments.query.trim()
      ? input.arguments.query.trim()
      : input.toolName === "outlook_list_messages"
        ? "newest"
        : "";
  const limit = Number(input.arguments.limit ?? input.arguments.top ?? 5);

  const forwarded: Record<string, unknown> = {
    mailbox: mailbox.mailboxAddress,
    mailboxAddress: mailbox.mailboxAddress,
    folder: typeof input.arguments.folderName === "string" ? input.arguments.folderName : "inbox",
    folderName: typeof input.arguments.folderName === "string" ? input.arguments.folderName : "inbox",
    limit,
    top: limit,
  };
  if (query) forwarded.query = query;
  if (typeof input.arguments.messageId === "string") forwarded.messageId = input.arguments.messageId;
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

  return {
    ok: true,
    result: {
      mailboxAddress: mailbox.mailboxAddress,
      via: "company_mcp",
      toolName: forwardName,
      result: "data" in execution ? execution.data?.result : undefined,
    },
  };
}
