import { describe, expect, it } from "vitest";
import {
  adminDashboardOperationSummary,
  attentionReviewHeading,
  onboardingStatusPresentation,
  permissionDenialOperatorSummary,
} from "./admin-present";

describe("admin-present", () => {
  it("summarises granular xero tool names for admin dashboard", () => {
    expect(adminDashboardOperationSummary("tool.execute", "xero.reports.aged.read")).toBe(
      "Xero reporting",
    );
    expect(adminDashboardOperationSummary("tool.execute", "xero_vat_capability")).toBe(
      "Xero accounting",
    );
  });

  it("does not treat permission denials as critical by default", () => {
    const summary = permissionDenialOperatorSummary(9);
    expect(summary.reviewRecommended).toBe(false);
    expect(summary.headline).toContain("policy-enforced");
  });

  it("flags unusually high denial volume for review", () => {
    expect(permissionDenialOperatorSummary(30).reviewRecommended).toBe(true);
  });

  it("uses operator-friendly onboarding labels", () => {
    expect(onboardingStatusPresentation("complete").label).toBe("Complete");
    expect(onboardingStatusPresentation("not_configured").label).toBe("Not configured");
  });

  it("fixes attention heading grammar for singular items", () => {
    expect(attentionReviewHeading(1, 0)).toBe("1 item needs review");
    expect(attentionReviewHeading(2, 1)).toBe("2 items need review · 1 critical");
  });
});
