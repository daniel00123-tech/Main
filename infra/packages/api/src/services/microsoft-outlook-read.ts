/**
 * Outlook shared mailbox READ execution — live retrieval only (no knowledge indexing).
 */

import type { Env } from "../env";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { assessOutlookPermissions } from "./microsoft-outlook-permissions";
import { resolveIncludedOutlookMailbox } from "./microsoft-outlook-mailbox";
import {
  companyHasMcpOutlookConnection,
  executeCompanyMcpOutlookRead,
} from "./microsoft-outlook-company-mcp";
import {
  formatOutlookProvenance,
  getMailboxMessage,
  getMessageAttachmentContent,
  isOutlookAttachmentRetrievable,
  listConversationMessages,
  listMailboxFolders,
  listMailboxMessages,
  listMessageAttachments,
  searchMailboxMessages,
  type GraphMailMessageDetail,
} from "./microsoft-outlook-graph";
import { MicrosoftGraphError } from "./microsoft-graph";
import { recordAuditEvent } from "./control-plane";

function formatAddress(addr: { emailAddress?: { address?: string; name?: string } } | null): string | null {
  if (!addr?.emailAddress?.address) return null;
  const name = addr.emailAddress.name;
  return name ? `${name} <${addr.emailAddress.address}>` : addr.emailAddress.address;
}

function formatMessageSummary(
  mailboxAddress: string,
  message: GraphMailMessageDetail,
  folderName?: string | null,
) {
  return {
    id: message.id,
    subject: message.subject,
    from: formatAddress(message.from),
    to: (message.toRecipients ?? []).map((r) => formatAddress(r)).filter(Boolean),
    cc: (message.ccRecipients ?? []).map((r) => formatAddress(r)).filter(Boolean),
    receivedDateTime: message.receivedDateTime,
    sentDateTime: message.sentDateTime,
    conversationId: message.conversationId,
    internetMessageId: message.internetMessageId,
    hasAttachments: message.hasAttachments,
    bodyPreview: message.bodyPreview,
    webLink: message.webLink,
    provenance: formatOutlookProvenance({
      mailboxAddress,
      folderName: folderName ?? null,
      subject: message.subject,
      messageId: message.id,
    }),
  };
}

async function assertOutlookReadReady(
  env: Env,
  input: { companyId: string; connectorInstanceId: string; mailboxAddress: string },
): Promise<
  | { ok: true; config: { accessToken: string; tenantId: string } }
  | { ok: false; status: number; code: string; message: string }
> {
  const permissions = await assessOutlookPermissions(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
    probeMailboxAddress: input.mailboxAddress,
  });

  if (permissions.adminConsentRequired) {
    return {
      ok: false,
      status: 403,
      code: "OUTLOOK_MAIL_READ_NOT_GRANTED",
      message:
        permissions.adminConsentBlocker ??
        "Mail.Read (Application) admin consent is required before live mailbox retrieval.",
    };
  }

  const token = await acquireMicrosoftAppToken(env, {
    companyId: input.companyId,
    connectorInstanceId: input.connectorInstanceId,
  });
  if (!token.ok) {
    return { ok: false, status: 503, code: token.code, message: token.message };
  }

  return {
    ok: true,
    config: { accessToken: token.accessToken, tenantId: token.tenantId },
  };
}

export async function executeOutlookReadTool(
  env: Env,
  input: {
    companyId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor: string;
    actorUserId?: string | null;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; code: string; message: string }> {
  const mailboxAddress =
    typeof input.arguments.mailboxAddress === "string" ? input.arguments.mailboxAddress.trim() : null;
  const sourceId = typeof input.arguments.sourceId === "string" ? input.arguments.sourceId.trim() : null;

  const mailbox = await resolveIncludedOutlookMailbox(env, {
    companyId: input.companyId,
    mailboxAddress,
    sourceId,
  });
  if (!mailbox.ok) {
    if (await companyHasMcpOutlookConnection(env.DB, input.companyId)) {
      return executeCompanyMcpOutlookRead(env, input);
    }
    const status = mailbox.code === "OUTLOOK_MAILBOX_NOT_FOUND" ? 404 : 403;
    return { ok: false, status, code: mailbox.code, message: mailbox.message };
  }

  const ready = await assertOutlookReadReady(env, {
    companyId: input.companyId,
    connectorInstanceId: mailbox.connectorInstanceId,
    mailboxAddress: mailbox.mailboxAddress,
  });
  if (!ready.ok) return ready;

  try {
    let result: unknown;
    switch (input.toolName) {
      case "outlook_search_mailbox": {
        const query = String(input.arguments.query ?? "").trim();
        if (!query) {
          return { ok: false, status: 400, code: "OUTLOOK_QUERY_REQUIRED", message: "query is required" };
        }
        const messages = await searchMailboxMessages(ready.config, {
          mailboxAddress: mailbox.mailboxAddress,
          query,
          folderId:
            typeof input.arguments.folderId === "string" ? input.arguments.folderId : undefined,
          fromDate:
            typeof input.arguments.fromDate === "string" ? input.arguments.fromDate : undefined,
          toDate: typeof input.arguments.toDate === "string" ? input.arguments.toDate : undefined,
          top: Number(input.arguments.limit ?? input.arguments.top ?? 25),
        });
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          query,
          count: messages.length,
          messages: messages.map((m) => formatMessageSummary(mailbox.mailboxAddress, m)),
        };
        break;
      }
      case "outlook_list_messages": {
        const messages = await listMailboxMessages(ready.config, {
          mailboxAddress: mailbox.mailboxAddress,
          folderId:
            typeof input.arguments.folderId === "string" ? input.arguments.folderId : undefined,
          folderName:
            typeof input.arguments.folderName === "string" ? input.arguments.folderName : undefined,
          top: Number(input.arguments.limit ?? input.arguments.top ?? 25),
        });
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          count: messages.length,
          messages: messages.map((m) =>
            formatMessageSummary(
              mailbox.mailboxAddress,
              m,
              typeof input.arguments.folderName === "string" ? input.arguments.folderName : null,
            ),
          ),
        };
        break;
      }
      case "outlook_get_message": {
        const messageId = String(input.arguments.messageId ?? "").trim();
        if (!messageId) {
          return { ok: false, status: 400, code: "OUTLOOK_MESSAGE_ID_REQUIRED", message: "messageId is required" };
        }
        const message = await getMailboxMessage(ready.config, mailbox.mailboxAddress, messageId);
        result = {
          ...formatMessageSummary(mailbox.mailboxAddress, message),
          body: message.body?.content ?? null,
          bodyContentType: message.body?.contentType ?? null,
        };
        break;
      }
      case "outlook_get_conversation": {
        const conversationId = String(input.arguments.conversationId ?? "").trim();
        if (!conversationId) {
          return {
            ok: false,
            status: 400,
            code: "OUTLOOK_CONVERSATION_ID_REQUIRED",
            message: "conversationId is required",
          };
        }
        const messages = await listConversationMessages(
          ready.config,
          mailbox.mailboxAddress,
          conversationId,
          Number(input.arguments.limit ?? 50),
        );
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          conversationId,
          count: messages.length,
          messages: messages.map((m) => formatMessageSummary(mailbox.mailboxAddress, m)),
        };
        break;
      }
      case "outlook_list_folders": {
        const folders = await listMailboxFolders(ready.config, mailbox.mailboxAddress);
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          count: folders.length,
          folders: folders.map((f) => ({
            id: f.id,
            displayName: f.displayName,
            totalItemCount: f.totalItemCount,
            unreadItemCount: f.unreadItemCount,
            provenance: formatOutlookProvenance({
              mailboxAddress: mailbox.mailboxAddress,
              folderName: f.displayName,
            }),
          })),
        };
        break;
      }
      case "outlook_list_attachments": {
        const messageId = String(input.arguments.messageId ?? "").trim();
        if (!messageId) {
          return { ok: false, status: 400, code: "OUTLOOK_MESSAGE_ID_REQUIRED", message: "messageId is required" };
        }
        const attachments = await listMessageAttachments(ready.config, mailbox.mailboxAddress, messageId);
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          messageId,
          attachments: attachments.map((a) => ({
            id: a.id,
            name: a.name,
            contentType: a.contentType,
            size: a.size,
            isInline: a.isInline ?? false,
            retrievable: isOutlookAttachmentRetrievable(a.contentType, a.name),
          })),
        };
        break;
      }
      case "outlook_get_attachment": {
        const messageId = String(input.arguments.messageId ?? "").trim();
        const attachmentId = String(input.arguments.attachmentId ?? "").trim();
        if (!messageId || !attachmentId) {
          return {
            ok: false,
            status: 400,
            code: "OUTLOOK_ATTACHMENT_IDS_REQUIRED",
            message: "messageId and attachmentId are required",
          };
        }
        const attachment = await getMessageAttachmentContent(
          ready.config,
          mailbox.mailboxAddress,
          messageId,
          attachmentId,
        );
        if (!isOutlookAttachmentRetrievable(attachment.contentType, attachment.name)) {
          return {
            ok: false,
            status: 415,
            code: "OUTLOOK_ATTACHMENT_UNSUPPORTED",
            message: "Attachment type is not supported for retrieval in alpha",
          };
        }
        result = {
          mailboxAddress: mailbox.mailboxAddress,
          messageId,
          attachmentId,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          contentBytesBase64: attachment.contentBytes,
          promoteToKnowledgeSupported: true,
          note: "Attachment content is returned for authorised READ only — not auto-indexed to Company Knowledge.",
        };
        break;
      }
      default:
        return { ok: false, status: 404, code: "OUTLOOK_TOOL_UNKNOWN", message: "Unknown Outlook tool" };
    }

    await recordAuditEvent(env.DB, {
      companyId: input.companyId,
      eventType: "connector.accessed",
      actor: input.actor,
      resourceType: "outlook_mailbox",
      resourceId: mailbox.sourceId,
      detail: {
        stage: "outlook.mail.read",
        toolName: input.toolName,
        mailboxAddress: mailbox.mailboxAddress,
      },
    });

    return { ok: true, result };
  } catch (err) {
    if (err instanceof MicrosoftGraphError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      const code =
        err.status === 429
          ? "OUTLOOK_RATE_LIMITED"
          : err.status === 401
            ? "OUTLOOK_GRAPH_UNAUTHORIZED"
            : err.status === 403
              ? "OUTLOOK_GRAPH_FORBIDDEN"
              : err.status >= 500
                ? "OUTLOOK_GRAPH_UNAVAILABLE"
                : "OUTLOOK_GRAPH_ERROR";
      const message =
        err.status === 401
          ? "Outlook needs reconnecting"
          : err.status === 429 || err.status >= 500
            ? "Microsoft temporarily rejected the request"
            : err.status === 403
              ? "Microsoft denied mailbox access"
              : "Microsoft temporarily rejected the request";
      return { ok: false, status, code, message };
    }
    return {
      ok: false,
      status: 500,
      code: "OUTLOOK_READ_FAILED",
      message: err instanceof Error ? err.message : "Outlook read failed",
    };
  }
}

export function isOutlookReadToolName(toolName: string): boolean {
  return toolName.startsWith("outlook_");
}
