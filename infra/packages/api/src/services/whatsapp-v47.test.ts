import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { suggestionButtons } from "./whatsapp-buttons";
import {
  answerFromDocument,
  compressDocumentAnswer,
  extractKeyFacts,
  inferRelatesTo,
  wantsFullDetail,
} from "./whatsapp-compress";
import { documentEntityFromHit, extractAmount, extractReference } from "./whatsapp-entities";
import {
  isNegativeResultFeedback,
  looksLikeCurrentDocumentQuestion,
  planWhatsAppTurn,
  refersToCurrentDocument,
} from "./whatsapp-plan";
import { applyWhatsAppWatchdogStage } from "./whatsapp-reaper";
import { memoryFactReply } from "./whatsapp-synthesize";
import { evaluateWatchdogProgressGate } from "./whatsapp-watchdog";
import { DELAY_NOTICE_MS, HARD_TIMEOUT_MS, PROGRESS_AFTER_MS, PROGRESS_MIN_INTERVAL_MS } from "./whatsapp-latency";

const CV_BODY = [
  "Mobile: 07932609444 Email: Full Clean UK driving licence",
  "From an elite military background to an eCommerce corporate role.",
  "Time management, business acumen, sales hungry, leader and manager of people.",
  "A person who has a consistent incline in results.",
  "I take pride in being an effective operator and in developing the people around me.",
  "Responsible for store performance, team coaching, and weekly trading reviews.",
  "References",
].join(" ");

const PAYMENT_BODY =
  "Thank you, Your payment was successful. Amount £49.92 GBP Order id: CAD021/01 coal search";

const LAST_DOC = {
  lastDocument: {
    id: "gdrive-1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk",
    title: "Staff profile 2015",
    url: "https://docs.google.com/document/d/1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk/edit?usp=drivesdk",
    excerpt: CV_BODY.slice(0, 220),
    amount: null,
    reference: null,
    sourceLabel: "Staff profile 2015",
  },
};

describe("WhatsApp V4.7 progress cadence", () => {
  it("keeps progress at least one minute after ACK and outside the hard timeout", () => {
    expect(PROGRESS_MIN_INTERVAL_MS).toBe(60_000);
    expect(PROGRESS_AFTER_MS).toBeGreaterThanOrEqual(60_000);
    expect(DELAY_NOTICE_MS).toBeGreaterThanOrEqual(60_000);
    expect(HARD_TIMEOUT_MS).toBe(60_000);
    expect(PROGRESS_AFTER_MS).toBeGreaterThanOrEqual(HARD_TIMEOUT_MS);
  });

  it("blocks progress immediately after ACK, after a result, and within 60s of a prior status", () => {
    const now = Date.parse("2026-08-30T13:27:00.000Z");
    expect(
      evaluateWatchdogProgressGate({
        acknowledgementSentAt: "2026-08-30T13:26:20.000Z",
        firstVisibleAt: "2026-08-30T13:26:20.000Z",
        nowMs: now,
      }).reason,
    ).toBe("too_soon_after_ack");
    expect(
      evaluateWatchdogProgressGate({
        replySentAt: "2026-08-30T13:26:50.000Z",
        nowMs: now,
      }).reason,
    ).toBe("result_already_sent");
    expect(
      evaluateWatchdogProgressGate({
        progressSentAt: "2026-08-30T13:26:30.000Z",
        nowMs: now,
      }).reason,
    ).toBe("progress_min_interval");
    expect(
      evaluateWatchdogProgressGate({
        acknowledgementSentAt: "2026-08-30T13:25:00.000Z",
        nowMs: now,
      }).allow,
    ).toBe(true);
  });

  it("queue t15 after a recent ACK does not send a stacked Still searching line", async () => {
    const env = {
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: "1338434179351224",
      WHATSAPP_OUTBOUND_AI_ENABLED: "true",
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return {
                sender_e164: "+447932609444",
                first_visible_at: new Date().toISOString(),
                acknowledgement_sent_at: new Date().toISOString(),
                reply_sent_at: null,
                terminal_state: null,
                identity_found: 1,
                progress_sent_at: null,
                delay_sent_at: null,
              };
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;
    const result = await applyWhatsAppWatchdogStage(env, {
      eventId: "wa_evt_v47",
      wamid: "wamid.HBgM12_47",
      stage: "t15",
      receivedAt: new Date(Date.now() - 16_000).toISOString(),
    });
    expect(result.acted).toBe(false);
    expect(result.reason).toMatch(/too_soon_after_ack|conversation_progress_interval/);
  });
});

describe("WhatsApp V4.7 document cards and extracts", () => {
  it("does not stuff contact fragments or heading remnants into Amount/Reference", () => {
    expect(extractKeyFacts(CV_BODY)).toEqual({});
    expect(extractAmount(CV_BODY)).toBeNull();
    expect(extractReference("References")).toBeNull();
    expect(extractReference("Reference: erences")).toBeNull();
    const entity = documentEntityFromHit({
      id: "doc_1",
      title: "Staff profile 2015",
      text: `${CV_BODY} Amount: £20`,
    });
    expect(entity.amount).toBeNull();
    expect(entity.reference).toBeNull();
  });

  it("still extracts invoice facts from a payment confirmation", () => {
    expect(extractKeyFacts(PAYMENT_BODY)).toMatchObject({
      amount: expect.stringMatching(/£\s?49\.92/),
      reference: "CAD021/01",
    });
    expect(extractAmount(PAYMENT_BODY)).toMatch(/£\s?49\.92/);
    expect(extractReference(PAYMENT_BODY)).toBe("CAD021/01");
  });

  it("does not treat a contact line as the document relate-to sentence", () => {
    const relates = inferRelatesTo("Staff profile 2015", CV_BODY);
    expect(relates).not.toMatch(/mobile:\s*0793/i);
    expect(relates).not.toMatch(/email:\s*full clean/i);
    expect(relates).not.toMatch(/reference:\s*erences/i);
  });

  it("summarise is a real extract, not the same contact dump as the found card", () => {
    const found = compressDocumentAnswer({
      title: "Staff profile 2015",
      text: CV_BODY,
      question: "find the staff profile",
    });
    const summary = compressDocumentAnswer({
      title: "Staff profile 2015",
      text: CV_BODY,
      question: "summarise it",
    });
    const detail = compressDocumentAnswer({
      title: "Staff profile 2015",
      text: CV_BODY,
      question: "give me more detail",
    });
    expect(wantsFullDetail("give me more detail")).toBe(true);
    expect(found).not.toMatch(/• Amount:|• Reference: erences/i);
    expect(summary).not.toMatch(/Would you like me to summarise it/i);
    expect(summary).not.toMatch(/Email:\s*Full Clean UK driving licence/i);
    expect(summary).toMatch(/military|eCommerce|leader/i);
    expect(detail.length).toBeGreaterThan(summary.length);
    expect(detail).not.toMatch(/Email:\s*Full Clean UK driving licence/i);
  });
});

describe("WhatsApp V4.7 follow-up and feedback planning", () => {
  it("reads the open document for in-this-document questions instead of searching the corpus", () => {
    expect(refersToCurrentDocument("in this document was Alex in marketing?")).toBe(true);
    expect(looksLikeCurrentDocumentQuestion("in this document was Alex in marketing and what did they do")).toBe(true);
    const plan = planWhatsAppTurn({
      text: "in this document was Alex in marketing and what did they do in marketing?",
      memory: LAST_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.action).toBe("memory_fact");
    expect(plan.fact).toBe("answer");
    expect(plan.fetch).toBe(true);
    expect(plan.tool).toBe("get_knowledge_document");
    expect(plan.skipTools).toBe(false);
  });

  it("does not treat negative feedback as a new document title search", () => {
    expect(isNegativeResultFeedback("that’s not what I asked")).toBe(true);
    expect(isNegativeResultFeedback("not really good, this is about something else not to do with it")).toBe(true);
    expect(isNegativeResultFeedback("find Coal Search")).toBe(false);
    const poor = planWhatsAppTurn({
      text: "that’s not what I asked",
      memory: LAST_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(poor.action).toBe("clarify");
    expect(poor.skipTools).toBe(true);
    expect(poor.tool).toBeNull();
    expect(poor.clarification).toMatch(/still have/i);
    const other = planWhatsAppTurn({
      text: "not really good, this is about something else not to do with it",
      memory: LAST_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(other.action).toBe("clarify");
    expect(other.skipTools).toBe(true);
  });

  it("still searches a newly named document", () => {
    const plan = planWhatsAppTurn({
      text: "find Coal Search",
      memory: LAST_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.action).toBe("knowledge");
    expect(plan.query.toLowerCase()).toMatch(/coal search/);
  });

  it("answers from fetched body and admits when the topic is absent", () => {
    const missing = answerFromDocument({
      title: "Staff profile 2015",
      text: CV_BODY,
      question: "in this document was Alex in marketing and what did they do in marketing?",
    });
    expect(missing).toMatch(/does not mention .*marketing/i);
    expect(missing).not.toMatch(/affluent|online responses/i);
    const present = answerFromDocument({
      title: "Staff profile 2015",
      text: `${CV_BODY} Later moved into a field sales role covering the south east.`,
      question: "what did they do in sales?",
    });
    expect(present).toMatch(/sales/i);
    expect(present).not.toMatch(/does not mention/i);
    const reply = memoryFactReply(
      {
        action: "memory_fact",
        intent: "clarification",
        tool: "get_knowledge_document",
        query: "marketing",
        fetch: true,
        skipTools: false,
        useMemory: true,
        needsGuidance: false,
        clarification: null,
        fact: "answer",
        draftKind: null,
      },
      LAST_DOC,
      CV_BODY,
      "in this document was Alex in marketing?",
    );
    expect(reply).toMatch(/does not mention .*marketing/i);
  });
});

describe("WhatsApp V4.7 remaining actions after summarise or more detail", () => {
  it("does not re-offer the action just completed", () => {
    const afterSummary = suggestionButtons({
      kind: "document",
      hasSourceUrl: true,
      contextToken: "ctx_ab12cd34ef56",
      completedAction: "summarise",
    });
    expect(afterSummary.map((button) => button.title)).toEqual(["Open source", "More detail"]);
    const afterDetail = suggestionButtons({
      kind: "document",
      hasSourceUrl: true,
      contextToken: "ctx_ab12cd34ef56",
      completedAction: "more_detail",
    });
    expect(afterDetail.map((button) => button.title)).toEqual(["Summarise", "Open source"]);
    const initial = suggestionButtons({
      kind: "document",
      hasSourceUrl: true,
      contextToken: "ctx_ab12cd34ef56",
    });
    expect(initial.map((button) => button.title)).toEqual(["Summarise", "Open source", "More detail"]);
  });
});
