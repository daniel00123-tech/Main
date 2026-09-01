import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRegisteredMcpTool = vi.fn();
const listMcpEnvironments = vi.fn();

vi.mock("./control-plane", () => ({
  executeRegisteredMcpTool: (...args: unknown[]) => executeRegisteredMcpTool(...args),
  listMcpEnvironments: (...args: unknown[]) => listMcpEnvironments(...args),
}));

vi.mock("./document-text-extract", async () => {
  const actual = await vi.importActual<typeof import("./document-text-extract")>("./document-text-extract");
  return {
    ...actual,
    extractDocumentBytes: vi.fn(async () => ({
      text: "Employees must report incidents within 24 hours. The policy owner is the operations manager.",
      method: "docx" as const,
    })),
  };
});

import {
  DOCUMENT_FETCH_AMBIGUOUS,
  fetchCompanyKnowledgeDocument,
  isEmptyKnowledgeFetch,
  titlesAreNearExact,
  usableDocumentTitle,
} from "./document-fetch";
import { toStandardFetchPayload, toStandardSearchPayload } from "./mcp-knowledge-standard";
import type { Env } from "../env";

const env = {
  DB: {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
      }),
    }),
  },
} as unknown as Env;

function mcpOk(result: unknown) {
  return { status: 200 as const, data: { result } };
}

describe("Elvex document identity contract", () => {
  beforeEach(() => {
    executeRegisteredMcpTool.mockReset();
    listMcpEnvironments.mockReset();
    listMcpEnvironments.mockResolvedValue([{ id: "mcp_el_primary", enabled: true }]);
  });

  it("treats EL not_configured stubs as empty fetches", () => {
    const payload = toStandardFetchPayload({ status: "not_configured" }, "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7");
    expect(payload.title).toBe("Untitled document");
    expect(payload.chunks ?? []).toHaveLength(0);
    expect(isEmptyKnowledgeFetch(payload, { status: "not_configured" })).toBe(true);
  });

  it("keeps SharePoint drive/item ids on search metadata", () => {
    const search = toStandardSearchPayload({
      results: [
        {
          id: "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7",
          name: "Health and Safety Policy (2).docx",
          webUrl: "https://elvexpropertyservicesltd.sharepoint.com/sites/docs/HSP.docx",
          sourceType: "sharepoint",
          driveId: "b!driveSharePoint",
          path: "/Documents",
        },
      ],
    });
    expect(search.results[0]?.id).toBe("01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7");
    expect(search.results[0]?.title).toBe("Health and Safety Policy (2).docx");
    expect(search.results[0]?.url).toBe(
      "https://elvexpropertyservicesltd.sharepoint.com/sites/docs/HSP.docx",
    );
    expect(search.results[0]?.metadata?.driveId).toBe("b!driveSharePoint");
  });

  it("fetches Elvex SharePoint content via catalogue identity + get_elvex_file", async () => {
    executeRegisteredMcpTool.mockImplementation(async (_env: Env, input: { toolName: string }) => {
      if (input.toolName === "get_knowledge_document") {
        return mcpOk({ status: "not_configured" });
      }
      if (input.toolName === "query_business_data") {
        return mcpOk({
          rows: [
            {
              item_id: "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7",
              drive_id: "b!driveSharePoint",
              filename: "Health and Safety Policy (2).docx",
              web_url: "https://elvexpropertyservicesltd.sharepoint.com/sites/docs/HSP.docx",
              source_type: "sharepoint",
              status: "catalogue",
            },
          ],
        });
      }
      if (input.toolName === "get_elvex_file") {
        return mcpOk({
          id: "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7",
          name: "Health and Safety Policy (2).docx",
          webUrl: "https://elvexpropertyservicesltd.sharepoint.com/sites/docs/HSP.docx",
          contentBase64: btoa("PK fake"),
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      }
      throw new Error(input.toolName);
    });

    const fetched = await fetchCompanyKnowledgeDocument(env, {
      companyId: "co_el",
      documentId: "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7",
      title: "Health and Safety Policy (2).docx",
      actor: "test",
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.payload.title).toBe("Health and Safety Policy (2).docx");
    expect(fetched.payload.title).not.toBe("Untitled document");
    expect(fetched.payload.url).toMatch(/^https:\/\/elvexpropertyservicesltd\.sharepoint\.com/);
    expect(fetched.payload.text).toMatch(/report incidents/i);
    expect(fetched.payload.chunks?.length).toBeGreaterThan(0);
    expect(fetched.diagnostics.backend).toBe("elvex_file_catalogue");
    expect(executeRegisteredMcpTool.mock.calls.some((call) => call[1].toolName === "get_elvex_file")).toBe(true);
    expect(executeRegisteredMcpTool.mock.calls.find((call) => call[1].toolName === "get_elvex_file")?.[1].arguments).toMatchObject({
      drive_id: "b!driveSharePoint",
      item_id: "01MOJNBGIXVDOG443GZZB35AHVEUN5DCY7",
      include_content: true,
    });
  });

  it("does not silently bind a title that matches multiple docs", async () => {
    executeRegisteredMcpTool.mockImplementation(async (_env: Env, input: { toolName: string }) => {
      if (input.toolName === "get_knowledge_document") return mcpOk({ status: "not_configured" });
      if (input.toolName === "query_business_data") {
        return mcpOk({
          rows: [
            {
              item_id: "item-a",
              drive_id: "drive-1",
              filename: "Rates card 2026 2.pdf",
              web_url: "https://elvexpropertyservicesltd.sharepoint.com/a.pdf",
              source_type: "sharepoint",
            },
            {
              item_id: "item-b",
              drive_id: "drive-2",
              filename: "Rates card 2026 2.pdf",
              web_url: "https://elvexpropertyservicesltd.sharepoint.com/b.pdf",
              source_type: "sharepoint",
            },
          ],
        });
      }
      throw new Error(input.toolName);
    });
    const fetched = await fetchCompanyKnowledgeDocument(env, {
      companyId: "co_el",
      documentId: "unknown-id",
      title: "Rates card 2026 2.pdf",
      actor: "test",
    });
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.code).toBe(DOCUMENT_FETCH_AMBIGUOUS);
    expect(fetched.candidates).toHaveLength(2);
  });

  it("leaves Caddington indexed fetches on get_knowledge_document", async () => {
    executeRegisteredMcpTool.mockImplementation(async (_env: Env, input: { toolName: string }) => {
      if (input.toolName === "get_knowledge_document") {
        return mcpOk({
          document: { id: 58, title: "Letter to Daniel Dwyer.pdf" },
          chunks: [{ text: "This letter confirms the Caddington instruction dated 10 July 2026." }],
          url: "https://caddington.sharepoint.com/letter.pdf",
        });
      }
      throw new Error(`Caddington should not call ${input.toolName}`);
    });
    const fetched = await fetchCompanyKnowledgeDocument(env, {
      companyId: "co_caddington",
      documentId: "58",
      title: "Letter to Daniel Dwyer.pdf",
      actor: "test",
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.diagnostics.backend).toBe("company_knowledge");
    expect(fetched.payload.title).toBe("Letter to Daniel Dwyer.pdf");
    expect(fetched.payload.chunks?.length).toBeGreaterThan(0);
    expect(executeRegisteredMcpTool.mock.calls.map((call) => call[1].toolName)).toEqual([
      "get_knowledge_document",
    ]);
  });
});

describe("title fallback safety", () => {
  it("keeps real titles over Untitled document", () => {
    expect(usableDocumentTitle("Untitled document", "Elvex Jobs.xlsx")).toBe("Elvex Jobs.xlsx");
    expect(titlesAreNearExact("Health and Safety Policy (2).docx", "Health and Safety Policy (2)")).toBe(true);
    expect(titlesAreNearExact("Policy A", "Policy B")).toBe(false);
  });
});
