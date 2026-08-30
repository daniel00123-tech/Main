import { describe, expect, it } from "vitest";
import { routeSearchQuery, type IntentPattern } from "../src/retrieval/routing";
import { parseSearchQuery } from "../src/retrieval/query-parse";

describe("config-driven query routing", () => {
  it("returns empty routing when no company patterns configured", () => {
    const parsed = parseSearchQuery("What is the boiler installation procedure?");
    const routing = routeSearchQuery(parsed);
    expect(routing.intents).toEqual([]);
    expect(routing.topics).toEqual([]);
  });

  it("applies company-specific intent patterns", () => {
    const patterns: IntentPattern[] = [
      {
        pattern: /\bboiler\b/i,
        intent: "installation_procedure",
        topics: ["heating", "boiler"],
        boost: ["boiler", "installation"],
        categories: ["technical"],
      },
    ];
    const parsed = parseSearchQuery("boiler installation quote");
    const routing = routeSearchQuery(parsed, patterns);
    expect(routing.intents).toContain("installation_procedure");
    expect(routing.topics).toContain("boiler");
  });
});
