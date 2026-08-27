import { describe, expect, it } from "vitest";

describe("gateway execute error payload shape", () => {
  it("preserves machine-readable code for ACTION_ENGINE_REQUIRED responses", () => {
    const gatewayResult = {
      status: 403 as const,
      error: "Financial writes must use the INFRA Action Engine (plan → confirm → execute).",
      correlationId: "corr_test",
      requestId: "req_test",
      code: "ACTION_ENGINE_REQUIRED",
    };

    const payload = {
      error: gatewayResult.error,
      code: "code" in gatewayResult ? gatewayResult.code : undefined,
      correlationId: gatewayResult.correlationId,
    };

    expect(payload.code).toBe("ACTION_ENGINE_REQUIRED");
    expect(payload.error).toContain("Action Engine");
  });
});
