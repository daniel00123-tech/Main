import { describe, expect, it } from "vitest";
import {
  generateSetupTokenValue,
  hashSetupToken,
  maskEmail,
  validateNewPassword,
} from "../auth/password-setup";

describe("password setup tokens", () => {
  it("generates unique token values", () => {
    const a = generateSetupTokenValue();
    const b = generateSetupTokenValue();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("hashes tokens deterministically", async () => {
    const hash1 = await hashSetupToken("abc123");
    const hash2 = await hashSetupToken("abc123");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("masks email addresses", () => {
    expect(maskEmail("daniel.dwyer123@gmail.com")).toBe("d***@gmail.com");
  });

  it("validates password length", () => {
    expect(validateNewPassword("short")).toMatch(/12 characters/);
    expect(validateNewPassword("long-enough-password")).toBeNull();
  });
});
