import { describe, expect, it } from "vitest";
import {
  answerFromExistingEvidence,
  classifyEvidenceNeed,
  extractEvidenceFromTools,
  shouldReuseSuccessfulTool,
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
});
