/**
 * Microsoft Graph mail API — READ ONLY for explicitly allowlisted shared mailboxes.
 */

import type { MicrosoftGraphConfig } from "./microsoft-graph";
import { MicrosoftGraphError } from "./microsoft-graph";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type GraphMailAddress = {
  emailAddress?: { address?: string; name?: string };
};

export type GraphMailAttachment = {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  isInline?: boolean;
  "@odata.type"?: string;
};

export type GraphMailFolder = {
  id: string;
  displayName: string;
  parentFolderId: string | null;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
};

export type GraphMailMessageDetail = {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  body?: { contentType?: string; content?: string };
  from: GraphMailAddress | null;
  sender: GraphMailAddress | null;
  toRecipients: GraphMailAddress[];
  ccRecipients: GraphMailAddress[];
  receivedDateTime: string | null;
  sentDateTime: string | null;
  lastModifiedDateTime?: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  hasAttachments: boolean;
  webLink: string | null;
  parentFolderId: string | null;
  "@removed"?: { reason?: string };
};

export type GraphTenantUser = {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  userType: string | null;
  accountEnabled: boolean | null;
  assignedLicenses?: Array<{ skuId: string }>;
};

type GraphPage<T> = { value: T[]; "@odata.nextLink"?: string };

async function graphMailRequest<T>(
  config: MicrosoftGraphConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new MicrosoftGraphError(
      `Microsoft Graph error ${response.status}: ${body.slice(0, 400)}`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listTenantMailUsers(
  config: MicrosoftGraphConfig,
  top = 999,
): Promise<GraphTenantUser[]> {
  const users: GraphTenantUser[] = [];
  // Graph does not support `$filter=mail ne null` (NotEqualsMatch). Paginate and filter client-side.
  let path = `/users?$select=id,displayName,mail,userPrincipalName,userType,accountEnabled,assignedLicenses&$top=${Math.min(top, 999)}`;

  while (path && users.length < top) {
    const page = await graphMailRequest<GraphPage<GraphTenantUser>>(config, path);
    for (const user of page.value ?? []) {
      if (user.mail?.trim()) users.push(user);
      if (users.length >= top) break;
    }
    path = users.length >= top ? "" : (page["@odata.nextLink"] ?? "");
  }
  return users.slice(0, top);
}

export async function followGraphMailPages<T>(
  fetchPage: (path: string) => Promise<GraphPage<T>>,
  firstPath: string,
  options?: { maxPages?: number; maxItems?: number },
): Promise<{ items: T[]; pages: number; nextLinkFollowed: boolean; truncated: boolean }> {
  const maxPages = options?.maxPages ?? 8;
  const maxItems = options?.maxItems ?? 400;
  const items: T[] = [];
  let path: string | undefined = firstPath;
  let pages = 0;
  while (path && pages < maxPages && items.length < maxItems) {
    const page = await fetchPage(path);
    items.push(...(page.value ?? []));
    path = page["@odata.nextLink"];
    pages += 1;
  }
  return {
    items: items.slice(0, maxItems),
    pages,
    nextLinkFollowed: pages > 1,
    truncated: Boolean(path) || items.length > maxItems,
  };
}

export async function getMailFolder(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  folderIdOrWellKnown: string,
): Promise<GraphMailFolder> {
  return graphMailRequest<GraphMailFolder>(
    config,
    `/users/${encodeURIComponent(mailboxAddress)}/mailFolders/${encodeURIComponent(folderIdOrWellKnown)}?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount`,
  );
}

export async function listMailboxFolders(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
): Promise<GraphMailFolder[]> {
  const listed = await followGraphMailPages<GraphMailFolder>(
    (path) => graphMailRequest(config, path),
    `/users/${encodeURIComponent(mailboxAddress)}/mailFolders?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount&$top=50`,
    { maxPages: 6, maxItems: 200 },
  );
  return listed.items;
}

export async function listMailboxFoldersDeep(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
): Promise<GraphMailFolder[]> {
  const root = await listMailboxFolders(config, mailboxAddress);
  const extras: GraphMailFolder[] = [];
  for (const folder of root) {
    if ((folder.childFolderCount ?? 0) <= 0) continue;
    try {
      const children = await followGraphMailPages<GraphMailFolder>(
        (path) => graphMailRequest(config, path),
        `/users/${encodeURIComponent(mailboxAddress)}/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount&$top=50`,
        { maxPages: 4, maxItems: 100 },
      );
      extras.push(...children.items);
    } catch {
      /* child-folder denial must not block Inbox ingest */
    }
  }
  const seen = new Set<string>();
  const merged: GraphMailFolder[] = [];
  for (const folder of [...root, ...extras]) {
    if (!folder.id || seen.has(folder.id)) continue;
    seen.add(folder.id);
    merged.push(folder);
  }
  return merged;
}

export async function listMailboxMessages(
  config: MicrosoftGraphConfig,
  input: {
    mailboxAddress: string;
    folderId?: string;
    folderName?: string;
    top?: number;
    skip?: number;
  },
): Promise<GraphMailMessageDetail[]> {
  const top = input.top ?? 25;
  const folderSegment = input.folderId
    ? `mailFolders/${input.folderId}`
    : input.folderName
      ? `mailFolders/${encodeURIComponent(input.folderName)}`
      : "mailFolders/inbox";

  const select =
    "id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId";
  const path = `/users/${encodeURIComponent(input.mailboxAddress)}/${folderSegment}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${select}${input.skip ? `&$skip=${input.skip}` : ""}`;
  const page = await graphMailRequest<GraphPage<GraphMailMessageDetail>>(config, path);
  return page.value ?? [];
}

export async function listMailboxFolderMessages(
  config: MicrosoftGraphConfig,
  input: {
    mailboxAddress: string;
    folderId: string;
    top?: number;
    receivedAfter?: string | null;
    maxPages?: number;
    maxItems?: number;
  },
): Promise<{
  messages: GraphMailMessageDetail[];
  pages: number;
  nextLinkFollowed: boolean;
}> {
  const top = Math.min(input.top ?? 50, 50);
  const select =
    "id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId";
  const filter = input.receivedAfter
    ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${input.receivedAfter}`)}`
    : "";
  const firstPath = `/users/${encodeURIComponent(input.mailboxAddress)}/mailFolders/${encodeURIComponent(input.folderId)}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${select}${filter}`;
  try {
    const paged = await followGraphMailPages<GraphMailMessageDetail>(
      (path) => graphMailRequest(config, path),
      firstPath,
      { maxPages: input.maxPages ?? 8, maxItems: input.maxItems ?? 400 },
    );
    return {
      messages: paged.items,
      pages: paged.pages,
      nextLinkFollowed: paged.nextLinkFollowed,
    };
  } catch (err) {
    if (!(err instanceof MicrosoftGraphError) || err.status !== 400 || !input.receivedAfter) throw err;
    const fallback = await followGraphMailPages<GraphMailMessageDetail>(
      (path) => graphMailRequest(config, path),
      `/users/${encodeURIComponent(input.mailboxAddress)}/mailFolders/${encodeURIComponent(input.folderId)}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${select}`,
      { maxPages: input.maxPages ?? 8, maxItems: input.maxItems ?? 400 },
    );
    return {
      messages: fallback.items,
      pages: fallback.pages,
      nextLinkFollowed: fallback.nextLinkFollowed,
    };
  }
}

export async function searchMailboxMessages(
  config: MicrosoftGraphConfig,
  input: {
    mailboxAddress: string;
    query: string;
    folderId?: string;
    fromDate?: string;
    toDate?: string;
    top?: number;
  },
): Promise<GraphMailMessageDetail[]> {
  const top = input.top ?? 25;
  const terms: string[] = [`"${input.query.replace(/"/g, "")}"`];
  if (input.fromDate) terms.push(`received>=${input.fromDate}`);
  if (input.toDate) terms.push(`received<=${input.toDate}`);

  const searchParam = encodeURIComponent(terms.join(" AND "));
  const folderFilter = input.folderId ? ` AND parentFolderId eq '${input.folderId}'` : "";
  const path = `/users/${encodeURIComponent(input.mailboxAddress)}/messages?$search=${searchParam}&$top=${top}&$select=id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId&$filter=receivedDateTime ge 1900-01-01T00:00:00Z${folderFilter}`;

  try {
    const page = await graphMailRequest<GraphPage<GraphMailMessageDetail>>(config, path, {
      headers: { ConsistencyLevel: "eventual" },
    });
    return page.value ?? [];
  } catch (err) {
    if (err instanceof MicrosoftGraphError && err.status === 400) {
      return listMailboxMessages(config, {
        mailboxAddress: input.mailboxAddress,
        folderId: input.folderId,
        top,
      }).then((rows) =>
        rows.filter((m) => {
          const hay = `${m.subject ?? ""} ${m.bodyPreview ?? ""}`.toLowerCase();
          return hay.includes(input.query.toLowerCase());
        }),
      );
    }
    throw err;
  }
}

export async function getMailboxMessage(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  messageId: string,
): Promise<GraphMailMessageDetail> {
  return graphMailRequest<GraphMailMessageDetail>(
    config,
    `/users/${encodeURIComponent(mailboxAddress)}/messages/${encodeURIComponent(messageId)}?$select=id,subject,bodyPreview,body,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId`,
  );
}

export async function listConversationMessages(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  conversationId: string,
  top = 50,
): Promise<GraphMailMessageDetail[]> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const page = await graphMailRequest<GraphPage<GraphMailMessageDetail>>(
    config,
    `/users/${encodeURIComponent(mailboxAddress)}/messages?$filter=${filter}&$top=${top}&$orderby=receivedDateTime asc&$select=id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId`,
  );
  return page.value ?? [];
}

export async function listMessageAttachments(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  messageId: string,
): Promise<GraphMailAttachment[]> {
  const page = await graphMailRequest<GraphPage<GraphMailAttachment>>(
    config,
    `/users/${encodeURIComponent(mailboxAddress)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
  );
  return page.value ?? [];
}

export async function getMessageAttachmentContent(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  messageId: string,
  attachmentId: string,
): Promise<{ name: string; contentType: string | null; size: number; contentBytes: string | null }> {
  const attachment = await graphMailRequest<GraphMailAttachment & { contentBytes?: string }>(
    config,
    `/users/${encodeURIComponent(mailboxAddress)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  return {
    name: attachment.name,
    contentType: attachment.contentType ?? null,
    size: attachment.size ?? 0,
    contentBytes: attachment.contentBytes ?? null,
  };
}

/** Probe whether Mail.Read application permission is effective for a mailbox. */
export async function probeMailboxReadAccess(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
): Promise<{ ok: boolean; status: number; code: string; message: string }> {
  try {
    await graphMailRequest<GraphPage<GraphMailMessageDetail>>(
      config,
      `/users/${encodeURIComponent(mailboxAddress)}/mailFolders/inbox/messages?$top=1&$select=id,subject`,
    );
    return { ok: true, status: 200, code: "MAIL_READ_OK", message: "Mailbox read access confirmed" };
  } catch (err) {
    if (err instanceof MicrosoftGraphError) {
      return {
        ok: false,
        status: err.status,
        code: err.status === 403 ? "MAIL_READ_DENIED" : "MAIL_READ_ERROR",
        message: err.message,
      };
    }
    return { ok: false, status: 500, code: "MAIL_READ_ERROR", message: String(err) };
  }
}

export type GraphMailDeltaResult = {
  messages: GraphMailMessageDetail[];
  deltaLink: string | null;
};

export async function listMailboxMessagesDelta(
  config: MicrosoftGraphConfig,
  input: { mailboxAddress: string; deltaLink?: string | null; folderId?: string; top?: number },
): Promise<GraphMailDeltaResult> {
  const folderSegment = input.folderId
    ? `mailFolders/${input.folderId}`
    : "mailFolders/inbox";
  const select =
    "id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,conversationId,internetMessageId,hasAttachments,webLink,parentFolderId";
  const path = input.deltaLink
    ? input.deltaLink
    : `/users/${encodeURIComponent(input.mailboxAddress)}/${folderSegment}/messages/delta?$select=${select}&$top=${input.top ?? 50}`;

  const messages: GraphMailMessageDetail[] = [];
  let next: string | null = path;
  let deltaLink: string | null = null;

  while (next) {
    const page = await graphMailRequest<
      GraphPage<GraphMailMessageDetail> & { "@odata.deltaLink"?: string; "@odata.nextLink"?: string }
    >(config, next);
    messages.push(...(page.value ?? []));
    if (page["@odata.deltaLink"]) {
      deltaLink = page["@odata.deltaLink"];
      break;
    }
    next = page["@odata.nextLink"] ?? null;
  }

  return { messages, deltaLink };
}

export function mailMessageVersionTag(message: GraphMailMessageDetail): string {
  return message.lastModifiedDateTime ?? message.receivedDateTime ?? message.internetMessageId ?? message.id;
}

export function stripHtmlToText(html: string): string {
  return html
   .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildMailKnowledgeText(
  message: GraphMailMessageDetail,
  options?: {
    hasAttachments?: boolean;
    attachments?: Array<{
      filename: string;
      contentType: string | null;
      attachmentId: string;
      indexedDocumentId?: number | null;
      knowledgeDocumentId?: number | null;
      indexingStatus: string;
    }>;
  },
): string {
  const lines = [
    `Subject: ${message.subject ?? "(no subject)"}`,
    `From: ${message.from?.emailAddress?.address ?? message.sender?.emailAddress?.address ?? "unknown"}`,
    `To: ${(message.toRecipients ?? []).map((r) => r.emailAddress?.address).filter(Boolean).join(", ")}`,
    `Received: ${message.receivedDateTime ?? "unknown"}`,
    `Internet Message ID: ${message.internetMessageId ?? "unknown"}`,
    `Has Attachments: ${options?.hasAttachments ?? message.hasAttachments ? "true" : "false"}`,
    "",
  ];

  const attachments = options?.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of attachments) {
      lines.push(
        `- ${attachment.filename} (${attachment.contentType ?? "unknown"}) attachmentId=${attachment.attachmentId} knowledgeDocumentId=${attachment.knowledgeDocumentId ?? attachment.indexedDocumentId ?? "pending"} status=${attachment.indexingStatus}`,
      );
    }
    lines.push("");
  }

  if (message.body?.content) {
    const body =
      message.body.contentType?.toLowerCase() === "html"
        ? stripHtmlToText(message.body.content)
        : message.body.content;
    if (body.trim()) {
      lines.push(body);
    } else {
      lines.push("(empty body)");
    }
  } else if (message.bodyPreview?.trim()) {
    lines.push(message.bodyPreview);
  } else {
    lines.push("(empty body)");
  }
  return lines.join("\n");
}

export async function probeUserReadAllAccess(
  config: MicrosoftGraphConfig,
): Promise<{ ok: boolean; status: number; code: string; message: string }> {
  try {
    await graphMailRequest<GraphPage<GraphTenantUser>>(
      config,
      `/users?$top=1&$select=id,displayName,mail,userPrincipalName`,
    );
    return { ok: true, status: 200, code: "USER_READ_ALL_OK", message: "User directory read confirmed" };
  } catch (err) {
    if (err instanceof MicrosoftGraphError) {
      return {
        ok: false,
        status: err.status,
        code: err.status === 403 ? "USER_READ_ALL_DENIED" : "USER_READ_ALL_ERROR",
        message: err.message,
      };
    }
    return { ok: false, status: 500, code: "USER_READ_ALL_ERROR", message: String(err) };
  }
}

export function formatOutlookProvenance(input: {
  mailboxAddress: string;
  folderName?: string | null;
  subject?: string | null;
  messageId?: string | null;
}): string {
  const parts = ["Microsoft 365", "Outlook", input.mailboxAddress];
  if (input.folderName) parts.push(input.folderName);
  if (input.subject) parts.push(input.subject);
  else if (input.messageId) parts.push(input.messageId);
  return parts.filter(Boolean).join(" → ");
}

export const OUTLOOK_SUPPORTED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

export function isOutlookAttachmentRetrievable(contentType: string | null, name: string): boolean {
  const mime = (contentType ?? "").toLowerCase();
  if (OUTLOOK_SUPPORTED_ATTACHMENT_TYPES.has(mime)) return true;
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  return ["pdf", "docx", "xlsx", "txt", "csv"].includes(ext ?? "");
}
