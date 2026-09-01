import { describe, expect, it } from "vitest";
import { redactInteractionPayload } from "./interaction-history";

describe("interaction redaction", () => {
  it("redacts secrets and auth headers from payloads", () => {
    const redacted = redactInteractionPayload({
      authorization: "Bearer secret-token",
      headers: {
        Authorization: "Bearer abc",
        "X-Api-Key": "key_live_123",
        Accept: "application/json",
      },
      token: "sk-live-example",
      query: "find invoices",
    }) as Record<string, unknown>;

    expect(redacted.authorization).toBe("[redacted]");
    expect((redacted.headers as Record<string, unknown>).Authorization).toBe("[redacted]");
    expect((redacted.headers as Record<string, unknown>)["X-Api-Key"]).toBe("[redacted]");
    expect((redacted.headers as Record<string, unknown>).Accept).toBe("application/json");
    expect(redacted.token).toBe("[redacted]");
    expect(redacted.query).toBe("find invoices");
  });
});
