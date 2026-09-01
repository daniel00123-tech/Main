import { describe, expect, it } from "vitest";
import { enrichDocumentQuery } from "./intelligence/query-enrichment";
import {
  inferDocumentQaMode,
  sanitizeAskDocumentArguments,
  withAskDocumentTool,
} from "./ask-document";
import { outlookWriteExposure } from "./outlook-write-policy";
import { NONE_IN_DOCUMENT_REPLY, runGroundedQa, searchDocument } from "./whatsapp-grounded-qa";
import { toStandardFetchPayload } from "./mcp-knowledge-standard";
import type { Env } from "../env";

const POLICY = toStandardFetchPayload(
  {
    id: "doc_policy",
    title: "Vehicle use procedure",
    chunks: [
      {
        heading: "Purpose",
        text: "This vehicle-use procedure sets the rules for company vans used on customer jobs.",
      },
      {
        heading: "Authorised drivers",
        text: "Only employees with a current licence and a completed driver checklist may take a van off site.",
      },
      {
        heading: "Fuel",
        text: "Fuel cards are for company vans only. Drivers record fuel weekly and keep receipts.",
      },
    ],
  },
  "doc_policy",
);

const emptyEnv = {} as Env;

describe("ask_document tool surface", () => {
  it("advertises ask_document when knowledge tools exist and does not duplicate", () => {
    const advertised = withAskDocumentTool([
      { name: "search", description: "s", inputSchema: {} },
      { name: "fetch", description: "f", inputSchema: {} },
    ]);
    expect(advertised.map((tool) => tool.name)).toContain("ask_document");
    expect(withAskDocumentTool(advertised).filter((tool) => tool.name === "ask_document")).toHaveLength(1);
    expect(withAskDocumentTool([{ name: "system_health", description: "h", inputSchema: {} }]).map((tool) => tool.name)).toEqual([
      "system_health",
    ]);
  });

  it("sanitises documentId aliases and requires a question", () => {
    expect(sanitizeAskDocumentArguments({ id: "doc_1", query: "What is the purpose?" })).toEqual({
      documentId: "doc_1",
      question: "What is the purpose?",
      priorQuestion: null,
      title: null,
    });
    expect(sanitizeAskDocumentArguments({ documentId: "doc_1" })).toEqual({
      error: "ask_document requires a non-empty arguments.question",
    });
  });

  it("infers more_detail for short follow-ups that ask for more", () => {
    expect(inferDocumentQaMode("more detail")).toBe("more_detail");
    expect(inferDocumentQaMode("What is the purpose?")).toBe("answer");
  });
});

describe("document Q&A and short follow-ups", () => {
  it("answers a factual question from the selected document chunks", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "Who is allowed to drive a van?",
      documentId: "doc_policy",
      title: "Vehicle use procedure",
      fetch: POLICY,
      mode: "answer",
    });
    expect(qa.diagnostics.chunkCount).toBeGreaterThanOrEqual(3);
    expect(qa.diagnostics.selectedCount).toBeGreaterThan(0);
    expect(qa.confidence).not.toBe("none");
    expect(qa.reply).toMatch(/licence|checklist|employees/i);
    expect(qa.globalSearchUsed).toBe(false);
  });

  it("enriches what exactly / when and answers from the same document", async () => {
    const prior = "Who is allowed to drive a van?";
    const enriched = enrichDocumentQuery("what exactly?", {
      scope: "CURRENT_DOCUMENT",
      currentTitle: "Vehicle use procedure",
      previousUserText: prior,
      lastAnswerTopic: "document",
    });
    expect(enriched.enriched).toBe(true);
    const ranked = searchDocument("doc_policy", enriched.query, [
      {
        id: "c0",
        documentId: "doc_policy",
        text: "Only employees with a current licence and a completed driver checklist may take a van off site.",
        heading: "Authorised drivers",
        index: 0,
      },
      {
        id: "c1",
        documentId: "doc_policy",
        text: "The canteen menu changes on Fridays.",
        heading: "Welfare",
        index: 1,
      },
    ]);
    expect(ranked[0]?.id).toBe("c0");

    const qa = await runGroundedQa(emptyEnv, {
      question: "what exactly?",
      retrievalQuery: enriched.query,
      previousQuestion: prior,
      documentId: "doc_policy",
      title: "Vehicle use procedure",
      fetch: POLICY,
      mode: "answer",
    });
    expect(qa.diagnostics.underspecifiedFollowUp).toBe(true);
    expect(qa.confidence).not.toBe("none");
    expect(qa.reply).toMatch(/licence|checklist|van|employees/i);
  });

  it("does not keep a model none-copy when the document already has evidence", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "Who is allowed to drive a van?",
      documentId: "doc_policy",
      title: "Vehicle use procedure",
      fetch: POLICY,
      mode: "answer",
    });
    expect(qa.confidence).not.toBe("none");
    expect(qa.reply).not.toBe(NONE_IN_DOCUMENT_REPLY);
    expect(qa.reply).toMatch(/licence|checklist|employees|van/i);
  });

  it("says so when the selected document has no evidence and does not search globally", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "does it mention offshore drilling licenses?",
      documentId: "doc_policy",
      title: "Vehicle use procedure",
      fetch: POLICY,
      mode: "answer",
    });
    expect(qa.confidence).toBe("none");
    expect(qa.reply).toContain(NONE_IN_DOCUMENT_REPLY);
    expect(qa.globalSearchUsed).toBe(false);
  });
});

describe("Outlook write exposure policy", () => {
  it("keeps draft and send unexposed without a real Outlook draft/send executor", () => {
    const policy = outlookWriteExposure();
    expect(policy.draft).toBe("REQUIRES_ACTION_ENGINE_EXTENSION");
    expect(policy.send).toBe("TOOL_NOT_EXPOSED");
    expect(policy.actionEngineEmailSupport).toBe(false);
  });
});
