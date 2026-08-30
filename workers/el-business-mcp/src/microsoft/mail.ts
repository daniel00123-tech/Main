import type { GraphClient } from "./graph";
import type { AccessPolicy } from "./policy";

export type MailSearchInput = {
  mailbox: string;
  query?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  keywords?: string;
  fromDate?: string;
  toDate?: string;
  folder?: string;
  top?: number;
};

export type MailMessage = {
  id: string;
  subject: string | null;
  from: string | null;
  to: string[];
  receivedDateTime: string | null;
  sentDateTime: string | null;
  conversationId: string | null;
  bodyPreview: string | null;
  hasAttachments: boolean;
  isRead: boolean | null;
  webLink: string | null;
  folder?: string | null;
  mailbox: string;
};

export type MailAttachment = {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number | null;
  isInline: boolean;
  contentBytes?: string | null;
};

type GraphMessage = {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { address?: string; name?: string } } | null;
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  conversationId?: string | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean;
  isRead?: boolean;
  webLink?: string | null;
  parentFolderId?: string | null;
  body?: { contentType?: string; content?: string } | null;
};

const MESSAGE_SELECT =
  "id,subject,from,toRecipients,receivedDateTime,sentDateTime,conversationId,bodyPreview,hasAttachments,isRead,webLink,parentFolderId";

function mapMessage(raw: GraphMessage, mailbox: string): MailMessage {
  return {
    id: raw.id,
    subject: raw.subject ?? null,
    from: raw.from?.emailAddress?.address ?? raw.from?.emailAddress?.name ?? null,
    to: (raw.toRecipients ?? []).map((r) => r.emailAddress?.address).filter(Boolean) as string[],
    receivedDateTime: raw.receivedDateTime ?? null,
    sentDateTime: raw.sentDateTime ?? null,
    conversationId: raw.conversationId ?? null,
    bodyPreview: raw.bodyPreview ?? null,
    hasAttachments: Boolean(raw.hasAttachments),
    isRead: raw.isRead ?? null,
    webLink: raw.webLink ?? null,
    mailbox,
  };
}

function userPath(mailbox: string, suffix: string): string {
  return `/users/${encodeURIComponent(mailbox)}${suffix}`;
}

export async function searchMailbox(
  graph: GraphClient,
  policy: AccessPolicy,
  input: MailSearchInput
): Promise<MailMessage[]> {
  const mailbox = policy.assertApprovedMailbox(input.mailbox);
  const top = Math.min(input.top ?? 15, 40);
  const folderPrefix = input.folder
    ? `/mailFolders/${encodeURIComponent(input.folder)}/messages`
    : "/messages";

  const kql: string[] = [];
  if (input.query) kql.push(input.query);
  if (input.keywords) kql.push(input.keywords);
  if (input.sender) kql.push(`from:${input.sender}`);
  if (input.recipient) kql.push(`recipients:${input.recipient}`);
  if (input.subject) kql.push(`subject:${input.subject}`);
  if (input.fromDate) kql.push(`received>=${input.fromDate}`);
  if (input.toDate) kql.push(`received<=${input.toDate}`);

  if (kql.length > 0) {
    const search = encodeURIComponent(`"${kql.join(" ")}"`);
    const page = await graph.get<{ value?: GraphMessage[] }>(
      `${userPath(mailbox, folderPrefix)}?$search=${search}&$select=${MESSAGE_SELECT}&$top=${top}`,
      { headers: { ConsistencyLevel: "eventual" } }
    );
    return (page.value ?? []).map((item) => mapMessage(item, mailbox));
  }

  const page = await graph.get<{ value?: GraphMessage[] }>(
    `${userPath(mailbox, folderPrefix)}?$select=${MESSAGE_SELECT}&$orderby=receivedDateTime desc&$top=${top}`
  );
  return (page.value ?? []).map((item) => mapMessage(item, mailbox));
}

export async function getMessage(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  includeBody = true
): Promise<MailMessage & { body?: string | null }> {
  const approved = policy.assertApprovedMailbox(mailbox);
  const select = includeBody ? `${MESSAGE_SELECT},body` : MESSAGE_SELECT;
  const raw = await graph.get<GraphMessage>(
    `${userPath(approved, `/messages/${encodeURIComponent(messageId)}`)}?$select=${select}`
  );
  return {
    ...mapMessage(raw, approved),
    body: raw.body?.content ?? null,
  };
}

export async function getConversation(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  conversationId: string
): Promise<MailMessage[]> {
  const approved = policy.assertApprovedMailbox(mailbox);
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
  const page = await graph.get<{ value?: GraphMessage[] }>(
    `${userPath(approved, "/messages")}?$filter=${filter}&$select=${MESSAGE_SELECT}&$top=40`
  );
  return (page.value ?? []).map((item) => mapMessage(item, approved));
}

export async function listFolders(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string
): Promise<Array<{ id: string; displayName: string; totalItemCount: number | null }>> {
  const approved = policy.assertApprovedMailbox(mailbox);
  const folders = await graph.getAll<{
    id: string;
    displayName: string;
    totalItemCount?: number;
  }>(`${userPath(approved, "/mailFolders")}?$select=id,displayName,totalItemCount&$top=50`, 5);
  return folders.map((folder) => ({
    id: folder.id,
    displayName: folder.displayName,
    totalItemCount: folder.totalItemCount ?? null,
  }));
}

export async function listAttachments(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  includeContent = false
): Promise<MailAttachment[]> {
  const approved = policy.assertApprovedMailbox(mailbox);
  const items = await graph.getAll<{
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
    contentBytes?: string;
  }>(
    `${userPath(approved, `/messages/${encodeURIComponent(messageId)}/attachments`)}?$top=20`,
    2
  );
  return items.map((item) => ({
    id: item.id,
    name: item.name ?? null,
    contentType: item.contentType ?? null,
    size: item.size ?? null,
    isInline: Boolean(item.isInline),
    contentBytes: includeContent ? item.contentBytes ?? null : undefined,
  }));
}

export async function sendMail(
  graph: GraphClient,
  policy: AccessPolicy,
  input: {
    mailbox: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    bodyType?: "Text" | "HTML";
  }
): Promise<{ status: "sent"; mailbox: string; subject: string }> {
  const mailbox = policy.assertApprovedMailbox(input.mailbox);
  await graph.post(userPath(mailbox, "/sendMail"), {
    message: {
      subject: input.subject,
      body: { contentType: input.bodyType ?? "Text", content: input.body },
      toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (input.cc ?? []).map((address) => ({ emailAddress: { address } })),
      from: { emailAddress: { address: mailbox } },
    },
    saveToSentItems: true,
  });
  return { status: "sent", mailbox, subject: input.subject };
}

export async function replyMail(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  comment: string
): Promise<{ status: "replied"; mailbox: string; messageId: string }> {
  const approved = policy.assertApprovedMailbox(mailbox);
  await graph.post(
    userPath(approved, `/messages/${encodeURIComponent(messageId)}/reply`),
    { comment }
  );
  return { status: "replied", mailbox: approved, messageId };
}

export async function forwardMail(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  to: string[],
  comment?: string
): Promise<{ status: "forwarded"; mailbox: string; messageId: string }> {
  const approved = policy.assertApprovedMailbox(mailbox);
  await graph.post(userPath(approved, `/messages/${encodeURIComponent(messageId)}/forward`), {
    comment,
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  });
  return { status: "forwarded", mailbox: approved, messageId };
}

export async function setReadState(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  isRead: boolean
): Promise<{ status: "updated"; mailbox: string; messageId: string; isRead: boolean }> {
  const approved = policy.assertApprovedMailbox(mailbox);
  await graph.patch(userPath(approved, `/messages/${encodeURIComponent(messageId)}`), { isRead });
  return { status: "updated", mailbox: approved, messageId, isRead };
}

export async function moveMessage(
  graph: GraphClient,
  policy: AccessPolicy,
  mailbox: string,
  messageId: string,
  destinationFolderId: string
): Promise<{ status: "moved"; mailbox: string; messageId: string }> {
  const approved = policy.assertApprovedMailbox(mailbox);
  await graph.post(userPath(approved, `/messages/${encodeURIComponent(messageId)}/move`), {
    destinationId: destinationFolderId,
  });
  return { status: "moved", mailbox: approved, messageId };
}
