import { groupConversations } from "@infra/shared";

export const PORTAL_CHAT_MOBILE_MAX = 768;
export const PORTAL_CHAT_TABLET_MAX = 1100;
export const PORTAL_CHAT_VISIBLE_BEFORE_SCROLL = 5;

export function portalChatLayout(width: number): "mobile" | "tablet" | "desktop" {
  if (width < PORTAL_CHAT_MOBILE_MAX) return "mobile";
  if (width < PORTAL_CHAT_TABLET_MAX) return "tablet";
  return "desktop";
}

export function portalChatShellClass(
  layout: "mobile" | "tablet" | "desktop",
  historyOpen: boolean,
): string {
  return [
    "portal-chat",
    `portal-chat--${layout}`,
    historyOpen ? "portal-chat--history-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function isEmptyChatState(conversationCount: number, messageCount: number): boolean {
  return conversationCount === 0 && messageCount === 0;
}

export function composerSendDisabled(busy: boolean, draft: string): boolean {
  return busy || !draft.replace(/\s+/g, " ").trim();
}

export function composerInputLocked(busy: boolean): boolean {
  void busy;
  return false;
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

export { groupConversations };
