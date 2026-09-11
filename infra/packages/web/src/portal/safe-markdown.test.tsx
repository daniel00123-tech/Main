import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SafeMarkdown,
  activityStepForTool,
  extractEmailSummaryRows,
  finalActivitySteps,
  markdownToPlainText,
  mergeActivityStatus,
  parseMarkdownBlocks,
  parseMarkdownInline,
} from "./safe-markdown";

describe("safe portal chat markdown", () => {
  it("parses bold, italic, code, safe links, and lists without unsafe html", () => {
    const blocks = parseMarkdownBlocks(
      "Hello **bold** and *italic* with `code` and [docs](https://example.com).\n\n- **17:05** — *Re: Pest control* from ops@example.com\n- second item\n\n<script>alert(1)</script>",
    );
    expect(blocks.some((block) => block.type === "ul")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("strong");
    expect(JSON.stringify(blocks)).toContain("em");
    expect(JSON.stringify(blocks)).toContain("<script>alert(1)</script>");

    const unsafe = parseMarkdownInline("[bad](javascript:alert(1))");
    expect(unsafe.some((node) => node.type === "link")).toBe(false);
  });

  it("renders markdown syntax as safe React markup", () => {
    const html = renderToStaticMarkup(<SafeMarkdown text="Open **urgent** mail from *Ops* at https://example.com" />);
    expect(html).toContain("<strong>urgent</strong>");
    expect(html).toContain("<em>Ops</em>");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("**urgent**");
  });

  it("normalizes markdown for compact history previews", () => {
    expect(markdownToPlainText("I found **3 emails**:\n- *Re: works* from ops@example.com")).toBe(
      "I found 3 emails: Re: works from ops@example.com",
    );
  });

  it("parses markdown tables into table blocks", () => {
    const [table] = parseMarkdownBlocks("| Time | Subject |\n| --- | --- |\n| **17:05** | *Re: urgent* |");
    expect(table?.type).toBe("table");
    expect(JSON.stringify(table)).toContain("17:05");
  });

  it("extracts email-like rows for scannable cards", () => {
    expect(
      extractEmailSummaryRows("- **17:05** — *Re: URGENT CALL OUT* from ny@example.com\n- **16:30** — *Invoice* from accounts@example.com"),
    ).toEqual([
      { time: "17:05", subject: "Re: URGENT CALL OUT", from: "ny@example.com" },
      { time: "16:30", subject: "Invoice", from: "accounts@example.com" },
    ]);
    expect(
      extractEmailSummaryRows("The newest email is:\n\n- **Subject:** Invoice for Hastings\n- **From:** lj@example.com\n- **Received:** 11 September 2026 at 16:30")[0],
    ).toMatchObject({ subject: "Invoice for Hastings", from: "lj@example.com" });
  });
});

describe("portal chat activity steps", () => {
  it("turns thin SSE status payloads into explanatory steps", () => {
    expect(activityStepForTool("outlook_list_messages", "running")).toMatchObject({
      label: "Searching mailbox",
      status: "running",
    });
    const steps = mergeActivityStatus([], { label: "Checking email…", tool: "outlook_list_messages" });
    expect(steps[0]).toMatchObject({ label: "Searching mailbox", detail: expect.stringContaining("Outlook") });
    expect(finalActivitySteps(steps, ["outlook_list_messages"], "success").at(-1)).toMatchObject({ label: "Done" });
  });
});
