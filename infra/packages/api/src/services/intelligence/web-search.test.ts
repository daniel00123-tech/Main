import { describe, expect, it } from "vitest";
import { classifyScope } from "./scope.js";
import { buildConversationState } from "./state.js";
import { isLivePublicInformationAsk, sanitizeWebSearchQuery } from "./web-search.js";
import { resolveMailboxAsk } from "./mailbox.js";
import { isCatalogueListingAsk } from "../document-catalogue.js";
import { titleFromUserText } from "../portal-chat-types.js";
import { normaliseUserUtterance, answerArithmetic } from "./utterance.js";

describe("portal chat public web and conversation helpers", () => {
  it("keeps business systems above public web search", () => {
    expect(isLivePublicInformationAsk("whats the weather in London now")).toBe(true);
    expect(isLivePublicInformationAsk("What are our Xero sales this month?")).toBe(false);
    expect(isLivePublicInformationAsk("What is the newest email in the info inbox?")).toBe(false);
    expect(isLivePublicInformationAsk("Search company files for PO process")).toBe(false);
    expect(classifyScope("whats the weather in London now", buildConversationState({ userText: "whats the weather in London now" }))).toMatchObject({
      tool: "web_search",
    });
    expect(classifyScope("What are our Xero sales this month?", buildConversationState({ userText: "What are our Xero sales this month?" })).tool).toMatch(
      /^xero_/,
    );
  });

  it("refuses private EL data in public web queries", () => {
    expect(sanitizeWebSearchQuery("weather in London").ok).toBe(true);
    expect(sanitizeWebSearchQuery("find emails from info@elvexpropertyservices.com").ok).toBe(false);
    expect(sanitizeWebSearchQuery("lookup INV-02268 publicly").ok).toBe(false);
  });

  it("clarifies my inbox and keeps finance/info deterministic", () => {
    expect(resolveMailboxAsk("what about in my inbox?")).toMatchObject({ kind: "clarify" });
    expect(resolveMailboxAsk("what is the newest email in the info inbox?")).toMatchObject({
      kind: "resolved",
      mailboxAddress: "info@elvexpropertyservices.com",
    });
    expect(
      resolveMailboxAsk("what about the finance inbox?", {
        lastAnswerTopic: "email",
        lastMailboxAddress: "info@elvexpropertyservices.com",
      }),
    ).toMatchObject({ mailboxAddress: "finance@elvexpropertyservices.com" });
  });

  it("does not treat latest-email asks as catalogue listings", () => {
    expect(isCatalogueListingAsk("yeah thats right the info inbox what is the latest email?")).toBe(false);
    expect(
      classifyScope(
        "yeah thats right the info inbox what is the latest email?",
        buildConversationState({
          userText: "yeah thats right the info inbox what is the latest email?",
          currentDocument: { id: "doc_po", title: "PO process" },
          lastAnswerTopic: "email",
        }),
      ),
    ).toMatchObject({ scope: "BUSINESS_SYSTEM", tool: "outlook_list_messages" });
  });

  it("normalises typos and answers 2+2 locally", () => {
    expect(normaliseUserUtterance("whats our xero sales this mnth")).toMatch(/what's our xero sales this month/i);
    expect(answerArithmetic("what is 2+2")).toBe("4");
    expect(
      classifyScope("what is 2+2", buildConversationState({ userText: "what is 2+2" })),
    ).toMatchObject({ scope: "GENERAL_CONVERSATION", noTool: true });
  });

  it("generates useful conversation titles instead of raw prompts", () => {
    expect(titleFromUserText("What are our Xero sales this month?")).toBe("September Xero Sales");
    expect(titleFromUserText("What is the newest email in the info inbox?")).toBe("Latest Info Inbox Email");
    expect(titleFromUserText("hi")).toBe("New chat");
  });
});
