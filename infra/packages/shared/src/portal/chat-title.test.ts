import { describe, expect, it } from "vitest";
import {
  conversationAgeGroup,
  displayConversationTitle,
  groupConversations,
  messagePreview,
  titleFromUserText,
} from "./chat-title";

const september = new Date("2026-09-04T12:00:00.000Z");

describe("titleFromUserText", () => {
  it("turns common company questions into short useful titles", () => {
    expect(titleFromUserText("what are the sales for this month on xero?", september)).toBe(
      "September Xero Sales",
    );
    expect(titleFromUserText("what is the newest email in the info inbox?", september)).toBe(
      "Latest Info Email",
    );
    expect(titleFromUserText("search company files for PO process", september)).toBe("PO Process");
    expect(titleFromUserText("show overdue invoices", september)).toBe("Overdue Invoices");
  });

  it("is generic rather than a phrase patch for nearby asks", () => {
    expect(titleFromUserText("what were last month's sales in Xero?", september)).toBe(
      "August Xero Sales",
    );
    expect(titleFromUserText("show me the newest email in the finance inbox", september)).toBe(
      "Latest Finance Email",
    );
    expect(titleFromUserText("search company files for vehicle breakdown process", september)).toBe(
      "Vehicle Breakdown Process",
    );
    expect(titleFromUserText("list outstanding bills", september)).toBe("Outstanding Bills");
    expect(titleFromUserText("check outlook for unread mail", september)).toBe("Outlook Unread Mail");
  });

  it("keeps greetings and empty prompts compact", () => {
    expect(titleFromUserText("")).toBe("New chat");
    expect(titleFromUserText("   ")).toBe("New chat");
    expect(titleFromUserText("hi")).toBe("Hello");
    expect(titleFromUserText("thanks!")).toBe("Hello");
  });
});

describe("displayConversationTitle", () => {
  it("regenerates stored raw prompts without rewriting manual titles", () => {
    expect(displayConversationTitle("What are our Xero sales?", undefined, september)).toBe(
      "Xero Sales",
    );
    expect(displayConversationTitle("Q3 board pack", "what are the sales for this month on xero?", september)).toBe(
      "Q3 board pack",
    );
    expect(displayConversationTitle("New chat", "show overdue invoices", september)).toBe(
      "Overdue Invoices",
    );
  });
});

describe("conversation grouping and previews", () => {
  it("groups newest-first rows into Today / Yesterday / Older", () => {
    const now = new Date("2026-09-04T15:00:00.000Z");
    const groups = groupConversations(
      [
        { id: "1", updatedAt: "2026-09-04T10:00:00.000Z" },
        { id: "2", updatedAt: "2026-09-03T18:00:00.000Z" },
        { id: "3", updatedAt: "2026-08-20T09:00:00.000Z" },
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Today", ["1"]],
      ["Yesterday", ["2"]],
      ["Older", ["3"]],
    ]);
    expect(conversationAgeGroup("2026-09-04T01:00:00.000Z", now)).toBe("today");
  });

  it("keeps last-message previews short", () => {
    expect(messagePreview("  Latest invoice is overdue.  ")).toBe("Latest invoice is overdue.");
    expect(messagePreview("x".repeat(90)).length).toBeLessThanOrEqual(72);
  });
});
