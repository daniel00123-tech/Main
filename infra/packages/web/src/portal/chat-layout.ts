export const PORTAL_CHAT_MOBILE_MAX = 900;

export type ConversationDateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export function portalChatLayout(width: number): "mobile" | "desktop" {
  return width < PORTAL_CHAT_MOBILE_MAX ? "mobile" : "desktop";
}

export function composerInputLocked(_busy: boolean): boolean {
  return false;
}

export function composerSendLocked(draft: string): boolean {
  return !draft.replace(/\s+/g, " ").trim();
}

export function conversationDateGroup(iso: string, now = new Date()): ConversationDateGroup {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Older";
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff <= 7) return "Previous 7 days";
  return "Older";
}

export function groupConversations<T extends { updatedAt: string }>(
  rows: T[],
): Array<{ label: ConversationDateGroup; items: T[] }> {
  const order: ConversationDateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Older"];
  const buckets = new Map<ConversationDateGroup, T[]>();
  for (const label of order) buckets.set(label, []);
  for (const row of rows) {
    buckets.get(conversationDateGroup(row.updatedAt))!.push(row);
  }
  return order
    .map((label) => ({ label, items: buckets.get(label) ?? [] }))
    .filter((group) => group.items.length > 0);
}

export function filterConversations<T extends { title: string; preview?: string | null }>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.title} ${row.preview ?? ""}`.toLowerCase().includes(needle));
}

export function portalChatShellClass(layout: "mobile" | "desktop", historyOpen: boolean): string {
  return [
    "portal-chat",
    layout === "mobile" ? "portal-chat--mobile" : "portal-chat--desktop",
    historyOpen ? "portal-chat--history-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function isEmptyChatState(conversationCount: number, messageCount: number): boolean {
  return conversationCount === 0 && messageCount === 0;
}

export function followUpHints(input: {
  hasDocument?: boolean;
  permissionDenied?: boolean;
  controlledAction?: boolean;
}): string[] {
  if (input.permissionDenied) return [];
  if (input.controlledAction) return ["Open approvals to review this request"];
  if (input.hasDocument) {
    return ["Where did that come from?", "Summarise this document", "Search other files"];
  }
  return ["What can you help with?", "Search company files"];
}

export function linkifyChatText(text: string): Array<{ type: "text" | "link"; value: string }> {
  const parts: Array<{ type: "text" | "link"; value: string }> = [];
  const matcher = /https?:\/\/[^\s)]+/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: "link", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts.length ? parts : [{ type: "text", value: text }];
}
