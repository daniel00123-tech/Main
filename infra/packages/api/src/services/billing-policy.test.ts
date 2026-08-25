import { describe, expect, it } from "vitest";
import {
  classifyZeroResultSuccess,
  decideTestBilling,
} from "./billing-policy";

describe("TEST billing policy", () => {
  it("does not charge health or discovery", () => {
    expect(
      decideTestBilling({
        action: "system.health",
        toolName: "system_health",
        success: true,
        httpStatus: 200,
        ruleBillable: false,
      }).customerBillable,
    ).toBe(false);
    expect(
      decideTestBilling({
        action: "xero.health",
        toolName: "xero_connection_test",
        success: true,
        httpStatus: 200,
        ruleBillable: true,
      }).customerBillable,
    ).toBe(false);
    expect(
      decideTestBilling({
        action: "xero.token_refresh",
        success: true,
        httpStatus: 200,
        ruleBillable: true,
      }).customerBillable,
    ).toBe(false);
  });

  it("does not charge auth, permission, or insufficient credit", () => {
    expect(
      decideTestBilling({
        action: "knowledge.search",
        success: false,
        httpStatus: 401,
        ruleBillable: true,
      }).outcome,
    ).toBe("authentication_failure");
    expect(
      decideTestBilling({
        action: "knowledge.search",
        success: false,
        httpStatus: 403,
        ruleBillable: true,
      }).customerBillable,
    ).toBe(false);
    expect(
      decideTestBilling({
        action: "knowledge.search",
        success: false,
        httpStatus: 402,
        ruleBillable: true,
      }).customerBillable,
    ).toBe(false);
  });

  it("does not charge downstream or internal failures by default", () => {
    expect(
      decideTestBilling({
        action: "knowledge.search",
        success: false,
        httpStatus: 502,
        ruleBillable: true,
        chargeOnFailure: false,
      }).customerBillable,
    ).toBe(false);
  });

  it("does not charge idempotent replay", () => {
    expect(
      decideTestBilling({
        action: "knowledge.search",
        success: true,
        httpStatus: 200,
        ruleBillable: true,
        idempotentReplay: true,
      }).customerBillable,
    ).toBe(false);
  });

  it("charges successful billable operations", () => {
    const decision = decideTestBilling({
      action: "knowledge.search",
      success: true,
      httpStatus: 200,
      ruleBillable: true,
    });
    expect(decision.customerBillable).toBe(true);
    expect(decision.outcome).toBe("success_with_results");
  });

  it("keeps zero-result successful searches billable under TEST", () => {
    const zero = classifyZeroResultSuccess();
    expect(zero.customerBillable).toBe(true);
    expect(zero.outcome).toBe("success_zero_results");
  });
});
