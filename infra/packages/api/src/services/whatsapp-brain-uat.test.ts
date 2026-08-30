import { describe, expect, it } from "vitest";
import { evaluateWhatsAppUatSuite } from "./whatsapp-brain-uat";
import { sourceLinkReply, memoryFactReply } from "./whatsapp-synthesize";
import { planWhatsAppTurn } from "./whatsapp-plan";
import { emptyEntityMemory } from "./whatsapp-entities";

describe("WhatsApp conversational brain UAT suite", () => {
  it("covers 75+ prompts and evaluates the planner", () => {
    const report = evaluateWhatsAppUatSuite();
    expect(report.total).toBeGreaterThanOrEqual(75);
    expect(report.failed, JSON.stringify(report.failed, null, 2)).toEqual([]);
    expect(report.passed).toBe(report.total);
  });

  it("returns a real source URL from memory and never invents one", () => {
    const withUrl = sourceLinkReply({
      id: "doc_coal",
      title: "Coal Search.pdf",
      url: "https://contoso.sharepoint.com/CoalSearch.pdf",
      excerpt: "",
      amount: "£49.92",
      reference: "CAD021/01",
      sourceLabel: "Coal Search.pdf",
    });
    expect(withUrl).toContain("https://contoso.sharepoint.com/CoalSearch.pdf");
    expect(withUrl).toMatch(/source link/i);
    const without = sourceLinkReply({
      id: "doc_coal",
      title: "Coal Search.pdf",
      url: null,
      excerpt: "",
      amount: null,
      reference: null,
      sourceLabel: "Coal Search.pdf",
    });
    expect(without).toMatch(/don’t currently have a direct source link/i);
    expect(without).not.toMatch(/https?:\/\//);
  });

  it("answers amount follow-ups from entity memory without a tool", () => {
    const plan = planWhatsAppTurn({
      text: "What was the amount?",
      memory: {
        lastDocument: {
          id: "doc_coal",
          title: "Coal Search.pdf",
          url: "https://example.test/coal",
          excerpt: "£49.92",
          amount: "£49.92",
          reference: "CAD021/01",
          sourceLabel: "Coal Search.pdf",
        },
      },
      connectors: ["conn_microsoft_365"],
    });
    expect(plan.skipTools).toBe(true);
    expect(memoryFactReply(plan, plan && { lastDocument: {
      id: "doc_coal",
      title: "Coal Search.pdf",
      url: "https://example.test/coal",
      excerpt: "£49.92",
      amount: "£49.92",
      reference: "CAD021/01",
      sourceLabel: "Coal Search.pdf",
    } })).toMatch(/£49.92/);
  });

  it("does not mention disconnected operational systems in the plan", () => {
    const plan = planWhatsAppTurn({
      text: "What can you do?",
      memory: emptyEntityMemory(),
      connectors: ["conn_microsoft_365", "conn_xero"],
    });
    expect(plan.action).toBe("capabilities");
    expect(plan.skipTools).toBe(true);
  });
});
