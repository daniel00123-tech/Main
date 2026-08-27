import { describe, expect, it } from "vitest";
import { resolveWalletHealthState } from "./wallet-health";

describe("resolveWalletHealthState", () => {
  it("returns empty at zero", () => {
    expect(resolveWalletHealthState(0, 500)).toBe("empty");
  });

  it("returns low below threshold", () => {
    expect(resolveWalletHealthState(400, 500)).toBe("low");
  });

  it("returns healthy above threshold", () => {
    expect(resolveWalletHealthState(1000, 500)).toBe("healthy");
  });

  it("returns critical near zero", () => {
    expect(resolveWalletHealthState(50, 500)).toBe("critical");
  });
});
