import { describe, expect, it } from "vitest";
import { BILLABLE_EVENT_MATRIX } from "./billable-events";

describe("INFRA billable event matrix", () => {
  it("does not invent a new wallet policy for discovery or denials", () => {
    const byEvent = Object.fromEntries(BILLABLE_EVENT_MATRIX.map((row) => [row.event, row]));
    expect(byEvent["mcp.initialize"]?.walletDebit).toBe(false);
    expect(byEvent["mcp.tools/list"]?.walletDebit).toBe(false);
    expect(byEvent["permission-denied request"]?.recordsUsage).toBe(true);
    expect(byEvent["permission-denied request"]?.walletDebit).toBe(false);
    expect(byEvent["direct company MCP (bypassing INFRA gateway)"]?.recordsUsage).toBe(false);
    expect(byEvent["knowledge.search / knowledge.read success"]?.walletDebit).toBe(true);
  });
});
