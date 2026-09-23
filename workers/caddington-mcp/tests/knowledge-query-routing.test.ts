import { describe, expect, it } from "vitest";
import { routeSearchQuery } from "../src/knowledge-query-routing";
import { parseSearchQuery } from "../src/knowledge-query";

describe("query routing", () => {
  it("routes employment holiday questions toward HR topics", () => {
    const parsed = parseSearchQuery(
      "How many days holiday do I have in my employment contract?"
    );
    const routing = routeSearchQuery(parsed);
    expect(routing.topics).toContain("employment");
    expect(routing.intents).toContain("employment_contract");
    expect(routing.boostTerms).toContain("holiday");
  });

  it("routes boiler pricing questions toward pricing and heating", () => {
    const parsed = parseSearchQuery("How do I price a boiler installation?");
    const routing = routeSearchQuery(parsed);
    expect(routing.intents).toContain("pricing");
    expect(routing.topics).toContain("heating");
    expect(routing.boostTerms).toContain("boiler");
  });
});
