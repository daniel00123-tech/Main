/** Rolling 24-hour document activity classification — no midnight cutoff. */

export const DOCUMENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DOCUMENT_ACTIVITY_EMAIL_LIST_LIMIT = 25;

export type DocumentActivitySourceKey =
  | "google_drive"
  | "onedrive"
  | "sharepoint"
  | "outlook_attachments";

export type DocumentActivitySourceCount = {
  key: DocumentActivitySourceKey;
  label: string;
  count: number;
};

export type ClassifiedActivityDocument = {
  title: string;
  sourceKey: DocumentActivitySourceKey;
  sourceLabel: string;
  kind: "new" | "updated";
};

const SOURCE_LABELS: Record<DocumentActivitySourceKey, string> = {
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  outlook_attachments: "Outlook attachments",
};

const LINE_SOURCE_LABELS: Record<DocumentActivitySourceKey, string> = {
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  outlook_attachments: "Outlook",
};

export function documentActivitySourceLabel(key: DocumentActivitySourceKey): string {
  return SOURCE_LABELS[key];
}

export function documentActivityLineSourceLabel(key: DocumentActivitySourceKey): string {
  return LINE_SOURCE_LABELS[key];
}

export function rolling24hWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - DOCUMENT_ACTIVITY_WINDOW_MS), to: now };
}

export function parseMaybeDate(value: string | null | undefined): Date | null {
  if (!value || !value.trim()) return null;
  const raw = value.trim();
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function classifyDocumentActivity(input: {
  createdAt?: string | null;
  sourceModifiedAt?: string | null;
  windowStart: Date;
  windowEnd: Date;
}): "new" | "updated" | null {
  const created = parseMaybeDate(input.createdAt);
  const modified = parseMaybeDate(input.sourceModifiedAt);
  const inWindow = (date: Date | null) =>
    date !== null && date.getTime() >= input.windowStart.getTime() && date.getTime() <= input.windowEnd.getTime();

  if (inWindow(created)) return "new";
  if (created && created.getTime() < input.windowStart.getTime() && inWindow(modified)) {
    return "updated";
  }
  return null;
}

export function isOutlookAttachmentItem(input: {
  externalId?: string | null;
  externalItemId?: string | null;
  itemKind?: string | null;
}): boolean {
  if (input.itemKind === "mail_attachment") return true;
  if (input.itemKind === "mail_message") return false;
  const externalId = (input.externalId ?? "").toLowerCase();
  if (externalId.startsWith("msat-")) return true;
  if (externalId.startsWith("msml-")) return false;
  return (input.externalItemId ?? "").includes("|");
}

export function capActivityList<T>(items: T[], limit = DOCUMENT_ACTIVITY_EMAIL_LIST_LIMIT): {
  items: T[];
  omitted: number;
} {
  if (items.length <= limit) return { items, omitted: 0 };
  return { items: items.slice(0, limit), omitted: items.length - limit };
}
