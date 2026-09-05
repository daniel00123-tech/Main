import { describe, expect, it } from "vitest";
import {
  answerFromExistingEvidence,
  classifyEvidenceNeed,
  extractEvidenceFromTools,
  shouldReuseSuccessfulTool,
  emailBodyRequired,
  emailEvidenceHasBody,
} from "./evidence.js";
import { buildConversationState } from "./state.js";

const emailResult = {
  name: "outlook_list_messages",
  ok: true,
  latencyMs: 12,
  data: {
    mailboxAddress: "info@elvexpropertyservices.com",
    messages: [
      {
        id: "msg_1",
        subject: "Leak detection quote",
        from: { emailAddress: { address: "ops@example.com", name: "Ops" } },
        receivedDateTime: "2026-09-04T09:00:00Z",
        body: "Please can you confirm availability for a leak survey next Tuesday?",
      },
    ],
  },
};

describe("structured evidence", () => {
  it("reuses a successful Outlook result instead of calling again", () => {
    const evidence = extractEvidenceFromTools([emailResult]);
    expect(evidence.recentEmail?.subject).toBe("Leak detection quote");
    expect(
      shouldReuseSuccessfulTool(
        { name: "outlook_list_messages", arguments: {} },
        { ...evidence, lastSuccessfulCalls: [{ name: "outlook_list_messages", argsHash: "outlook_list_messages:", summary: "ok" }] },
      ),
    ).toBe(true);
  });

  it("answers reply / shorter / friendlier / what were they asking from retained email", () => {
    const evidence = extractEvidenceFromTools([emailResult]);
    const state = buildConversationState({
      userText: "give a suggestion on what to reply",
      lastAnswerTopic: "email",
      currentBusinessSystem: "email",
      lastAnswerText: "The newest email is “Leak detection quote” from ops@example.com.",
      recentEvidence: evidence,
    });
    expect(classifyEvidenceNeed("give a suggestion on what to reply?", state)).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
    const draft = answerFromExistingEvidence("give a suggestion on what to reply?", state);
    expect(draft).toMatch(/Suggested reply|Thanks for your email/i);
    const shorter = answerFromExistingEvidence("make that shorter", {
      ...state,
      lastAnswerText: draft ?? "",
      lastUserText: "make that shorter",
    });
    expect(shorter && shorter.length < (draft ?? "").length).toBe(true);
    const asking = answerFromExistingEvidence("what were they asking for again?", state);
    expect(asking).toMatch(/leak|availability|survey/i);
  });

  it("requires a full message body for summarise/draft/asking follow-ups", () => {
    const listOnly = extractEvidenceFromTools([
      {
        ...emailResult,
        data: {
          mailboxAddress: "info@elvexpropertyservices.com",
          messages: [{ id: "msg_1", subject: "Quote", from: "ops@example.com", receivedDateTime: "2026-09-04T09:00:00Z" }],
        },
      },
    ]);
    const state = buildConversationState({
      userText: "what are they asking?",
      lastAnswerTopic: "email",
      currentBusinessSystem: "email",
      recentEvidence: listOnly,
    });
    expect(emailBodyRequired("what are they asking?")).toBe(true);
    expect(emailBodyRequired("what is the latest email subject?")).toBe(false);
    expect(emailEvidenceHasBody(listOnly)).toBe(false);
    expect(classifyEvidenceNeed("what are they asking?", state)).toBe("NEEDS_FRESH_DATA");
    expect(classifyEvidenceNeed("what is the latest email subject?", state)).toBe("NEEDS_FRESH_DATA");
    const withBody = extractEvidenceFromTools([emailResult]);
    expect(emailEvidenceHasBody(withBody)).toBe(true);
    expect(
      classifyEvidenceNeed(
        "draft a reply",
        buildConversationState({
          userText: "draft a reply",
          lastAnswerTopic: "email",
          currentBusinessSystem: "email",
          recentEvidence: withBody,
        }),
      ),
    ).toBe("CAN_ANSWER_FROM_EXISTING_EVIDENCE");
    expect(
      classifyEvidenceNeed(
        "Who sent the most recent finance mailbox email?",
        buildConversationState({
          userText: "Who sent the most recent finance mailbox email?",
          lastAnswerTopic: "email",
          currentBusinessSystem: "email",
          recentEvidence: listOnly,
        }),
      ),
    ).toBe("NEEDS_FRESH_DATA");
  });

  it("reuses the same invoice identity without an exact args hash", () => {
    const evidence = extractEvidenceFromTools([
      {
        name: "xero_get_invoice",
        ok: true,
        latencyMs: 8,
        data: { invoiceNumber: "INV-02268", Total: 162, Status: "AUTHORISED" },
      },
    ]);
    expect(
      shouldReuseSuccessfulTool({ name: "xero_get_invoice", arguments: { invoiceNumber: "INV-02268" } }, evidence),
    ).toBe(true);
  });
});
