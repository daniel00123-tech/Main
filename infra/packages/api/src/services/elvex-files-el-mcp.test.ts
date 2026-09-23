import { describe, expect, it } from "vitest";
import {
  catalogueFilesFromSearchPayload,
  fetchLooksEmpty,
  mapArgumentsForElFileTool,
  resolveElMcpKnowledgeToolName,
  searchLooksEmpty,
  shouldExecuteElvexKnowledgeViaElFiles,
} from "./elvex-files-el-mcp";
import { toStandardFetchPayload, toStandardSearchPayload } from "./mcp-knowledge-standard";

describe("Elvex knowledge via EL file tools", () => {
  it("routes only Elvex knowledge tools through EL file tools", () => {
    expect(shouldExecuteElvexKnowledgeViaElFiles("co_el", "search")).toBe(true);
    expect(shouldExecuteElvexKnowledgeViaElFiles("co_el", "fetch")).toBe(true);
    expect(shouldExecuteElvexKnowledgeViaElFiles("co_el", "search_elvex_files")).toBe(true);
    expect(shouldExecuteElvexKnowledgeViaElFiles("co_el", "xero_sales_summary")).toBe(false);
    expect(shouldExecuteElvexKnowledgeViaElFiles("co_caddington", "search")).toBe(false);
  });

  it("prefers search_elvex_files / get_elvex_file when EL MCP advertises them", () => {
    expect(
      resolveElMcpKnowledgeToolName("search", ["search_elvex_files", "search_company_knowledge"]),
    ).toBe("search_elvex_files");
    expect(
      resolveElMcpKnowledgeToolName("get_knowledge_document", ["get_elvex_file", "get_knowledge_document"]),
    ).toBe("get_elvex_file");
    expect(resolveElMcpKnowledgeToolName("search", ["search_company_knowledge"])).toBe(
      "search_company_knowledge",
    );
  });

  it("forwards id as documentRef and fileId on get", () => {
    const args = mapArgumentsForElFileTool("get_elvex_file", {
      id: "gdrive-staff-handbook",
      title: "Staff Handbook.pdf",
    });
    expect(args.documentRef).toBe("gdrive-staff-handbook");
    expect(args.id).toBe("gdrive-staff-handbook");
    expect(args.fileId).toBe("gdrive-staff-handbook");
    expect(args.title).toBe("Staff Handbook.pdf");
  });

  it("standardises EL file search hits and skips empty Untitled chunks", () => {
    const payload = toStandardSearchPayload({
      files: [
        { id: "empty", title: "Untitled document", chunks: [] },
        {
          fileId: "gdrive-staff-handbook",
          file: { name: "Staff Handbook.pdf" },
          snippet: "Annual leave is 28 days.",
          modified_at: "2026-08-20T10:00:00Z",
          source: "google_drive",
        },
      ],
    });
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.id).toBe("gdrive-staff-handbook");
    expect(payload.results[0]?.title).toBe("Staff Handbook.pdf");
    expect(searchLooksEmpty(payload)).toBe(false);
    const catalogue = catalogueFilesFromSearchPayload(payload);
    expect(catalogue[0]?.modified_at).toBe("2026-08-20T10:00:00Z");
  });

  it("standardises EL file fetch into id/title/text/chunks", () => {
    const fetched = toStandardFetchPayload(
      {
        file: { id: "gdrive-staff-handbook", name: "Staff Handbook.pdf" },
        chunks: [{ page_content: "Employees receive 28 days of annual leave." }],
      },
      "gdrive-staff-handbook",
    );
    expect(fetched.title).toBe("Staff Handbook.pdf");
    expect(fetched.text).toContain("28 days");
    expect(fetchLooksEmpty(fetched)).toBe(false);
  });
});
