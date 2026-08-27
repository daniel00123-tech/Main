import { describe, expect, it } from "vitest";
import {
  findOutlookSearchHit,
  knowledgeSearchHitsFromPayload,
  summarizeKnowledgeSearchHits,
} from "./microsoft-acceptance-knowledge-search";

describe("CMD16C knowledge search parsing", () => {
  it("extracts hits from production MCP search payload", () => {
    const payload = {
      query: "67567",
      resultCount: 1,
      results: [
        {
          documentId: 68,
          title: "67567",
          category: "outlook_shared",
          source: "microsoft_365",
          snippet: "Subject: 67567",
          topic: "Microsoft 365 → Outlook → admin@CaddingtonHoldings.co.uk → Inbox → 67567",
        },
      ],
    };
    const hits = knowledgeSearchHitsFromPayload(payload);
    expect(hits).toHaveLength(1);
    const summary = summarizeKnowledgeSearchHits(hits)[0];
    expect(summary.documentId).toBe(68);
    expect(summary.category).toBe("outlook_shared");
    expect(findOutlookSearchHit([summary], { title: "67567", documentId: 68 })).not.toBeNull();
  });

  it("unwraps gateway text content payloads", () => {
    const payload = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [{ documentId: 67, title: "889", category: "outlook_shared", source: "microsoft_365" }],
          }),
        },
      ],
    };
    const hits = knowledgeSearchHitsFromPayload(payload);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("889");
  });

  it("does not treat legacy mailbox query as subject match", () => {
    const hits = summarizeKnowledgeSearchHits([
      { title: "889", documentId: 67, category: "outlook_shared", source: "microsoft_365" },
    ]);
    expect(findOutlookSearchHit(hits, { title: "67567", documentId: 68 })).toBeNull();
    expect(findOutlookSearchHit(hits, { title: "889", documentId: 67 })).not.toBeNull();
  });
});
