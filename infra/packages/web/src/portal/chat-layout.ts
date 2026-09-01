export const PORTAL_CHAT_MOBILE_MAX = 900;

export function portalChatLayout(width: number): "mobile" | "desktop" {
  return width < PORTAL_CHAT_MOBILE_MAX ? "mobile" : "desktop";
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
