import { describe, expect, it } from "vitest";
import {
  decomposeEvidenceNeeds,
  isExclusiveCapabilitySwitch,
  isExplicitCatalogueAsk,
  isPeriodCorrection,
  isSemanticKnowledgeAsk,
  knowledgeQueryFromText,
  minimumToolsForText,
} from "./evidence-plan.js";
import { detectRequestedCapabilities, wantsMultiCapabilityRead } from "./company-tool-registry.js";
import { isCatalogueListingAsk } from "../document-catalogue.js";

describe("evidence plan", () => {
  it("keeps semantic knowledge off the catalogue tool", () => {
    const text = "What does the health and safety policy say, and what is the latest info email?";
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
    expect(isCatalogueListingAsk(text)).toBe(false);
    expect(detectRequestedCapabilities(text)).toEqual(expect.arrayContaining(["KNOWLEDGE_SEARCH", "EMAIL_LIST"]));
    expect(detectRequestedCapabilities(text)).not.toContain("CATALOGUE_LIST");
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["search_company_knowledge", "outlook_list_messages"]));
    expect(minimumToolsForText(text)).not.toContain("list_documents");
  });

  it("plans warehouse plus knowledge for March sales and payment process", () => {
    const text = "What were March sales and what does our payment process say?";
    expect(wantsMultiCapabilityRead(text)).toBe(true);
    expect(decomposeEvidenceNeeds(text)).toEqual(expect.arrayContaining(["finance.metric", "knowledge.semantic"]));
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["warehouse_sales_analysis", "search_company_knowledge"]));
    expect(minimumToolsForText(text)).not.toContain("list_documents");
  });

  it("allows catalogue plus warehouse when a filename list is actually asked", () => {
    const text = "What is the newest document filename, and what were March sales?";
    expect(isExplicitCatalogueAsk(text)).toBe(true);
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["list_documents", "warehouse_sales_analysis"]));
  });

  it("keeps both knowledge search and catalogue when both are required", () => {
    const text = "Search company knowledge for asbestos and list the newest files.";
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
    expect(isExplicitCatalogueAsk(text)).toBe(true);
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["search_company_knowledge", "list_documents"]));
  });

  it("treats a named document mention as knowledge, not catalogue", () => {
    const text = "April warehouse sales together with the admin structure document.";
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
    expect(isExplicitCatalogueAsk(text)).toBe(false);
    expect(decomposeEvidenceNeeds(text)).toEqual(expect.arrayContaining(["finance.metric", "knowledge.semantic"]));
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["warehouse_sales_analysis", "search_company_knowledge"]));
    expect(minimumToolsForText(text)).not.toContain("list_documents");
    expect(knowledgeQueryFromText(text)).toMatch(/admin structure/i);
  });

  it("does not add finance tools when the user rejects Xero for email", () => {
    const text = "Not Xero, the message.";
    expect(isExclusiveCapabilitySwitch(text)).toBe(true);
    expect(wantsMultiCapabilityRead(text)).toBe(false);
    expect(minimumToolsForText(text)).toEqual(["outlook_list_messages"]);
    expect(minimumToolsForText(text)).not.toContain("warehouse_sales_analysis");
    expect(minimumToolsForText(text)).not.toContain("xero_sales_summary");
  });

  it("keeps a month correction on finance, not knowledge", () => {
    expect(isPeriodCorrection("I meant August, not September.")).toBe(true);
    expect(isExclusiveCapabilitySwitch("I meant August, not September.")).toBe(true);
    expect(minimumToolsForText("I meant August, not September.")).toEqual(["warehouse_sales_analysis"]);
  });

  it("plans knowledge plus email for Health & Safety and last sender", () => {
    const text = "What does Health & Safety say about gas, and who emailed info last?";
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["search_company_knowledge", "outlook_list_messages"]));
  });

  it("plans knowledge plus overdue for SRFM form coverage", () => {
    const text = "SRFM subcontractor form coverage plus live overdue invoices.";
    expect(isSemanticKnowledgeAsk(text)).toBe(true);
    expect(minimumToolsForText(text)).toEqual(expect.arrayContaining(["search_company_knowledge", "xero_list_overdue_invoices"]));
  });
});
