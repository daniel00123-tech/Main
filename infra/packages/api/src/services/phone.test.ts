import { describe, expect, it } from "vitest";
import {
  MobileValidationError,
  normalizeE164,
  tryNormalizeE164,
  maskMobileE164,
  UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE,
} from "./phone";

describe("normalizeE164", () => {
  it("accepts international UK mobiles", () => {
    expect(normalizeE164("+447700900123")).toBe("+447700900123");
    expect(normalizeE164("+44 7700 900123")).toBe("+447700900123");
  });

  it("accepts UK national 07 numbers", () => {
    expect(normalizeE164("07700900123")).toBe("+447700900123");
  });

  it("accepts country code without plus", () => {
    expect(normalizeE164("447700900123")).toBe("+447700900123");
  });

  it("rejects empty and invalid values", () => {
    expect(() => normalizeE164("")).toThrow(MobileValidationError);
    expect(() => normalizeE164("not-a-number")).toThrow(MobileValidationError);
    expect(() => normalizeE164("123")).toThrow(MobileValidationError);
  });

  it("tryNormalize does not throw", () => {
    expect(tryNormalizeE164("bad").ok).toBe(false);
    expect(tryNormalizeE164("+447700900123")).toEqual({
      ok: true,
      e164: "+447700900123",
    });
  });

  it("masks numbers for non-super-admin display", () => {
    expect(maskMobileE164("+447700900123")).toBe("+44••••0123");
  });

  it("keeps the unknown WhatsApp copy tenant-safe", () => {
    expect(UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE).not.toMatch(/Caddington|company|tenant/i);
  });
});
