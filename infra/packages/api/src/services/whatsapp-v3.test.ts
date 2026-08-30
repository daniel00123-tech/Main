import { describe, expect, it } from "vitest";
import { firstHttpUrl, toStandardSearchPayload } from "./mcp-knowledge-standard";
import { permissionBlockedWhatsAppMessage } from "./whatsapp-format";
import { inferEntitiesFromTurns } from "./whatsapp-entities";
import { ACK_DECISION_MS, ACK_HARD_WARNING_MS } from "./whatsapp-latency";
import { looksLikeSourceLinkAsk, planWhatsAppTurn } from "./whatsapp-plan";
import { titlesLikelyMatch } from "./whatsapp-source-urls";
import { raceWithWhatsAppWatchdog } from "./whatsapp-watchdog";
import { emptyEntityMemory } from "./whatsapp-entities";

const coal = {
  lastDocument: {
    id: "doc_coal",
    title: "Coal Search.pdf",
    url: "https://contoso.sharepoint.com/CoalSearch.pdf",
    excerpt: "£49.92",
    amount: "£49.92",
    reference: "CAD021/01",
    sourceLabel: "Coal Search.pdf",
  },
};

describe("WhatsApp V3 source-link language", () => {
  const live = "what is the url where i can download it from as i need a copy of it?";

  it("treats the live incident phrase as a source-link ask", () => {
    expect(looksLikeSourceLinkAsk(live)).toBe(true);
    const withMemory = planWhatsAppTurn({ text: live, memory: coal, connectors: ["conn_microsoft_365"] });
    expect(withMemory.action).toBe("memory_link");
    expect(withMemory.skipTools).toBe(true);
    const without = planWhatsAppTurn({ text: live, memory: emptyEntityMemory(), connectors: ["conn_microsoft_365"] });
    expect(without.action).toBe("clarify");
    expect(without.skipTools).toBe(true);
  });

  it("recovers Coal Search from prior turns when entity memory is empty", () => {
    const inferred = inferEntitiesFromTurns(
      [
        { role: "user", text: "Find Coal Search" },
        { role: "assistant", text: "Coal Search.pdf is a payment confirmation." },
      ],
      emptyEntityMemory(),
    );
    expect(inferred.lastDocument?.title).toMatch(/coal search/i);
    const plan = planWhatsAppTurn({ text: live, memory: inferred, connectors: [] });
    expect(plan.action).toBe("memory_link");
  });
});

describe("WhatsApp V3 source URL extraction", () => {
  it("keeps SharePoint webUrl from search hits", () => {
    expect(firstHttpUrl("drive:file/abc", "https://contoso.sharepoint.com/CoalSearch.pdf")).toBe(
      "https://contoso.sharepoint.com/CoalSearch.pdf",
    );
    const payload = toStandardSearchPayload({
      results: [
        {
          id: "doc_coal",
          title: "Coal Search.pdf",
          webUrl: "https://contoso.sharepoint.com/sites/docs/CoalSearch.pdf",
        },
      ],
    });
    expect(payload.results[0]?.url).toContain("sharepoint.com");
  });

  it("matches Caddington titles without inventing URLs", () => {
    expect(titlesLikelyMatch("Coal Search.pdf", "Coal Search")).toBe(true);
    expect(titlesLikelyMatch("Arnold Crescent", "Arnold Crescent rental")).toBe(true);
    expect(firstHttpUrl("not-a-url")).toBe("");
  });
});

describe("WhatsApp V3 watchdog", () => {
  it("skips acknowledgement when work finishes immediately", async () => {
    const sent: string[] = [];
    const result = await raceWithWhatsAppWatchdog(
      Promise.resolve("final"),
      async (kind, body) => {
        sent.push(`${kind}:${body}`);
        return true;
      },
    );
    expect(result.result).toBe("final");
    expect(result.acknowledgementSent).toBe(false);
    expect(sent).toEqual([]);
    expect(ACK_DECISION_MS).toBeLessThan(ACK_HARD_WARNING_MS);
    expect(ACK_DECISION_MS).toBeLessThanOrEqual(1500);
  });

  it("sends one acknowledgement when work is slower than the decision window", async () => {
    const sent: string[] = [];
    const result = await raceWithWhatsAppWatchdog(
      new Promise((resolve) => {
        setTimeout(() => resolve("final"), 950);
      }),
      async (kind, body) => {
        sent.push(kind);
        expect(body.length).toBeGreaterThan(8);
        return true;
      },
    );
    expect(result.result).toBe("final");
    expect(sent.filter((kind) => kind === "ack").length).toBeLessThanOrEqual(1);
  });
});

describe("WhatsApp V3 permission copy", () => {
  it("names Xero without leaking unauthorised data", () => {
    expect(permissionBlockedWhatsAppMessage("xero")).toMatch(/Xero financial information/i);
    expect(permissionBlockedWhatsAppMessage("xero")).toMatch(/company administrator/i);
    expect(permissionBlockedWhatsAppMessage("xero")).not.toMatch(/INV-|£|token/i);
  });
});
