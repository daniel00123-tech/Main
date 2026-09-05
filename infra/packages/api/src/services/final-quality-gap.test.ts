import { describe, expect, it } from "vitest";
import { portalChatErrorStatus } from "../routes/portal-chat";
import { classifyDailyTraffic, isGenuineCustomerTraffic, looksLikeAutomatedTestPrompt } from "./daily-improvement/traffic";
import { knowledgeHitMatchesQuery, logicalKnowledgeDocumentKey, mergeKnowledgeSearchHits } from "./company-knowledge-index";
import {
  detectRequestedCapabilities,
  wantsMultiCapabilityRead,
} from "./intelligence/company-tool-registry";
import { decomposeEvidenceNeeds, isSemanticKnowledgeAsk, minimumToolsForText } from "./intelligence/evidence-plan";
import {
  classifyEvidenceNeed,
  emailBodyRequired,
  emailEvidenceHasBody,
  shouldReuseSuccessfulTool,
} from "./intelligence/evidence";
import { classifyScope } from "./intelligence/scope";
import { buildConversationState } from "./intelligence/state";
import { isMailboxBlockingFailure } from "./outlook-attachment-ingest";
import { PortalChatError } from "./portal-chat";

const afterEmail = () =>
  buildConversationState({
    userText: "Show me the latest info email.",
    lastAnswerTopic: "email",
    currentScope: "BUSINESS_SYSTEM",
    currentBusinessSystem: "email",
    lastSuccessfulTool: "outlook_list_messages",
    recentEvidence: {
      companyId: "co_el",
      source: "outlook",
      capturedAt: "2026-09-05T08:00:00.000Z",
      recentEmail: {
        id: "msg-1",
        subject: "Invoice query",
        from: "info@example.com",
        receivedDateTime: "2026-09-05T07:00:00.000Z",
        mailboxAddress: "info@elvexpropertyservices.com",
        body: "",
        toolName: "outlook_list_messages",
      },
      recentXero: null,
      recentDocument: null,
      recentCatalogueItem: null,
      lastSuccessfulCalls: [{ name: "outlook_list_messages", argsHash: "outlook_list_messages:", summary: "listed" }],
    },
  });

const afterEmailWithBody = () => {
  const state = afterEmail();
  state.recentEvidence = {
    ...state.recentEvidence!,
    recentEmail: {
      ...state.recentEvidence!.recentEmail!,
      body: "Please confirm the outstanding balance on INV-02277 and send a remittance when paid.",
    },
  };
  return state;
};

const afterXero = () =>
  buildConversationState({
    userText: "Tell me Xero sales this month.",
    lastAnswerTopic: "finance",
    currentScope: "BUSINESS_SYSTEM",
    currentBusinessSystem: "xero",
    lastSuccessfulTool: "xero_sales_summary",
  });

describe("telemetry classification", () => {
  it("classifies live portal, whatsapp, and chatgpt as customer unless marked otherwise", () => {
    expect(classifyDailyTraffic({ sourceClient: "portal_chat", userId: "user_1", userAgent: "Mozilla/5.0" })).toBe(
      "CUSTOMER_REQUEST",
    );
    expect(classifyDailyTraffic({ sourceClient: "whatsapp", userId: "user_2" })).toBe("CUSTOMER_REQUEST");
    expect(classifyDailyTraffic({ sourceClient: "chatgpt", userId: "user_3" })).toBe("CUSTOMER_REQUEST");
  });

  it("keeps acceptance and quality traffic out of the customer slice", () => {
    expect(classifyDailyTraffic({ sourceClient: "portal_chat", userAgent: "InfraAcceptance/1.0" })).toBe("TEST");
    expect(classifyDailyTraffic({ sourceClient: "portal_chat", trafficClass: "TEST" })).toBe("TEST");
    expect(classifyDailyTraffic({ sourceClient: "quality_loop" })).toBe("QUALITY");
    expect(classifyDailyTraffic({ shadow: true, sourceClient: "portal_chat" })).toBe("SHADOW");
    expect(isGenuineCustomerTraffic("TEST")).toBe(false);
    expect(isGenuineCustomerTraffic("CUSTOMER_REQUEST")).toBe(true);
  });

  it("does not treat a unique live portal prompt as TEST just because it mentions email", () => {
    expect(
      classifyDailyTraffic({
        sourceClient: "portal_chat",
        userId: "user_live",
        userAgent: "Mozilla/5.0",
        userMessage: "Can you check what Sharon asked me this morning?",
      }),
    ).toBe("CUSTOMER_REQUEST");
  });

  it("does not promote fingerprint prompts without a live user-agent", () => {
    expect(
      looksLikeAutomatedTestPrompt("What are our Xero sales this month?"),
    ).toBe(true);
    expect(
      classifyDailyTraffic({
        sourceClient: "portal_chat",
        userMessage: "What are our Xero sales this month?",
      }),
    ).toBe("TEST");
  });
});

describe("outlook body sufficiency", () => {
  it.each([
    "What are they asking?",
    "What does it say?",
    "Summarise that.",
    "Draft me a reply.",
    "What did they want?",
    "Full email please",
  ])("requires a full body for %s", (text) => {
    expect(emailBodyRequired(text)).toBe(true);
    expect(classifyEvidenceNeed(text, afterEmail())).toBe("NEEDS_FRESH_DATA");
  });

  it("does not require a body for a latest-email listing", () => {
    expect(emailBodyRequired("Show me the latest info email.")).toBe(false);
    expect(classifyEvidenceNeed("Show me the latest info email.", afterEmail())).toBe("NEEDS_FRESH_DATA");
  });

  it("reuses retained body for reply edits", () => {
    const state = afterEmailWithBody();
    expect(emailEvidenceHasBody(state.recentEvidence)).toBe(true);
    expect(classifyEvidenceNeed("draft me a reply", state)).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
    expect(classifyEvidenceNeed("shorter", state)).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
    expect(classifyEvidenceNeed("friendlier", state)).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
    expect(classifyEvidenceNeed("make it more direct", state)).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
  });
});

describe("conversational correction", () => {
  it.each([
    ["No, I meant the email.", "outlook_list_messages"],
    ["Check Outlook instead.", /^outlook_/],
    ["Not Xero — the message.", /^outlook_/],
    ["Sorry, I meant that document.", "search_company_knowledge"],
    ["No, look at the invoice.", /^xero_/],
  ])("replans %s without a clarification", (text, tool) => {
    const decision = classifyScope(text, afterXero());
    expect(decision.clarify).toBe(false);
    if (typeof tool === "string") expect(decision.tool).toBe(tool);
    else expect(decision.tool).toMatch(tool);
  });

  it("replans a period correction onto finance", () => {
    const decision = classifyScope("I meant last month, not this month.", afterXero());
    expect(decision.clarify).toBe(false);
    expect(decision.tool).toMatch(/^xero_|^warehouse_/);
  });
});

describe("mixed multi-tool requests", () => {
  it("decomposes Xero + Outlook", () => {
    const text = "What were March sales and what is the latest finance email about?";
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    const families = detectRequestedCapabilities(text);
    expect(families.some((row) => row.startsWith("ACCOUNTING"))).toBe(true);
    expect(families.some((row) => row.startsWith("EMAIL"))).toBe(true);
  });

  it("decomposes warehouse + Outlook remittance", () => {
    const text = "Give me last month’s sales and summarise the most recent remittance email.";
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    expect(detectRequestedCapabilities(text).some((row) => row.startsWith("EMAIL"))).toBe(true);
  });

  it("decomposes knowledge + Outlook", () => {
    const text = "Check the health and safety policy and tell me if the latest customer email relates to it.";
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    const families = detectRequestedCapabilities(text);
    expect(families).toContain("KNOWLEDGE_SEARCH");
    expect(families.some((row) => row.startsWith("EMAIL"))).toBe(true);
    expect(families).not.toContain("CATALOGUE_LIST");
  });

  it("decomposes Xero + Knowledge", () => {
    const text = "What were last month’s sales and what does the finance admin guide say?";
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    const families = detectRequestedCapabilities(text);
    expect(families.some((row) => row.startsWith("ACCOUNTING"))).toBe(true);
    expect(families).toContain("KNOWLEDGE_SEARCH");
    expect(minimumToolsForText(text)).not.toContain("list_documents");
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
  });

  it("does not treat a single sales ask as multi-tool", () => {
    expect(wantsMultiCapabilityRead("What are our Xero sales this month?")).toBe(false);
  });
});

describe("knowledge logical dedupe", () => {
  it("merges local and SharePoint copies of the same business file", () => {
    const merged = mergeKnowledgeSearchHits(
      [{ id: "18", title: "INV-02277.pdf", filename: "INV-02277.pdf" }],
      [{ id: "01C735QIFULDNFD4JHNZGZCUWSHUY5JUOO", title: "INV-02277__5b51ab7ca9.pdf", filename: "INV-02277__5b51ab7ca9.pdf" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("18");
    expect(merged[0]?.provenance?.[0]?.title).toMatch(/INV-02277__/);
    expect(logicalKnowledgeDocumentKey({ title: "INV-02277__5b51ab7ca9.pdf" })).toBe(
      logicalKnowledgeDocumentKey({ filename: "INV-02277.pdf" }),
    );
  });

  it("keeps a named policy hit when the question adds extra natural-language words", () => {
    const hit = { title: "Health and Safety Policy (2).docx", filename: "Health and Safety Policy (2).docx", snippet: "" };
    expect(knowledgeHitMatchesQuery(hit, "what does the health and safety policy say about accidents")).toBe(true);
    expect(knowledgeHitMatchesQuery(hit, "how do we report an accident at work")).toBe(true);
    expect(knowledgeHitMatchesQuery(hit, "what should staff do after an accident at work?")).toBe(true);
    expect(knowledgeHitMatchesQuery(hit, "intergalactic onboarding fees zzzxq-99999")).toBe(false);
  });

  it("keeps distinct documents", () => {
    const merged = mergeKnowledgeSearchHits(
      [{ id: "16", title: "Elvex_Finance_Admin_AI_Knowledge_Base.docx" }],
      [{ id: "31", title: "Health and Safety Policy (2).docx" }],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("lauren/mailbox scan health", () => {
  it("does not treat extract/index/verify misses as a mailbox outage", () => {
    expect(isMailboxBlockingFailure("RETRIEVAL_UNVERIFIED")).toBe(false);
    expect(isMailboxBlockingFailure("NOT_INDEXED")).toBe(false);
    expect(isMailboxBlockingFailure("INDEX_WRITE_FAILED")).toBe(false);
    expect(isMailboxBlockingFailure("SKIP_INLINE")).toBe(false);
  });

  it("still treats Graph fetch/enum failures as mailbox-blocking", () => {
    expect(isMailboxBlockingFailure("FETCH_FAILED")).toBe(true);
    expect(isMailboxBlockingFailure("ATTACHMENT_ENUM_FAILED")).toBe(true);
    expect(isMailboxBlockingFailure("FETCH_TRANSIENT")).toBe(true);
  });
});

describe("tool-result reuse", () => {
  it("reuses a successful xero_get_invoice in the same turn", () => {
    const evidence = {
      companyId: "co_el",
      source: "xero",
      capturedAt: "2026-09-05T08:00:00.000Z",
      recentEmail: null,
      recentXero: { label: "INV-02277", fromDate: null, toDate: null, toolName: "xero_get_invoice" },
      recentDocument: null,
      recentCatalogueItem: null,
      lastSuccessfulCalls: [{ name: "xero_get_invoice", argsHash: "xero_get_invoice:invoice=INV-02277", summary: "ok" }],
    };
    expect(
      shouldReuseSuccessfulTool({ name: "xero_get_invoice", arguments: { invoiceNumber: "INV-02277" } }, evidence),
    ).toBe(true);
    expect(
      shouldReuseSuccessfulTool({ name: "xero_get_invoice", arguments: { InvoiceID: "INV-02277" } }, evidence),
    ).toBe(true);
    expect(
      shouldReuseSuccessfulTool({ name: "xero_get_invoice", arguments: { invoiceNumber: "INV-00001" } }, evidence),
    ).toBe(false);
  });
});

describe("outlook body bank", () => {
  it.each([
    "What are they asking?",
    "What does that email say?",
    "Summarise the message.",
    "Draft a reply",
    "What did they ask for?",
    "Show the full body",
    "Respond to that",
    "What is the email asking?",
    "Can you summarise it?",
    "Write a reply to them",
  ])("body required: %s", (text) => {
    expect(emailBodyRequired(text)).toBe(true);
  });
});

describe("correction bank", () => {
  it.each([
    "No, I meant the email.",
    "Check Outlook instead.",
    "Not Xero — the message.",
    "Sorry, I meant that document.",
    "No, look at the invoice.",
    "I meant last month, not this month.",
    "I meant the email",
    "No, check the inbox instead.",
    "I was talking about the email.",
    "No I meant Xero sales",
  ])("replans %s", (text) => {
    const decision = classifyScope(text, afterXero());
    expect(decision.clarify).toBe(false);
    expect(decision.tool).toBeTruthy();
  });
});

describe("mixed multi-tool bank", () => {
  it.each([
    "What were March sales and what is the latest finance email about?",
    "Check the health and safety policy and tell me if the latest customer email relates to it.",
    "Give me last month’s sales and summarise the most recent remittance email.",
    "Xero sales this month and the latest finance email",
    "What were last month’s sales and what does the finance admin guide say?",
    "Search the inbox for PO and tell me overdue invoices",
    "Latest info email and health and safety policy",
    "Warehouse sales last quarter and the newest finance mailbox item",
    "Outstanding invoices and the latest remittance email",
    "March sales plus the finance admin knowledge document",
    "Last month sales and newest customer email",
    "Policy on invoices and the latest finance email",
    "Xero overdue and Outlook unread in finance",
    "Health and safety policy and latest info inbox email",
    "Sales this month then the latest email",
  ])("mixed: %s", (text) => {
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    expect(minimumToolsForText(text).length).toBeGreaterThanOrEqual(2);
    expect(decomposeEvidenceNeeds(text).length).toBeGreaterThanOrEqual(2);
  });
});

describe("reliability and isolation bank", () => {
  it.each(["TEST", "QUALITY", "SHADOW", "ENGINEERING", "AUTOMATION", "HEALTH", "INTERNAL"])(
    "non-customer class %s is not genuine customer traffic",
    (traffic) => {
      expect(isGenuineCustomerTraffic(traffic)).toBe(false);
    },
  );

  it("CUSTOMER_REQUEST remains genuine", () => {
    expect(isGenuineCustomerTraffic("CUSTOMER_REQUEST")).toBe(true);
  });

  it.each([
    ["INV-02277.pdf", "INV-02277__5b51ab7ca9.pdf"],
    ["Finance Admin.docx", "Finance Admin__abc123.docx"],
    ["Health and Safety Policy (2).docx", "Health and Safety Policy (2)__deadbeef.docx"],
  ])("dedupes %s with %s", (left, right) => {
    expect(logicalKnowledgeDocumentKey({ filename: left })).toBe(logicalKnowledgeDocumentKey({ filename: right }));
  });

  it("maps conversation-not-found to 404, not 500", () => {
    expect(portalChatErrorStatus(new PortalChatError("Conversation not found", 404))).toBe(404);
    expect(portalChatErrorStatus(new PortalChatError("Message cannot be empty", 400))).toBe(400);
  });
});
