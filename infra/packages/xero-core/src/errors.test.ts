import { describe, expect, it } from "vitest";
import { mapXeroHttpError } from "./errors";

describe("mapXeroHttpError", () => {
  it("maps 429 to rate limit response", () => {
    const err = mapXeroHttpError(429);
    expect(err.code).toBe("XERO_RATE_LIMITED");
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("maps 401 to auth expired", () => {
    expect(mapXeroHttpError(401).code).toBe("XERO_AUTH_EXPIRED");
  });
});
