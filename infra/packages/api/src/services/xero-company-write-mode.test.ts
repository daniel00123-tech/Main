import { describe, expect, it } from "vitest";
import {
  defaultXeroWriteModeForCompany,
  parseXeroWriteModeFromConfig,
} from "./xero-company-write-mode";

describe("Xero company write mode", () => {
  it("defaults Caddington to CONTROLLED_WRITE", () => {
    expect(defaultXeroWriteModeForCompany("co_caddington")).toBe("CONTROLLED_WRITE");
  });

  it("defaults other companies to READ_ONLY", () => {
    expect(defaultXeroWriteModeForCompany("co_ht")).toBe("READ_ONLY");
    expect(defaultXeroWriteModeForCompany("co_el")).toBe("READ_ONLY");
  });

  it("parses config override", () => {
    expect(parseXeroWriteModeFromConfig({ xeroWriteMode: "READ_ONLY" })).toBe("READ_ONLY");
    expect(parseXeroWriteModeFromConfig({ xeroWriteMode: "INVALID" })).toBeNull();
  });
});
