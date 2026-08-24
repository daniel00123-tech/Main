import { describe, expect, it } from "vitest";
import { checkMcpHealth } from "../services/control-plane";

describe("checkMcpHealth", () => {
  it("reports unhealthy when endpoint is unreachable", async () => {
    const result = await checkMcpHealth("https://invalid.invalid.example/mcp");
    expect(result.status).toBe("unhealthy");
    expect(result.message).toBeTruthy();
  });
});
