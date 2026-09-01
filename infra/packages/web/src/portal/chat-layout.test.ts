import { describe, expect, it } from "vitest";
import {
  followUpHints,
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

  it("turns source URLs into links without dumping JSON", () => {
    const parts = linkifyChatText("See https://contoso.sharepoint.com/docs/cv.pdf for the file.");
    expect(parts.some((part) => part.type === "link" && part.value.startsWith("https://"))).toBe(true);
    expect(parts.every((part) => !part.value.includes("{"))).toBe(true);
  });
});
