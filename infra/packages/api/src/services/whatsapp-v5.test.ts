import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { toStandardFetchPayload } from "./mcp-knowledge-standard";
import { suggestionButtons } from "./whatsapp-buttons";
import { documentEntityFromHit } from "./whatsapp-entities";
import {
  NONE_IN_DOCUMENT_REPLY,
  classifyDocument,
  rejectWeakSearchHits,
  runGroundedQa,
  searchDocument,
  structuralChunk,
} from "./whatsapp-grounded-qa";
import { inspectGroundedQaProvider } from "./whatsapp-llm";
import { HARD_TIMEOUT_MS, PROGRESS_AFTER_MS, PROGRESS_MIN_INTERVAL_MS } from "./whatsapp-latency";
import {
  looksLikeCurrentDocumentQuestion,
  looksLikeSearchOtherDocs,
  planWhatsAppTurn,
} from "./whatsapp-plan";
import { detectQualitySignals } from "./quality-auditor";

const CV_CHUNKS = [
  {
    heading: "Profile",
    text: "Alex Rivera is a commercial operator with a military background and later retail leadership experience.",
  },
  {
    heading: "Field sales 2014-2015",
    text: "Field sales executive covering the south east. Generated new accounts, ran weekly pipeline reviews, and coached two junior reps.",
  },
  {
    heading: "Store leadership 2012-2014",
    text: "Store manager responsible for weekly trading reviews, staff coaching, and conversion improvement.",
  },
  {
    heading: "Skills",
    text: "People leadership, pipeline discipline, and customer development. Email: alex.rivera@example.test Mobile: 07700900123",
  },
];

const POLICY_CHUNKS = [
  {
    heading: "Purpose",
    text: "This vehicle-use procedure sets the rules for company vans used on customer jobs.",
  },
  {
    heading: "Authorised drivers",
    text: "Only employees with a current licence and a completed driver checklist may take a van off site.",
  },
  {
    heading: "Fuel and incidents",
    text: "Fuel cards are for company vans only. Accidents must be reported to the operations desk before the next shift.",
  },
];

const CV_DOC = {
  lastDocument: {
    id: "doc_fixture_cv",
    title: "Staff profile fixture",
    url: "https://example.test/staff-profile",
    excerpt: CV_CHUNKS[0]!.text.slice(0, 120),
    amount: null,
    reference: null,
    sourceLabel: "Staff profile fixture",
    documentClass: "cv_resume" as const,
  },
};

const POLICY_DOC = {
  lastDocument: {
    id: "doc_fixture_policy",
    title: "Vehicle use procedure",
    url: "https://example.test/vehicle-use",
    excerpt: POLICY_CHUNKS[0]!.text.slice(0, 80),
    amount: null,
    reference: null,
    sourceLabel: "Vehicle use procedure",
    documentClass: "policy_procedure" as const,
  },
};

function cvFetch() {
  return toStandardFetchPayload(
    {
      id: "doc_fixture_cv",
      title: "Staff profile fixture",
      chunks: CV_CHUNKS.map((chunk) => ({ heading: chunk.heading, text: chunk.text })),
    },
    "doc_fixture_cv",
  );
}

function policyFetch() {
  return toStandardFetchPayload(
    {
      id: "doc_fixture_policy",
      title: "Vehicle use procedure",
      chunks: POLICY_CHUNKS.map((chunk) => ({ heading: chunk.heading, text: chunk.text })),
    },
    "doc_fixture_policy",
  );
}

const emptyEnv = {} as Env;

describe("WhatsApp V5 planner intents", () => {
  it("finds a newly named document with company search", () => {
    const plan = planWhatsAppTurn({
      text: "find Vehicle use procedure",
      memory: CV_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(["knowledge", "guidance"]).toContain(plan.action);
    expect(plan.tool).toBe("search_company_knowledge");
    expect(plan.useMemory).toBe(false);
  });

  it("keeps current-document questions on the open file even when a new keyword appears", () => {
    expect(looksLikeCurrentDocumentQuestion("was Alex in marketing and what did they do?")).toBe(true);
    const plan = planWhatsAppTurn({
      text: "was Alex in marketing and what did they do?",
      memory: CV_DOC,
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.action).toBe("memory_fact");
    expect(plan.tool).toBe("get_knowledge_document");
    expect(plan.fetch).toBe(true);
    expect(plan.useMemory).toBe(true);
  });

  it("treats why/when/experience/does it mention as current-document questions", () => {
    for (const text of [
      "what experience does it mention?",
      "what responsibilities did they have?",
      "does it mention coaching?",
      "when did they manage a store?",
    ]) {
      const plan = planWhatsAppTurn({ text, memory: CV_DOC, connectors: [] });
      expect(plan.action).toBe("memory_fact");
      expect(plan.tool).toBe("get_knowledge_document");
    }
  });

  it("asks which document when a pronoun question has no open file", () => {
    const plan = planWhatsAppTurn({
      text: "was he in marketing?",
      memory: {},
      connectors: [],
    });
    expect(plan.action).toBe("clarify");
    expect(plan.skipTools).toBe(true);
  });

  it("search other docs is an explicit global broaden", () => {
    expect(looksLikeSearchOtherDocs("search other documents")).toBe(true);
    const plan = planWhatsAppTurn({
      text: "search other documents",
      memory: { ...CV_DOC, lastUserQuestion: "was Alex in marketing?" },
      connectors: [],
    });
    expect(plan.action).toBe("knowledge");
    expect(plan.query).toMatch(/marketing/i);
    expect(plan.useMemory).toBe(false);
  });
});

describe("WhatsApp V5 document-scoped retrieval", () => {
  it("searchDocument only returns chunks for the requested document_id", () => {
    const mixed = [
      ...structuralChunk(CV_CHUNKS.map((chunk) => `${chunk.heading}\n${chunk.text}`).join("\n\n"), "doc_fixture_cv"),
      ...structuralChunk(POLICY_CHUNKS.map((chunk) => `${chunk.heading}\n${chunk.text}`).join("\n\n"), "doc_fixture_policy"),
    ];
    const hits = searchDocument("doc_fixture_cv", "what did they do in sales?", mixed);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((chunk) => chunk.documentId === "doc_fixture_cv")).toBe(true);
    expect(hits.some((chunk) => /sales/i.test(chunk.text))).toBe(true);
  });

  it("preserves fetch chunks instead of a short preview", () => {
    const fetched = cvFetch();
    expect(fetched.chunks?.length).toBeGreaterThan(2);
    expect(fetched.text.length).toBeGreaterThan(200);
    expect(fetched.text).toMatch(/Field sales|Store manager/i);
  });

  it("structural chunking keeps headings with following paragraphs", () => {
    const text = ["Authorised drivers", "Only employees with a current licence may drive.", "", "Fuel and incidents", "Fuel cards are for company vans only."].join("\n");
    const chunks = structuralChunk(text, "doc_struct");
    expect(chunks.some((chunk) => /Authorised drivers/i.test(chunk.text) && /licence/i.test(chunk.text))).toBe(true);
  });
});

describe("WhatsApp V5 grounded synthesis", () => {
  it("answers a current-document question from CV evidence and does not invent", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "was Alex in sales and what did they do?",
      documentId: "doc_fixture_cv",
      title: "Staff profile fixture",
      fetch: cvFetch(),
      mode: "answer",
    });
    expect(qa.scoped).toBe(true);
    expect(qa.globalSearchUsed).toBe(false);
    expect(qa.confidence).not.toBe("none");
    expect(qa.reply).toMatch(/sales|accounts|pipeline/i);
    expect(qa.reply).not.toMatch(/van|fuel card/i);
    expect(qa.reply).not.toMatch(/alex\.rivera@example\.test|07700900123/);
    expect(qa.synthesisMode === "extractive_fallback" || qa.synthesisMode === "model").toBe(true);
  });

  it("returns none confidence without searching other documents", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "does it mention offshore drilling licenses?",
      documentId: "doc_fixture_cv",
      title: "Staff profile fixture",
      fetch: cvFetch(),
      mode: "answer",
    });
    expect(qa.confidence).toBe("none");
    expect(qa.reply).toContain(NONE_IN_DOCUMENT_REPLY);
    expect(qa.globalSearchUsed).toBe(false);
  });

  it("summarises meaningful content and more detail adds new information", async () => {
    const summary = await runGroundedQa(emptyEnv, {
      question: "summarise it",
      documentId: "doc_fixture_cv",
      title: "Staff profile fixture",
      fetch: cvFetch(),
      mode: "summarise",
    });
    expect(summary.reply).toMatch(/• /);
    expect(summary.reply).toMatch(/military|retail|sales|manager/i);
    const detail = await runGroundedQa(emptyEnv, {
      question: "give me more detail",
      documentId: "doc_fixture_cv",
      title: "Staff profile fixture",
      fetch: cvFetch(),
      mode: "more_detail",
      previousAnswer: summary.reply,
    });
    expect(detail.moreDetailNovel).toBe(true);
    expect(detail.reply).not.toEqual(summary.reply);
    expect(detail.reply.length).toBeGreaterThan(40);
  });

  it("answers a policy question from the policy document only", async () => {
    const qa = await runGroundedQa(emptyEnv, {
      question: "who is allowed to drive a van?",
      documentId: "doc_fixture_policy",
      title: "Vehicle use procedure",
      fetch: policyFetch(),
      mode: "answer",
    });
    expect(qa.reply).toMatch(/licence|checklist|employees/i);
    expect(qa.reply).not.toMatch(/Alex Rivera|pipeline/i);
  });
});

describe("WhatsApp V5 buttons, PII, ranking, and model boundary", () => {
  it("offers More on this / Search other docs / Open source after a grounded answer", () => {
    const buttons = suggestionButtons({
      kind: "document",
      variant: "grounded",
      hasSourceUrl: true,
      contextToken: "ctx_ab12cd34ef56",
    });
    expect(buttons.map((button) => button.title)).toEqual(["More on this", "Search other docs", "Open source"]);
  });

  it("after no-evidence offers Search other docs instead of auto-searching", () => {
    const buttons = suggestionButtons({
      kind: "document",
      variant: "none",
      hasSourceUrl: true,
      contextToken: "ctx_ab12cd34ef56",
    });
    expect(buttons.map((button) => button.title)).toEqual(["Search other docs", "Open source"]);
  });

  it("does not apply invoice facts to a CV entity", () => {
    const entity = documentEntityFromHit({
      id: "doc_fixture_cv",
      title: "Staff profile fixture",
      text: `${CV_CHUNKS.map((chunk) => chunk.text).join(" ")} Amount: £20`,
    });
    expect(entity.documentClass).toBe("cv_resume");
    expect(entity.amount).toBeNull();
    expect(entity.reference).toBeNull();
    expect(classifyDocument({ title: "Vehicle use procedure", text: POLICY_CHUNKS[0]!.text })).toBe("policy_procedure");
  });

  it("ranks a CV query above an unrelated year-matched marketing file", () => {
    const kept = rejectWeakSearchHits(
      [
        { id: "mkt", title: "VHL 2015 Marketing Review FINAL.pdf", snippet: "campaign review" },
        { id: "cv", title: "CV 2015 1", snippet: "curriculum vitae" },
      ],
      "CV 2015",
    );
    expect(kept[0]?.id).toBe("cv");
  });

  it("rejects weak global hits below the confidence threshold", () => {
    const kept = rejectWeakSearchHits(
      [
        { id: "unrelated", title: "Marketing to affluent households.xlsx", snippet: "campaign list" },
        { id: "match", title: "Staff profile fixture", snippet: "commercial operator" },
      ],
      "staff profile fixture",
    );
    expect(kept.map((hit) => hit.id)).toEqual(["match"]);
  });

  it("does not invent an LLM credential and reports none when unconfigured", () => {
    const inspected = inspectGroundedQaProvider({} as Env);
    expect(inspected.provider).toBe("none");
    expect(inspected.configured).toBe(false);
    expect(inspected.model).toBeNull();
  });

  it("records negative feedback against the preceding answer", () => {
    const signals = detectQualitySignals({
      interactionId: "int_feedback",
      companyId: "co_caddington",
      usage: [
        {
          toolName: "whatsapp.send",
          success: true,
          durationMs: 1200,
          metadata: {
            channel: "whatsapp",
            negativeResultFeedback: true,
            precedingAnswerText: "I found Marketing to affluent households.xlsx",
            topicCorrected: true,
          },
        },
      ],
    });
    expect(signals.map((signal) => signal.category)).toEqual(
      expect.arrayContaining(["whatsapp_negative_result_feedback", "whatsapp_topic_correction"]),
    );
  });

  it("keeps 60s progress and a 120s terminal budget", () => {
    expect(PROGRESS_MIN_INTERVAL_MS).toBe(60_000);
    expect(PROGRESS_AFTER_MS).toBe(60_000);
    expect(HARD_TIMEOUT_MS).toBe(120_000);
  });
});
