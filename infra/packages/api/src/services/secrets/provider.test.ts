import { describe, expect, it } from "vitest";
import { MemorySecretProvider } from "./memory";
import { DisabledProductionSecretProvider } from "./disabled";
import {
  CredentialSubmissionDisabledError,
  SecretTenantMismatchError,
  redactSecretFields,
  sanitizeCustomerError,
  sanitizeForLog,
  stripSecretFields,
} from "./provider";
import type { Env } from "../../env";

describe("secret provider", () => {
  it("stores and resolves only for the owning company", async () => {
    const provider = new MemorySecretProvider();
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "super-secret",
    });
    expect(stored.reference).toMatch(/^sec_/);
    expect(await provider.resolve(stored.reference, {
      companyId: "co_a",
      actor: "test",
      reason: "mcp_resolve",
    })).toBe("super-secret");
    await expect(
      provider.resolve(stored.reference, {
        companyId: "co_b",
        actor: "attacker",
        reason: "mcp_resolve",
      }),
    ).rejects.toBeInstanceOf(SecretTenantMismatchError);
  });

  it("rotates without revealing the previous secret", async () => {
    const provider = new MemorySecretProvider();
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "api_key",
      value: "old-secret",
    });
    const rotated = await provider.rotate(stored.reference, "new-secret", {
      companyId: "co_a",
      actor: "admin",
      reason: "rotation",
    });
    expect(rotated.reference).toBe(stored.reference);
    expect(await provider.resolve(stored.reference, {
      companyId: "co_a",
      actor: "admin",
      reason: "rotation",
    })).toBe("new-secret");
    expect(JSON.stringify(rotated)).not.toContain("old-secret");
    expect(JSON.stringify(rotated)).not.toContain("new-secret");
  });

  it("revokes so later resolve returns null", async () => {
    const provider = new MemorySecretProvider();
    const stored = await provider.store({
      companyId: "co_a",
      purpose: "connector",
      value: "temp",
    });
    await provider.revoke(stored.reference, {
      companyId: "co_a",
      actor: "admin",
      reason: "revocation",
    });
    expect(
      await provider.resolve(stored.reference, {
        companyId: "co_a",
        actor: "admin",
        reason: "mcp_resolve",
      }),
    ).toBeNull();
  });

  it("production provider refuses store and rotate", async () => {
    const env = { ENVIRONMENT: "production" } as Env;
    const provider = new DisabledProductionSecretProvider(env);
    await expect(
      provider.store({ companyId: "co_a", purpose: "connector", value: "x" }),
    ).rejects.toBeInstanceOf(CredentialSubmissionDisabledError);
    await expect(
      provider.rotate("sec_1", "y", {
        companyId: "co_a",
        actor: "admin",
        reason: "rotation",
      }),
    ).rejects.toBeInstanceOf(CredentialSubmissionDisabledError);
  });

  it("redacts secret-shaped fields from logs", () => {
    const redacted = redactSecretFields({
      apiKey: "abc",
      folderIds: ["1"],
      nested: { clientSecret: "xyz", name: "ok" },
    });
    expect(redacted.apiKey).toBe("[redacted]");
    expect((redacted.nested as { clientSecret: string }).clientSecret).toBe("[redacted]");
    expect((redacted.nested as { name: string }).name).toBe("ok");
    expect(stripSecretFields({ apiKey: "abc", folderIds: ["1"] })).toEqual({
      folderIds: ["1"],
    });
  });

  it("redacts JWT-shaped values even when the key name is generic", () => {
    const redacted = redactSecretFields({
      note: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa",
    });
    expect(redacted.note).toBe("[redacted]");
    expect(sanitizeForLog("sk-live-example")).toBe("[redacted]");
    expect(sanitizeCustomerError("password = hunter2 leftover")).toMatch(/password=\[redacted\]/);
  });
});
