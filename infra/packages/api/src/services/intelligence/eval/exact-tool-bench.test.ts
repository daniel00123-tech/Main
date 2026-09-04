import { describe, expect, it } from "vitest";
import { CURRENT_BUSINESS_DATA_PROTOCOL, describeToolCatalogue, formatToolForModel, INTELLIGENCE_TOOLS } from "../catalogue.js";
import { exactToolCases, scoreExactToolChoiceLocal, scoreExactToolRow } from "./exact-tool-bench.js";
import { EMAIL_FOLLOWUP_SEQUENCE, NO_TOOL_CONVERSATION, XERO_FOLLOWUP_SEQUENCE } from "./el-frozen-benchmark.js";
import { cloudflareToolDefs } from "../schema.js";

describe("exact-tool frozen bench and catalogue hardening", () => {
  it("has 50 frozen turns across the five families", () => {
    const cases = exactToolCases();
    expect(cases).toHaveLength(50);
    expect(cases.filter((row) => row.family === "outlook")).toHaveLength(10);
    expect(cases.filter((row) => row.family === "xero")).toHaveLength(10);
    expect(cases.filter((row) => row.family === "knowledge")).toHaveLength(10);
    expect(cases.filter((row) => row.family === "catalogue")).toHaveLength(10);
    expect(cases.filter((row) => row.family === "mixed")).toHaveLength(10);
  });

  it("scores only family and required/not-required, never customer phrases", () => {
    const catalogue = describeToolCatalogue();
    expect(catalogue).not.toMatch(/elvexpropertyservices|sharon|ella|william|caddington/i);
    expect(CURRENT_BUSINESS_DATA_PROTOCOL).toMatch(/CURRENT or private company data/i);
    expect(CURRENT_BUSINESS_DATA_PROTOCOL).toMatch(/outlook_list_messages = newest/i);
    const list = INTELLIGENCE_TOOLS.find((tool) => tool.name === "outlook_list_messages")!;
    const search = INTELLIGENCE_TOOLS.find((tool) => tool.name === "outlook_search_mailbox")!;
    expect(list.intentClass).toBe("mailbox_recency");
    expect(search.intentClass).toBe("mailbox_search");
    expect(formatToolForModel(list)).toMatch(/Live current data: yes/);
    expect(formatToolForModel(list)).toMatch(/no semantic filter|recency/i);
    expect(cloudflareToolDefs(["outlook_list_messages"])[0]?.description).toMatch(/info, finance, office/);
    const inboxMiss = scoreExactToolRow({
      testCase: exactToolCases().find((row) => row.id === "outlook_latest_inbox")!,
      tools: [],
    });
    expect(inboxMiss.inboxNoTool).toBe(true);
    expect(inboxMiss.familyOk).toBe(false);
    const xeroHit = scoreExactToolRow({
      testCase: exactToolCases().find((row) => row.id === "xero_sales_month")!,
      tools: ["xero_sales_summary"],
    });
    expect(xeroHit.familyOk).toBe(true);
    expect(xeroHit.xeroNoTool).toBe(false);
    const knowledgeWrong = scoreExactToolRow({
      testCase: exactToolCases().find((row) => row.id === "knowledge_po")!,
      tools: ["xero_sales_summary"],
    });
    expect(knowledgeWrong.knowledgeToXero).toBe(true);
    const emailWrong = scoreExactToolRow({
      testCase: exactToolCases().find((row) => row.id === "outlook_latest_inbox")!,
      tools: ["xero_sales_summary"],
    });
    expect(emailWrong.emailToXero).toBe(true);
  });

  it("keeps email 7 / xero 4 / no-tool conversation shapes", () => {
    expect(EMAIL_FOLLOWUP_SEQUENCE).toHaveLength(7);
    expect(XERO_FOLLOWUP_SEQUENCE).toHaveLength(4);
    expect(NO_TOOL_CONVERSATION.some((row) => /2\+2/.test(row.text))).toBe(true);
  });

  it("runs the local exact-tool mock without inventing credentials", async () => {
    const scored = await scoreExactToolChoiceLocal();
    expect(scored.source).toBe("MOCK");
    expect(scored.scorecard.cases).toBe(50);
    expect(scored.scorecard.inboxNoTool).toBe(0);
    expect(scored.scorecard.xeroNoTool).toBe(0);
    expect(scored.scorecard.knowledgeToXero).toBe(0);
    expect(scored.scorecard.emailToXero).toBe(0);
  });
});
