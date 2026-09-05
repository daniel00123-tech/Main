/**
 * Read-only forensic for Michael's EL mailbox attachments.
 * Uses EL-native Graph identity only. Never prints secrets or attachment bytes.
 */

import { classifyOutlookAttachmentForKnowledge } from "@infra/shared";
import type { Env } from "../env";
import {
  getMailboxFolderSettings,
  isFolderCoveredByCurrentIngestPolicy,
  listEnabledMailboxFolders,
  type MailboxIngestFolderRow,
} from "./mailbox-ingest-folder-policy";
import { listCompanyMailboxRegistry } from "./mailbox-registry";
import {
  EL_NATIVE_MICROSOFT_CLIENT_ID,
  EL_NATIVE_MICROSOFT_TENANT_ID,
  SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID,
} from "./microsoft-tenant-identity";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import {
  MicrosoftGraphError,
  graphGet,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";

const COMPANY_ID = "co_el";
const MICHAEL = "michael@elvexpropertyservices.com";
const SHARON = "sharon@elvexpropertyservices.com";
const LAUREN = "lauren@elvexpropertyservices.com";
const INGEST_DEFAULT_FOLDER = "inbox";

type MailboxIngestCoverage = {
  includeSent: boolean;
  includeArchive: boolean;
  enabledFolders: MailboxIngestFolderRow[];
};

type GraphUser = {
  id?: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  proxyAddresses?: string[];
  otherMails?: string[];
};

type GraphFolder = {
  id: string;
  displayName: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  totalItemCount?: number;
};

type GraphMessage = {
  id: string;
  subject?: string | null;
  receivedDateTime?: string | null;
  hasAttachments?: boolean;
  parentFolderId?: string | null;
  from?: { emailAddress?: { address?: string; name?: string } } | null;
  body?: { contentType?: string; content?: string } | null;
  bodyPreview?: string | null;
};

type GraphAttachment = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
  "@odata.type"?: string;
};

type WindowKey = "7d" | "14d" | "30d";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function inWindow(iso: string | null | undefined, from: Date): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at >= from.getTime();
}

function attachmentKind(type: string | null | undefined): string {
  const value = (type ?? "").toLowerCase();
  if (value.includes("fileattachment")) return "fileAttachment";
  if (value.includes("itemattachment")) return "itemAttachment";
  if (value.includes("referenceattachment")) return "referenceAttachment";
  return type || "unknown";
}

function cloudLinkCount(text: string | null | undefined): number {
  if (!text) return 0;
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return matches.filter((url) => /sharepoint\.com|onedrive\.live\.com|1drv\.ms|office\.com\/.*file/i.test(url)).length;
}

async function graphUser(config: MicrosoftGraphConfig, address: string): Promise<GraphUser | null> {
  try {
    return await graphGet<GraphUser>(
      config,
      `/users/${encodeURIComponent(address)}?$select=id,displayName,mail,userPrincipalName,proxyAddresses,otherMails`,
    );
  } catch {
    return null;
  }
}

async function listMichaelCandidates(config: MicrosoftGraphConfig): Promise<GraphUser[]> {
  try {
    const page = await graphGet<{ value?: GraphUser[] }>(
      config,
      `/users?$filter=${encodeURIComponent("startswith(displayName,'Michael')")}&$select=id,displayName,mail,userPrincipalName,proxyAddresses,otherMails&$top=20`,
    );
    return page.value ?? [];
  } catch {
    return [];
  }
}

async function listFolders(config: MicrosoftGraphConfig, mailbox: string): Promise<GraphFolder[]> {
  const root = await graphGet<{ value?: GraphFolder[] }>(
    config,
    `/users/${encodeURIComponent(mailbox)}/mailFolders?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount&$top=50`,
  );
  const folders = [...(root.value ?? [])];
  const extras: GraphFolder[] = [];
  for (const folder of folders) {
    if ((folder.childFolderCount ?? 0) > 0) {
      try {
        const children = await graphGet<{ value?: GraphFolder[] }>(
          config,
          `/users/${encodeURIComponent(mailbox)}/mailFolders/${folder.id}/childFolders?$select=id,displayName,parentFolderId,childFolderCount,totalItemCount&$top=50`,
        );
        extras.push(...(children.value ?? []));
      } catch {
        /* ignore child-folder denial */
      }
    }
  }
  return [...folders, ...extras];
}

async function listFolderMessages(
  config: MicrosoftGraphConfig,
  mailbox: string,
  folderId: string,
  sinceIso: string,
  max = 200,
): Promise<GraphMessage[]> {
  const select = "id,subject,from,receivedDateTime,hasAttachments,parentFolderId,webLink";
  const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso}`);
  let path:
    | string
    | undefined = `/users/${encodeURIComponent(mailbox)}/mailFolders/${folderId}/messages?$filter=${filter}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
  const rows: GraphMessage[] = [];
  let pages = 0;
  while (path && rows.length < max && pages < 8) {
    const page = await graphGet<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(config, path);
    rows.push(...(page.value ?? []));
    path = page["@odata.nextLink"];
    pages += 1;
  }
  return rows.slice(0, max);
}

async function listMailboxWideMessages(
  config: MicrosoftGraphConfig,
  mailbox: string,
  sinceIso: string,
  extraFilter = "",
  max = 200,
): Promise<GraphMessage[]> {
  const select = "id,subject,from,receivedDateTime,hasAttachments,parentFolderId,webLink";
  const filter = encodeURIComponent(
    extraFilter
      ? `receivedDateTime ge ${sinceIso} and ${extraFilter}`
      : `receivedDateTime ge ${sinceIso}`,
  );
  let path:
    | string
    | undefined = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
  const rows: GraphMessage[] = [];
  let pages = 0;
  while (path && rows.length < max && pages < 8) {
    const page = await graphGet<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(config, path);
    rows.push(...(page.value ?? []));
    path = page["@odata.nextLink"];
    pages += 1;
  }
  return rows.slice(0, max);
}

function folderIsWellKnown(folder: GraphFolder): boolean {
  return /^(inbox|archive|sent items|sentitems|deleted items|deleteditems|drafts|junk email|junkemail|conversation history)$/i.test(
    folder.displayName || "",
  );
}

async function listAttachments(
  config: MicrosoftGraphConfig,
  mailbox: string,
  messageId: string,
): Promise<{ attachments: GraphAttachment[]; error: string | null }> {
  try {
    const page = await graphGet<{ value?: Array<GraphAttachment & { contentBytes?: string }> }>(
      config,
      `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`,
    );
    const attachments = (page.value ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      isInline: row.isInline,
      contentId: row.contentId,
      "@odata.type": row["@odata.type"],
    }));
    return { attachments, error: null };
  } catch (err) {
    return {
      attachments: [],
      error: err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220),
    };
  }
}

async function hiddenAttachmentProbe(
  config: MicrosoftGraphConfig,
  mailbox: string,
  message: GraphMessage,
): Promise<{ attachmentCount: number; cloudLinks: number; kinds: string[]; attachments: GraphAttachment[] }> {
  const listed = await listAttachments(config, mailbox, message.id);
  const attachments = listed.attachments;
  let cloudLinks = 0;
  try {
    const full = await graphGet<GraphMessage>(
      config,
      `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message.id)}?$select=id,hasAttachments,bodyPreview,body`,
    );
    cloudLinks = cloudLinkCount(`${full.bodyPreview ?? ""}\n${full.body?.content ?? ""}`);
  } catch {
    cloudLinks = 0;
  }
  return {
    attachmentCount: attachments.length,
    cloudLinks,
    kinds: attachments.map((row) => attachmentKind(row["@odata.type"])),
    attachments,
  };
}

function classifyRow(att: GraphAttachment) {
  const filter = classifyOutlookAttachmentForKnowledge({
    filename: att.name,
    mimeType: att.contentType,
    sizeBytes: att.size,
    isInline: att.isInline,
    contentId: att.contentId,
  });
  const kind = attachmentKind(att["@odata.type"]);
  let reason = filter.skipReason;
  let code = filter.failureCode;
  if (kind === "referenceAttachment") {
    reason = reason ?? "Graph referenceAttachment / cloud link";
    code = code ?? "GRAPH_REFERENCE_ATTACHMENT";
  }
  if (kind === "itemAttachment") {
    reason = reason ?? "Graph itemAttachment (embedded message/item)";
    code = code ?? "GRAPH_ITEM_ATTACHMENT";
  }
  return { filter, kind, reason, code };
}

function folderCoveredByPolicy(folder: GraphFolder, coverage: MailboxIngestCoverage): boolean {
  return isFolderCoveredByCurrentIngestPolicy({
    folderName: folder.displayName,
    folderId: folder.id,
    enabledFolders: coverage.enabledFolders,
    includeSent: coverage.includeSent,
    includeArchive: coverage.includeArchive,
  });
}

async function inspectMailbox(
  config: MicrosoftGraphConfig,
  mailbox: string,
  folders: GraphFolder[],
  windows: Record<WindowKey, Date>,
  coverage: MailboxIngestCoverage,
) {
  const since30 = windows["30d"].toISOString();
  const folderReports = [];
  const messages: Array<GraphMessage & { folderName: string; scannedByPolicy: boolean }> = [];
  for (const folder of folders) {
    const name = folder.displayName || folder.id;
    const wellKnown = folderIsWellKnown(folder);
    const policyScans = folderCoveredByPolicy(folder, coverage);
    if (!wellKnown && (folder.totalItemCount ?? 0) === 0 && !folder.childFolderCount) continue;
    let listed: GraphMessage[] = [];
    try {
      listed = await listFolderMessages(config, mailbox, folder.id, since30);
    } catch (err) {
      folderReports.push({
        name,
        id: folder.id,
        totalItemCount: folder.totalItemCount ?? null,
        scannedByCurrentIngestPolicy: policyScans,
        error: err instanceof Error ? err.message.slice(0, 180) : String(err),
        messages30d: 0,
      });
      continue;
    }
    folderReports.push({
      name,
      id: folder.id,
      totalItemCount: folder.totalItemCount ?? null,
      scannedByCurrentIngestPolicy: policyScans,
      messages30d: listed.length,
      withAttachments30d: listed.filter((row) => row.hasAttachments).length,
    });
    for (const row of listed) {
      messages.push({ ...row, folderName: name, scannedByPolicy: policyScans });
    }
  }

  let mailboxWide: GraphMessage[] = [];
  let mailboxWideHasAttachments: GraphMessage[] = [];
  try {
    mailboxWide = await listMailboxWideMessages(config, mailbox, since30);
    mailboxWideHasAttachments = await listMailboxWideMessages(config, mailbox, since30, "hasAttachments eq true");
  } catch {
    mailboxWide = [];
    mailboxWideHasAttachments = [];
  }
  const knownIds = new Set(messages.map((row) => row.id));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  for (const row of mailboxWide) {
    if (knownIds.has(row.id)) continue;
    const folder = row.parentFolderId ? folderById.get(row.parentFolderId) : undefined;
    messages.push({
      ...row,
      folderName: folder?.displayName || "mailbox-wide-unlisted-folder",
      scannedByPolicy: folder ? folderCoveredByPolicy(folder, coverage) : false,
    });
    knownIds.add(row.id);
  }
  for (const row of mailboxWideHasAttachments) {
    if (knownIds.has(row.id)) continue;
    const folder = row.parentFolderId ? folderById.get(row.parentFolderId) : undefined;
    messages.push({
      ...row,
      folderName: folder?.displayName || "mailbox-wide-unlisted-folder",
      scannedByPolicy: folder ? folderCoveredByPolicy(folder, coverage) : false,
    });
    knownIds.add(row.id);
  }

  const countsFor = (key: WindowKey) => {
    const from = windows[key];
    const inW = messages.filter((row) => inWindow(row.receivedDateTime, from));
    return {
      messages: inW.length,
      hasAttachmentsTrue: inW.filter((row) => row.hasAttachments).length,
      inboxOnly: inW.filter((row) => row.scannedByPolicy).length,
      inboxHasAttachments: inW.filter((row) => row.scannedByPolicy && row.hasAttachments).length,
    };
  };

  const flagged = [...messages]
    .filter((row) => row.hasAttachments)
    .sort((left, right) => {
      const rank = (row: (typeof messages)[number]) => {
        if (row.scannedByPolicy) return 0;
        if (/davies|invoice/i.test(row.folderName)) return 1;
        if (/^completed$/i.test(row.folderName)) return 2;
        if (/^sent items$/i.test(row.folderName)) return 3;
        return 4;
      };
      return rank(left) - rank(right);
    })
    .slice(0, 80);
  const attachmentRows = [];
  const exclusions = [];
  let graphAttachments = 0;
  let eligible = 0;
  let inline = 0;
  let unsupported = 0;
  let reference = 0;
  let attachmentListError: string | null = null;
  for (const message of flagged) {
    const listed = await listAttachments(config, mailbox, message.id);
    if (listed.error && !attachmentListError) attachmentListError = listed.error;
    const atts = listed.attachments;
    graphAttachments += atts.length;
    for (const att of atts) {
      const classified = classifyRow(att);
      const eligibleYes = classified.filter.ingest && classified.kind === "fileAttachment";
      if (eligibleYes) eligible += 1;
      if (classified.filter.failureCode === "SKIP_INLINE" || classified.filter.failureCode === "SKIP_EMBEDDED_IMAGE") {
        inline += 1;
      }
      if (classified.filter.classification === "unsupported") unsupported += 1;
      if (classified.kind === "referenceAttachment") reference += 1;
      const row = {
        subject: message.subject ?? null,
        received: message.receivedDateTime ?? null,
        folder: message.folderName,
        scannedByCurrentIngestPolicy: message.scannedByPolicy,
        hasAttachments: true,
        filename: att.name ?? null,
        contentType: att.contentType ?? null,
        size: att.size ?? null,
        isInline: Boolean(att.isInline),
        contentId: att.contentId ? "present" : null,
        attachmentType: classified.kind,
        eligible: eligibleYes,
        exclusionReason: eligibleYes ? null : classified.reason,
        exclusionCode: eligibleYes ? null : classified.code,
      };
      attachmentRows.push(row);
      if (!eligibleYes) {
        exclusions.push({
          subject: row.subject,
          received: row.received,
          attachmentName: row.filename,
          attachmentType: row.attachmentType,
          exclusionReason: row.exclusionReason,
          folder: row.folder,
          inCurrentIngestFolder: row.scannedByCurrentIngestPolicy,
          inSevenDayWindow: inWindow(message.receivedDateTime, windows["7d"]),
        });
      }
    }
  }

  const hidden = [];
  const hiddenCandidates = messages
    .filter((row) => !row.hasAttachments)
    .sort((a, b) => Number(b.scannedByPolicy) - Number(a.scannedByPolicy))
    .slice(0, 20);
  for (const message of hiddenCandidates) {
    const probe = await hiddenAttachmentProbe(config, mailbox, message);
    if (probe.attachmentCount > 0 || probe.cloudLinks > 0) {
      const classifiedHidden = [];
      for (const att of probe.attachments) {
        const classified = classifyRow(att);
        classifiedHidden.push({
          filename: att.name ?? null,
          contentType: att.contentType ?? null,
          size: att.size ?? null,
          isInline: Boolean(att.isInline),
          attachmentType: classified.kind,
          eligible: classified.filter.ingest && classified.kind === "fileAttachment",
          exclusionReason: classified.filter.ingest && classified.kind === "fileAttachment" ? null : classified.reason,
        });
      }
      hidden.push({
        subject: message.subject ?? null,
        received: message.receivedDateTime ?? null,
        folder: message.folderName,
        scannedByCurrentIngestPolicy: message.scannedByPolicy,
        hasAttachments: false,
        graphAttachmentsFound: probe.attachmentCount,
        cloudLinks: probe.cloudLinks,
        kinds: probe.kinds,
        attachments: classifiedHidden,
      });
    }
  }

  const nextLinkUsed = folderReports.some((row) => (row.messages30d ?? 0) >= 50);

  return {
    windowCounts: {
      "7d": countsFor("7d"),
      "14d": countsFor("14d"),
      "30d": countsFor("30d"),
    },
    folders: folderReports,
    graphAttachments,
    attachmentListError,
    eligibleBusinessAttachments: eligible,
    inlineOrSignature: inline,
    unsupported,
    referenceAttachments: reference,
    attachmentRows,
    exclusions,
    hiddenAttachmentsOrLinks: hidden,
    mailboxWide: {
      messages30d: mailboxWide.length,
      hasAttachmentsFilter30d: mailboxWideHasAttachments.length,
      notFoundInFolderWalk: mailboxWide.filter((row) => !folders.some((folder) => folder.id === row.parentFolderId)).length,
    },
    pagination: {
      inboxMessageCap: 200,
      nextLinkFollowed: true,
      moreThanOnePagePossible: nextLinkUsed || mailboxWide.length >= 50,
      ingestFollowsNextLink: true,
      ingestDoesNotFollowNextLink: false,
    },
  };
}

export async function runElMichaelMailboxForensic(env: Env): Promise<Record<string, unknown>> {
  const actor = "system:el-michael-mailbox-forensic";
  const token = await acquireMicrosoftAppToken(env, {
    companyId: COMPANY_ID,
    actor,
    bypassCache: true,
  });
  if (!token.ok) {
    return {
      identity: { result: "FAIL", error: token.message },
      usedSharedConnector: false,
    };
  }
  if (token.clientId === SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID) {
    return { identity: { result: "FAIL", error: "Refused shared INFRA Business Connector" } };
  }
  if (token.clientId !== EL_NATIVE_MICROSOFT_CLIENT_ID || token.tenantId !== EL_NATIVE_MICROSOFT_TENANT_ID) {
    return {
      identity: {
        result: "FAIL",
        clientId: token.clientId,
        tenantId: token.tenantId,
        error: "Token was not the EL-native app",
      },
    };
  }

  const config: MicrosoftGraphConfig = { accessToken: token.accessToken, tenantId: token.tenantId };
  const resolved = await graphUser(config, MICHAEL);
  const candidates = await listMichaelCandidates(config).catch(() => []);
  const registry = (await listCompanyMailboxRegistry(env.DB, COMPANY_ID)).filter((row) =>
    /michael/i.test(`${row.mailbox_address} ${row.display_name ?? ""}`),
  );
  const windows = { "7d": daysAgo(7), "14d": daysAgo(14), "30d": daysAgo(30) };

  const [michaelSettings, michaelEnabledFolders] = await Promise.all([
    getMailboxFolderSettings(env.DB, COMPANY_ID, MICHAEL),
    listEnabledMailboxFolders(env.DB, COMPANY_ID, MICHAEL),
  ]);
  const michaelCoverage: MailboxIngestCoverage = {
    includeSent: michaelSettings.includeSent,
    includeArchive: michaelSettings.includeArchive,
    enabledFolders: michaelEnabledFolders,
  };
  const approvedFolderNames = [
    "Inbox",
    ...michaelEnabledFolders
      .map((row) => row.folder_name)
      .filter((name) => !/^inbox$/i.test(name)),
  ];

  const michaelFolders = await listFolders(config, MICHAEL);
  const michael = await inspectMailbox(config, MICHAEL, michaelFolders, windows, michaelCoverage);

  const compareInbox = async (address: string) => {
    const since30 = windows["30d"].toISOString();
    const listed = await listMailboxWideMessages(config, address, since30).catch(() => []);
    const countsFor = (key: WindowKey) => {
      const from = windows[key];
      const inW = listed.filter((row) => inWindow(row.receivedDateTime, from));
      return {
        messages: inW.length,
        hasAttachmentsTrue: inW.filter((row) => row.hasAttachments).length,
      };
    };
    return {
      windowCounts: { "7d": countsFor("7d"), "14d": countsFor("14d"), "30d": countsFor("30d") },
      query: "mailbox-wide Graph list for volume comparison only; ingest coverage is per-mailbox approved folders + Inbox",
    };
  };
  const sharon = await compareInbox(SHARON);
  const lauren = await compareInbox(LAUREN);

  const hiddenEligible = (michael.hiddenAttachmentsOrLinks ?? []).flatMap((row) =>
    (Array.isArray(row.attachments) ? row.attachments : [])
      .filter((att) => att && att.eligible)
      .map((att) => ({
        subject: row.subject ?? null,
        received: row.received ?? null,
        folder: row.folder,
        scannedByCurrentIngestPolicy: Boolean(row.scannedByCurrentIngestPolicy),
        filename: att.filename,
        attachmentType: att.attachmentType,
        size: att.size,
        eligible: true,
        exclusionReason: null,
        hasAttachmentsFlag: false,
      })),
  );
  const candidatesEligible = [
    ...hiddenEligible.filter((row) => row.scannedByCurrentIngestPolicy),
    ...michael.attachmentRows.filter((row) => row.eligible),
    ...hiddenEligible.filter((row) => !row.scannedByCurrentIngestPolicy),
  ];
  const best =
    candidatesEligible[0] ??
    michael.attachmentRows.find((row) => row.attachmentType === "fileAttachment") ??
    michael.attachmentRows[0] ??
    null;

  let rootCause = "J. NO_ATTACHMENT_ACTUALLY_PRESENT";
  let explanation =
    "Michael's mailbox was readable. Across 30 days and all relevant folders, no eligible non-inline business file was found.";
  if (hiddenEligible.some((row) => row.scannedByCurrentIngestPolicy && inWindow(row.received, windows["7d"]))) {
    rootCause = "I. GRAPH_ATTACHMENT_ENUM_BUG";
    explanation =
      "Inbox messages in the current 7-day window have real file attachments, but Graph hasAttachments=false, so ingest never enumerates them.";
  } else if (candidatesEligible.length) {
    const first = candidatesEligible[0];
    if (!first.scannedByCurrentIngestPolicy) {
      rootCause = "C. FOLDER_NOT_SCANNED";
      explanation = `A genuine file attachment exists in ${first.folder}, which is not in this mailbox's approved ingest folder list. Inbox is always scanned; extra folders are opt-in only.`;
    } else if (!inWindow(first.received, windows["7d"])) {
      rootCause = "A. OUTSIDE_SCAN_WINDOW";
      explanation = `A genuine file attachment exists but was received before the current 7-day ingest window (${first.received}).`;
    } else {
      rootCause = "K. OTHER";
      explanation =
        "An eligible attachment exists inside an approved ingest folder and the 7-day window. Investigate ingest filtering, duplicate-hash skips, or retrieval — not folder coverage.";
    }
  } else if (michael.referenceAttachments > 0) {
    rootCause = "D. GRAPH_REFERENCE_ATTACHMENT";
    explanation = "Michael has attachment-bearing messages, but they are Graph reference/cloud-link attachments, not downloadable file attachments.";
  } else if (michael.inlineOrSignature > 0 && michael.eligibleBusinessAttachments === 0) {
    rootCause = "E. INLINE_FILTERED";
    explanation = "Attachments were present but were inline/signature/decorative images, which ingest correctly skips.";
  } else if (michael.unsupported > 0 && michael.eligibleBusinessAttachments === 0) {
    rootCause = "F. UNSUPPORTED_TYPE";
    explanation = "Attachments were present but none were a supported business file type.";
  } else if (michael.attachmentListError) {
    rootCause = "I. GRAPH_ATTACHMENT_ENUM_BUG";
    explanation = `Attachment-bearing messages were found, but Graph attachment listing failed: ${michael.attachmentListError}`;
  } else if (michael.windowCounts["30d"].hasAttachmentsTrue > 0 && michael.graphAttachments === 0) {
    rootCause = "I. GRAPH_ATTACHMENT_ENUM_BUG";
    explanation = "Messages report hasAttachments=true but the attachments endpoint returned none.";
  } else if (michael.hiddenAttachmentsOrLinks.some((row) => row.graphAttachmentsFound > 0)) {
    rootCause = "I. GRAPH_ATTACHMENT_ENUM_BUG";
    explanation = "hasAttachments=false on at least one message that still returned attachments from the attachments endpoint.";
  } else if (michael.hiddenAttachmentsOrLinks.some((row) => row.cloudLinks > 0)) {
    rootCause = "D. GRAPH_REFERENCE_ATTACHMENT";
    explanation = "No file attachments were enumerated; at least one message has SharePoint/OneDrive links in the body only.";
  } else if (michael.windowCounts["30d"].messages === 0) {
    rootCause = "B. WRONG_MAILBOX_IDENTITY";
    explanation = "The resolved Michael mailbox returned no messages in 30 days. Confirm this is the intended mailbox.";
  }

  const registryRow = registry[0] ?? null;

  return {
    identity: {
      result: "PASS",
      tenantId: token.tenantId,
      clientId: token.clientId,
      source: "tenant_native",
      usedSharedConnector: false,
    },
    michaelUser: {
      displayName: resolved?.displayName ?? null,
      mail: resolved?.mail ?? null,
      userPrincipalName: resolved?.userPrincipalName ?? null,
      graphUserId: resolved?.id ?? null,
      proxyAddresses: (resolved?.proxyAddresses ?? []).map((row) => row.replace(/^smtp:/i, "")),
      otherMails: resolved?.otherMails ?? [],
      otherMichaelCandidates: candidates
        .filter((row) => row.id && row.id !== resolved?.id)
        .map((row) => ({
          displayName: row.displayName ?? null,
          mail: row.mail ?? null,
          userPrincipalName: row.userPrincipalName ?? null,
          graphUserId: row.id ?? null,
        })),
    },
    registry: registry.map((row) => ({
      mailboxAddress: row.mailbox_address,
      displayName: row.display_name,
      mailboxType: row.mailbox_type,
      mailboxId: row.mailbox_id,
      mailboxIdIsGraphUserId: row.mailbox_id === (resolved?.id ?? null),
      mailboxEnabled: row.status !== "denied",
      approved: row.status === "approved" || row.enabled_for_attachment_ingestion === 1,
      excluded: row.enabled_for_attachment_ingestion !== 1,
      chatSearchEnabled: row.enabled_for_mail_search === 1,
      attachmentIngestionEnabled: row.enabled_for_attachment_ingestion === 1,
      checkpoint: row.last_checkpoint,
      lastSuccessfulScan: row.last_successful_sync,
      lastAttachmentScanAt: row.last_attachment_scan_at,
      lastMessagesScanned: row.last_messages_scanned ?? null,
      lastFailure: row.last_error,
      pointsAtRequestedMailbox: row.mailbox_address.toLowerCase() === MICHAEL,
    })),
    ingestPolicy: {
      currentFolder: INGEST_DEFAULT_FOLDER,
      approvedFolders: approvedFolderNames,
      currentWindowDays: 7,
      sentItemsIncluded: michaelCoverage.includeSent,
      archiveIncluded: michaelCoverage.includeArchive,
      sameQueryAsSharonLauren: false,
      pagination: "followGraphMailPages / @odata.nextLink",
      note: "Ingest scans Inbox plus explicitly approved mailbox folders by folder id, follows @odata.nextLink, and keeps Sent Items / Archive off unless enabled for that mailbox.",
    },
    michael,
    comparison: {
      query: "GET /users/{mailbox}/mailFolders/{folder}/messages?$filter=receivedDateTime ge {since}&$orderby=receivedDateTime desc",
      folderDifference: `Ingest coverage is per mailbox: Inbox always, plus approved user folders. This mailbox's approved folders: ${approvedFolderNames.join(", ") || "Inbox"}. Sent Items and Archive stay off unless opted in.`,
      sharonMailboxWide: sharon.windowCounts,
      laurenMailboxWide: lauren.windowCounts,
      sharonNote: sharon.query,
      laurenNote: lauren.query,
    },
    bestCandidate: best
      ? {
          subject: best.subject,
          received: best.received,
          folder: best.folder,
          filename: best.filename,
          attachmentType: best.attachmentType,
          size: best.size,
          hasAttachments: !("hasAttachmentsFlag" in best) || best.hasAttachmentsFlag !== false,
          eligible: best.eligible ? "YES" : "NO",
          reason: best.eligible
            ? "hasAttachmentsFlag" in best && best.hasAttachmentsFlag === false
              ? "Eligible file on an Inbox message where Graph hasAttachments=false"
              : best.scannedByCurrentIngestPolicy && inWindow(best.received, windows["7d"])
                ? "Eligible file attachment inside an approved ingest folder + 7-day window"
                : !best.scannedByCurrentIngestPolicy
                  ? `Eligible file, but folder ${best.folder} is not in the approved ingest folder list`
                  : "Eligible file, but outside the current 7-day window"
            : best.exclusionReason,
        }
      : null,
    rootCause,
    explanation,
    registryRowPresent: Boolean(registryRow),
  };
}
