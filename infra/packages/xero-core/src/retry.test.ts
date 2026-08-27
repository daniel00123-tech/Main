import { describe, expect, it } from "vitest";
import { withXeroRetry, isRetryableStatus } from "./retry";
import { XeroApiError } from "./client";

describe("withXeroRetry", () => {
  it("retries on 429 then succeeds", async () => {
    let attempts = 0;
    const result = await withXeroRetry(async () => {
      attempts++;
      if (attempts < 2) {
        throw new XeroApiError({
          status: 429,
          code: "XERO_RATE_LIMITED",
          message: "rate limited",
          retryAfterSeconds: 0,
        });
      }
      return "ok";
    }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry on 400", async () => {
    await expect(
      withXeroRetry(async () => {
        throw new XeroApiError({ status: 400, code: "BAD", message: "bad request" });
      }, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("bad request");
  });

  it("identifies retryable statuses", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});
