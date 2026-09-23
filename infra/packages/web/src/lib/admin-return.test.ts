import { describe, expect, it } from "vitest";
import { safeAdminReturnPath } from "./admin-return";

describe("safeAdminReturnPath", () => {
  it("returns quality improvements including query", () => {
    expect(safeAdminReturnPath("/quality/improvements?run=qlr_1")).toBe("/quality/improvements?run=qlr_1");
    expect(safeAdminReturnPath("/quality/improvements")).toBe("/quality/improvements");
  });

  it("rejects off-site and login loops", () => {
    expect(safeAdminReturnPath("https://evil.example/quality/improvements")).toBeNull();
    expect(safeAdminReturnPath("//evil.example/x")).toBeNull();
    expect(safeAdminReturnPath("/login")).toBeNull();
    expect(safeAdminReturnPath("/portal/login")).toBeNull();
  });
});
