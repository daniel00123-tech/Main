import { describe, expect, it } from "vitest";
import {
  composerInputLocked,
  composerSendDisabled,
  followUpHints,
  isEmptyChatState,
  linkifyChatText,
  portalChatLayout,
  portalChatShellClass,
  PORTAL_CHAT_VISIBLE_BEFORE_SCROLL,
} from "./chat-layout";

describe("portal chat layout", () => {
  it("uses desktop, tablet, and mobile breakpoints", () => {
    expect(portalChatLayout(390)).toBe("mobile");
    expect(portalChatLayout(900)).toBe("tablet");
    expect(portalChatLayout(1280)).toBe("desktop");
    expect(portalChatShellClass("mobile", true)).toContain("portal-chat--mobile");
    expect(portalChatShellClass("mobile", true)).toContain("portal-chat--history-open");
    expect(portalChatShellClass("tablet", false)).toContain("portal-chat--tablet");
  });

  it("keeps the composer editable while a response is running", () => {
    expect(composerInputLocked(true)).toBe(false);
    expect(composerSendDisabled(true, "next question")).toBe(true);
    expect(composerSendDisabled(false, "next question")).toBe(false);
    expect(composerSendDisabled(false, "   ")).toBe(true);
  });

  it("empty and error-adjacent states are explicit", () => {
    expect(isEmptyChatState(0, 0)).toBe(true);
    expect(isEmptyChatState(1, 0)).toBe(false);
    expect(followUpHints({ permissionDenied: true })).toEqual([]);
    expect(followUpHints({ controlledAction: true })[0]).toMatch(/approvals/i);
    expect(PORTAL_CHAT_VISIBLE_BEFORE_SCROLL).toBe(5);
  });

  it("turns source URLs into links without dumping JSON", () => {
    const parts = linkifyChatText("See https://contoso.sharepoint.com/docs/cv.pdf for the file.");
    expect(parts.some((part) => part.type === "link" && part.value.startsWith("https://"))).toBe(true);
    expect(parts.every((part) => !part.value.includes("{"))).toBe(true);
  });
});
