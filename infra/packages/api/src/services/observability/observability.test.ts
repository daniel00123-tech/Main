import { describe, expect, it } from "vitest";
import { redactInfraLogFields } from "./structured-log";
import { clearSafeReadCache, rememberSafeRead } from "./safe-cache";
import {
  shouldDeadLetterAfterRetries,
  shouldSkipCompanyAutomationTick,
} from "./runaway-limits";

describe("structured log redaction", () => {
  it("drops secrets and document bodies", () => {
    const redacted = redactInfraLogFields({
      companyId: "co_caddington",
      event: "ocr.completed",
      authorization: "Bearer secret",
      apiKey: "abc",
      password: "nope",
      text: "document body",
      durationMs: 12,
    });
    expect(redacted.companyId).toBe("co_caddington");
    expect(redacted.durationMs).toBe(12);
    expect(redacted.authorization).toBeUndefined();
    expect(redacted.apiKey).toBeUndefined();
    expect(redacted.password).toBeUndefined();
    expect(redacted.text).toBeUndefined();
  });
});

describe("safe read cache", () => {
  it("returns the cached value within TTL", async () => {
    clearSafeReadCache();
    let loads = 0;
    const first = await rememberSafeRead("platform_ops_health", "test", 5_000, async () => {
      loads += 1;
      return { ok: true };
    });
    const second = await rememberSafeRead("platform_ops_health", "test", 5_000, async () => {
      loads += 1;
      return { ok: false };
    });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(loads).toBe(1);
  });
});

describe("runaway limits", () => {
  it("caps automation claims per company per tick", () => {
    expect(shouldSkipCompanyAutomationTick(0)).toBe(false);
    expect(shouldSkipCompanyAutomationTick(2)).toBe(true);
  });

  it("dead-letters after the configured retry count", () => {
    expect(shouldDeadLetterAfterRetries(4)).toBe(false);
    expect(shouldDeadLetterAfterRetries(5)).toBe(true);
  });
});
