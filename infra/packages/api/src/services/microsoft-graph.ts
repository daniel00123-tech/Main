/**
 * Microsoft Graph API client foundation (read-only).
 * Token retrieval uses encrypted connector credentials — never exposed to frontend.
 */

import type { MicrosoftKnowledgeProvenance, MicrosoftSourceType } from "@infra/shared";

export type MicrosoftGraphConfig = {
  accessToken: string;
  tenantId: string;
};

export type GraphDrive = {
  id: string;
  name: string;
  driveType: string;
  webUrl: string | null;
};

export type GraphSite = {
  id: string;
  name: string;
  webUrl: string | null;
  displayName: string | null;
};

export type GraphDriveItem = {
  id: string;
  name: string;
  webUrl: string | null;
  size: number | null;
  mimeType: string | null;
  lastModifiedDateTime: string | null;
  folder?: { childCount: number } | null;
  file?: { mimeType: string } | null;
};

export type GraphMailMessage = {
  id: string;
  subject: string | null;
  from: { emailAddress?: { address?: string; name?: string } } | null;
  receivedDateTime: string | null;
  conversationId: string | null;
  bodyPreview: string | null;
  hasAttachments: boolean;
};

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphGet<T>(config: MicrosoftGraphConfig, path: string): Promise<T> {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Microsoft Graph error ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export async function listUserDrives(config: MicrosoftGraphConfig): Promise<GraphDrive[]> {
  const body = await graphGet<{ value?: GraphDrive[] }>(config, "/me/drives");
  return body.value ?? [];
}

export async function listSites(config: MicrosoftGraphConfig, search?: string): Promise<GraphSite[]> {
  const query = search ? `?search=${encodeURIComponent(`"${search}"`)}` : "";
  const body = await graphGet<{ value?: GraphSite[] }>(config, `/sites${query}`);
  return body.value ?? [];
}

export async function listDriveChildren(
  config: MicrosoftGraphConfig,
  driveId: string,
  folderId?: string,
): Promise<GraphDriveItem[]> {
  const path = folderId
    ? `/drives/${driveId}/items/${folderId}/children`
    : `/drives/${driveId}/root/children`;
  const body = await graphGet<{ value?: GraphDriveItem[] }>(config, path);
  return body.value ?? [];
}

export async function listSharedMailboxMessages(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  folder = "inbox",
  top = 25,
): Promise<GraphMailMessage[]> {
  const path = `/users/${encodeURIComponent(mailboxAddress)}/mailFolders/${folder}/messages?$top=${top}&$orderby=receivedDateTime desc`;
  const body = await graphGet<{ value?: GraphMailMessage[] }>(config, path);
  return body.value ?? [];
}

export function buildMicrosoftProvenance(input: {
  companyId: string;
  tenantId: string | null;
  sourceType: MicrosoftSourceType;
  externalItemId: string;
  path: string | null;
  filename: string | null;
  subject?: string | null;
  modifiedAt: string | null;
  driveId?: string | null;
  siteId?: string | null;
  mailboxAddress?: string | null;
  inclusionStatus: "included" | "excluded" | "available";
}): MicrosoftKnowledgeProvenance {
  return {
    connector: "microsoft_365",
    sourceType: input.sourceType,
    companyId: input.companyId,
    tenantId: input.tenantId,
    driveId: input.driveId ?? null,
    siteId: input.siteId ?? null,
    mailboxAddress: input.mailboxAddress ?? null,
    path: input.path,
    filename: input.filename,
    subject: input.subject ?? null,
    externalItemId: input.externalItemId,
    modifiedAt: input.modifiedAt,
    scope: input.inclusionStatus,
  };
}
