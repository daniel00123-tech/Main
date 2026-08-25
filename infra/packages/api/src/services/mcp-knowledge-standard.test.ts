import { describe, expect, it } from "vitest";
import {
  READ_ONLY_MCP_TOOLS,
  READ_ONLY_TOOL_ANNOTATIONS,
  STANDARD_FETCH_INPUT_SCHEMA,
  STANDARD_SEARCH_INPUT_SCHEMA,
  annotationsForTool,
  firstHttpUrl,
  resolveCompanyMcpToolName,
  sanitizeStandardFetchArguments,
  sanitizeStandardSearchArguments,
  toStandardFetchPayload,
  toStandardSearchPayload,
  withStandardKnowledgeTools,
  wrapStandardToolResult,
} from "./mcp-knowledge-standard";

const BOILER_BONUS_SEARCH = {
  tenant: "example-tenant",
  query: "boiler bonus policy",
  resultCount: 2,
  results: [
    {
      id: "doc_boiler_bonus_001",
      title: "Boiler Sales Bonus process.docx",
      excerpt:
        "The boiler sales bonus is paid monthly against completed installations that meet the quality checklist.",
      score: 0.91,
      source: "google_drive",
      sourceType: "google_drive",
      filename: "Boiler Sales Bonus process.docx",
      sourceUrl: "https://docs.example.test/boiler-sales-bonus",
    },
    {
      id: "doc_leave_policy_002",
      title: "Annual leave policy.pdf",
      excerpt: "Annual leave must be requested through the HR portal.",
      score: 0.41,
      source: "google_drive",
    },
  ],
};

const BOILER_BONUS_DOCUMENT = {
  id: "doc_boiler_bonus_001",
  title: "Boiler Sales Bonus process.docx",
  text: "Boiler sales bonus policy\n\nEligible engineers receive a monthly bonus for completed boiler installations that pass the quality checklist. Claims are submitted by the 5th working day.",
  source: "google_drive",
  filename: "Boiler Sales Bonus process.docx",
  sourceUrl: "https://docs.example.test/boiler-sales-bonus",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

describe("standard knowledge tool mapping", () => {
  it("maps search/fetch to the existing company knowledge tools", () => {
    expect(resolveCompanyMcpToolName("search")).toBe("search_company_knowledge");
    expect(resolveCompanyMcpToolName("fetch")).toBe("get_knowledge_document");
    expect(resolveCompanyMcpToolName("search_company_knowledge")).toBe(
      "search_company_knowledge",
    );
    expect(resolveCompanyMcpToolName("system_health")).toBe("system_health");
  });

  it("exposes ChatGPT Company Knowledge input signatures", () => {
    expect(STANDARD_SEARCH_INPUT_SCHEMA.required).toEqual(["query"]);
    expect(STANDARD_SEARCH_INPUT_SCHEMA.properties.query.type).toBe("string");
    expect(STANDARD_SEARCH_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(STANDARD_FETCH_INPUT_SCHEMA.required).toEqual(["id"]);
    expect(STANDARD_FETCH_INPUT_SCHEMA.properties.id.type).toBe("string");
    expect(STANDARD_FETCH_INPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it("marks the six retrieval tools read-only and non-destructive", () => {
    expect([...READ_ONLY_MCP_TOOLS].sort()).toEqual([
      "database_summary",
      "fetch",
      "get_knowledge_document",
      "search",
      "search_company_knowledge",
      "system_health",
    ]);
    for (const name of READ_ONLY_MCP_TOOLS) {
      expect(annotationsForTool(name)).toMatchObject(READ_ONLY_TOOL_ANNOTATIONS);
    }
    expect(annotationsForTool("query_business_data")).toBeUndefined();
  });
});

describe("standard search/fetch argument guards", () => {
  it("accepts a natural-language search query only", () => {
    expect(sanitizeStandardSearchArguments({ query: "boiler bonus policy" })).toEqual({
      query: "boiler bonus policy",
    });
    expect(sanitizeStandardSearchArguments({ query: "  " })).toEqual({
      error: "search requires a non-empty arguments.query string",
    });
  });

  it("accepts the stable document id for fetch", () => {
    expect(sanitizeStandardFetchArguments({ id: "doc_boiler_bonus_001" })).toEqual({
      id: "doc_boiler_bonus_001",
    });
    expect(sanitizeStandardFetchArguments({ documentId: "doc_x" })).toEqual({
      id: "doc_x",
    });
    expect(sanitizeStandardFetchArguments({})).toEqual({
      error: "fetch requires a non-empty arguments.id string",
    });
  });
});

describe("Company Knowledge response adaptors", () => {
  it("returns the boiler bonus policy for a boiler bonus query payload", () => {
    const payload = toStandardSearchPayload(BOILER_BONUS_SEARCH);
    const match = payload.results.find((item) =>
      item.title.toLowerCase().includes("boiler sales bonus"),
    );
    expect(match).toBeTruthy();
    expect(match?.id).toBe("doc_boiler_bonus_001");
    expect(match?.title).toBe("Boiler Sales Bonus process.docx");
    expect(match?.snippet?.toLowerCase()).toContain("boiler sales bonus");
    expect(match?.url).toBe("https://docs.example.test/boiler-sales-bonus");
    expect(match?.metadata?.source).toBe("google_drive");
  });

  it("fetch retrieves the document returned by search", () => {
    const search = toStandardSearchPayload(BOILER_BONUS_SEARCH);
    const hit = search.results[0]!;
    const fetched = toStandardFetchPayload(BOILER_BONUS_DOCUMENT, hit.id);
    expect(fetched.id).toBe(hit.id);
    expect(fetched.title).toBe(hit.title);
    expect(fetched.text).toContain("Eligible engineers receive a monthly bonus");
    expect(fetched.url).toBe(hit.url);
    expect(fetched.metadata?.filename).toBe("Boiler Sales Bonus process.docx");
  });

  it("does not invent citation URLs", () => {
    expect(firstHttpUrl("drive:file/abc", "not-a-url")).toBe("");
    const payload = toStandardSearchPayload({
      results: [
        {
          id: "doc_internal",
          title: "Internal note",
          excerpt: "No public link",
          sourceUrl: "google-drive://file/abc",
        },
      ],
    });
    expect(payload.results[0]?.url).toBe("");
  });

  it("unwraps MCP content wrappers from the company knowledge layer", () => {
    const wrapped = {
      content: [
        {
          type: "text",
          text: JSON.stringify(BOILER_BONUS_SEARCH),
        },
      ],
    };
    const payload = toStandardSearchPayload(wrapped);
    expect(payload.results[0]?.id).toBe("doc_boiler_bonus_001");
  });

  it("joins chunked document bodies for fetch", () => {
    const fetched = toStandardFetchPayload(
      {
        id: "doc_chunks",
        title: "Policy",
        chunks: [{ text: "Part one." }, { content: "Part two." }],
      },
      "doc_chunks",
    );
    expect(fetched.text).toBe("Part one.\n\nPart two.");
  });

  it("wraps standard results as a single MCP text content item plus structuredContent", () => {
    const payload = toStandardSearchPayload(BOILER_BONUS_SEARCH);
    const wrapped = wrapStandardToolResult(payload);
    expect(wrapped.content).toHaveLength(1);
    expect(wrapped.content[0]?.type).toBe("text");
    expect(JSON.parse(wrapped.content[0]!.text)).toEqual(payload);
    expect(wrapped.structuredContent).toEqual(payload);
  });
});

describe("standard tool injection", () => {
  it("injects search/fetch only when the underlying company tools are advertised", () => {
    const withKnowledge = withStandardKnowledgeTools([
      {
        name: "search_company_knowledge",
        description: "search",
        inputSchema: { type: "object" },
      },
      {
        name: "get_knowledge_document",
        description: "read",
        inputSchema: { type: "object" },
      },
      {
        name: "system_health",
        description: "health",
        inputSchema: { type: "object" },
      },
    ]);
    expect(withKnowledge.map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
      "search_company_knowledge",
      "get_knowledge_document",
      "system_health",
    ]);
    for (const name of READ_ONLY_MCP_TOOLS) {
      const tool = withKnowledge.find((item) => item.name === name);
      if (!tool) continue;
      expect(tool.annotations).toMatchObject(READ_ONLY_TOOL_ANNOTATIONS);
    }

    const healthOnly = withStandardKnowledgeTools([
      {
        name: "system_health",
        description: "health",
        inputSchema: { type: "object" },
      },
    ]);
    expect(healthOnly.map((tool) => tool.name)).toEqual(["system_health"]);
    expect(healthOnly[0]?.annotations?.readOnlyHint).toBe(true);
  });
});
