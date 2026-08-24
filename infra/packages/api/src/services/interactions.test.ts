import { describe, expect, it } from "vitest";
import { resolveInteractionIds } from "./interactions";

describe("resolveInteractionIds", () => {
  it("prefers the client header over generated ids", () => {
    const resolved = resolveInteractionIds({
      headerInteractionId: "int_client_turn",
      bodyInteractionId: "int_other",
    });
    expect(resolved.interactionId).toBe("int_client_turn");
    expect(resolved.sourcedFrom).toBe("client");
  });

  it("never treats JSON-RPC id 0 as an interaction", () => {
    const resolved = resolveInteractionIds({
      bodyInteractionId: "0",
      metaInteractionId: "0",
    });
    expect(resolved.interactionId).not.toBe("0");
    expect(resolved.sourcedFrom).toBe("generated");
    expect(resolved.interactionId.startsWith("int_")).toBe(true);
  });

  it("does not infer a group from missing client ids", () => {
    const a = resolveInteractionIds({});
    const b = resolveInteractionIds({});
    expect(a.interactionId).not.toBe(b.interactionId);
    expect(a.sourcedFrom).toBe("generated");
  });

  it("rejects empty and oversized client ids", () => {
    const empty = resolveInteractionIds({ headerInteractionId: "   " });
    expect(empty.sourcedFrom).toBe("generated");
    const huge = resolveInteractionIds({ headerInteractionId: "x".repeat(200) });
    expect(huge.sourcedFrom).toBe("generated");
  });

  it("records MCP session separately from interaction grouping", () => {
    const resolved = resolveInteractionIds({
      mcpSessionId: "mcpsess_abc",
    });
    expect(resolved.mcpSessionId).toBe("mcpsess_abc");
    expect(resolved.sourcedFrom).toBe("generated");
  });
});
