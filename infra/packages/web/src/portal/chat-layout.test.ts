import { describe, expect, it } from "vitest";
import {
  composerInputLocked,
  composerSendLocked,
  conversationDateGroup,
  filterConversations,
  followUpHints,
  groupConversations,
  isEmptyChatState,
  linkifyChatText,
  portalChatLayout,
  portalChatShellClass,
} from "./chat-layout";

describe("portal chat layout", () => {
  it("uses a full-screen mobile layout under 900px", () => {
    expect(portalChatLayout(390)).toBe("mobile");
    expect(portalChatLayout(1280)).toBe("desktop");
    expect(portalChatShellClass("mobile", true)).toContain("portal-chat--mobile");
    expect(portalChatShellClass("mobile", true)).toContain("portal-chat--history-open");
  });

  it("empty and error-adjacent states are explicit", () => {
    expect(isEmptyChatState(0, 0)).toBe(true);
    expect(isEmptyChatState(1, 0)).toBe(false);
    expect(followUpHints({ permissionDenied: true })).toEqual([]);
    expect(followUpHints({ controlledAction: true })[0]).toMatch(/approvals/i);
  });

  it("keeps the composer editable while a response is running", () => {
    expect(composerInputLocked(true)).toBe(false);
    expect(composerInputLocked(false)).toBe(false);
    expect(composerSendLocked("")).toBe(true);
    expect(composerSendLocked("  next question  ")).toBe(false);
  });

  it("groups conversations by recency and can search them", () => {
    const now = new Date("2026-09-04T15:00:00Z");
    expect(conversationDateGroup(now.toISOString(), now)).toBe("Today");
    expect(conversationDateGroup("2026-09-03T12:00:00Z", now)).toBe("Yesterday");
    const grouped = groupConversations([
      { id: "a", title: "September Xero Sales", updatedAt: "2026-09-04T12:00:00Z" },
      { id: "b", title: "Latest Info Inbox Email", updatedAt: "2026-09-01T12:00:00Z" },
    ]);
    expect(grouped[0]?.label).toBe("Today");
    expect(filterConversations(grouped.flatMap((group) => group.items), "xero")).toHaveLength(1);
  });

  it("turns source URLs into links without dumping JSON", () => {
    const parts = linkifyChatText("See https://contoso.sharepoint.com/docs/cv.pdf for the file.");
    expect(parts.some((part) => part.type === "link" && part.value.startsWith("https://"))).toBe(true);
    expect(parts.every((part) => !part.value.includes("{"))).toBe(true);
  });
});
