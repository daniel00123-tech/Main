import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/version";

describe("Business MCP Core version", () => {
  it("exports CORE_VERSION 1.0.0", () => {
    expect(CORE_VERSION).toBe("1.0.0");
  });
});
