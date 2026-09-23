import { describe, expect, it } from "vitest";
import {
  QUALITY_MOBILE_TAP_MIN_PX,
  acceptRemainingButton,
  bulkLowButton,
  defaultQualityFilter,
  isPendingLowSafe,
  isReviewOnlyPending,
  itemActionsEnabled,
  itemPrimaryHint,
  itemPrimaryKind,
  itemPrimaryLabel,
  pendingLowSafe,
  pendingReviewOnly,
  type QualityProposalLite,
} from "./quality-improvements-actions";

function proposal(partial: Partial<QualityProposalLite> & { id: string }): QualityProposalLite {
  return {
    status: "pending_approval",
    risk: "low",
    applyClass: "AUTO_APPLY_SAFE",
    engineeringRequired: false,
    autoApplyable: true,
    ...partial,
  };
}

const danielScreenshot = [
  proposal({ id: "applied-1", status: "canary", risk: "low", applyClass: "AUTO_APPLY_SAFE" }),
  proposal({ id: "applied-2", status: "canary", risk: "medium", applyClass: "AUTO_APPLY_SAFE" }),
  proposal({ id: "applied-3", status: "promoted", risk: "low", applyClass: "AUTO_APPLY_SAFE" }),
  proposal({
    id: "eng-1",
    risk: "high",
    applyClass: "REQUIRES_ENGINEERING",
    engineeringRequired: true,
    autoApplyable: false,
  }),
  proposal({
    id: "eng-2",
    risk: "medium",
    applyClass: "REQUIRES_ENGINEERING",
    engineeringRequired: true,
    autoApplyable: false,
  }),
  proposal({
    id: "info-1",
    risk: "low",
    applyClass: "INFORMATIONAL",
    engineeringRequired: false,
    autoApplyable: false,
  }),
  proposal({
    id: "recon-1",
    risk: "medium",
    applyClass: "INFORMATIONAL",
    engineeringRequired: false,
    autoApplyable: false,
  }),
  proposal({
    id: "eng-3",
    risk: "high",
    applyClass: "REQUIRES_ENGINEERING",
    engineeringRequired: true,
    autoApplyable: false,
  }),
  proposal({
    id: "eng-4",
    risk: "medium",
    applyClass: "REQUIRES_ENGINEERING",
    engineeringRequired: true,
    autoApplyable: false,
  }),
];

describe("quality improvement action enablement", () => {
  it("disables bulk LOW when the 3 AUTO_APPLY_SAFE items are already canary/applied", () => {
    expect(pendingLowSafe(danielScreenshot)).toEqual([]);
    const bulk = bulkLowButton(danielScreenshot);
    expect(bulk.enabled).toBe(false);
    expect(bulk.showButton).toBe(false);
    expect(bulk.reason).toBe("No LOW-risk items left to apply");
  });

  it("enables bulk LOW only when at least one pending AUTO_APPLY_SAFE LOW exists", () => {
    const pendingLow = proposal({ id: "low-1" });
    const bulk = bulkLowButton([...danielScreenshot, pendingLow]);
    expect(bulk.enabled).toBe(true);
    expect(bulk.showButton).toBe(true);
    expect(bulk.count).toBe(1);
    expect(bulk.reason).toBeNull();
    expect(isPendingLowSafe(pendingLow)).toBe(true);
    expect(isPendingLowSafe(danielScreenshot[0])).toBe(false);
  });

  it("does not treat already-canary LOW as pending LOW", () => {
    const canary = proposal({ id: "c1", status: "canary" });
    expect(isPendingLowSafe(canary)).toBe(false);
    expect(bulkLowButton([canary]).enabled).toBe(false);
  });

  it("enables Accept and Reject for open engineering / informational items", () => {
    const open = danielScreenshot.filter((row) => row.status === "pending_approval");
    expect(open).toHaveLength(6);
    expect(pendingReviewOnly(open)).toHaveLength(6);
    for (const row of open) {
      expect(isReviewOnlyPending(row)).toBe(true);
      expect(itemPrimaryKind(row)).toBe("accept");
      expect(itemPrimaryLabel(row)).toBe("Accept");
      const enabled = itemActionsEnabled(row, false);
      expect(enabled.accept).toBe(true);
      expect(enabled.reject).toBe(true);
      expect(enabled.apply).toBe(false);
      expect(itemPrimaryHint(row)).toMatch(/does not auto-deploy/i);
    }
  });

  it("keeps Accept/Reject disabled only while a mutation is in flight", () => {
    const row = proposal({
      id: "eng",
      applyClass: "REQUIRES_ENGINEERING",
      engineeringRequired: true,
      autoApplyable: false,
    });
    expect(itemActionsEnabled(row, true)).toEqual({
      apply: false,
      accept: false,
      reject: false,
      rollback: false,
      evidence: false,
    });
    expect(itemActionsEnabled(row, false).accept).toBe(true);
    expect(itemActionsEnabled(row, false).reject).toBe(true);
  });

  it("enables Apply only for pending AUTO_APPLY_SAFE items", () => {
    const low = proposal({ id: "low" });
    const mediumSafe = proposal({ id: "med", risk: "medium" });
    expect(itemPrimaryKind(low)).toBe("apply");
    expect(itemPrimaryLabel(low)).toBe("Apply");
    expect(itemActionsEnabled(low, false).apply).toBe(true);
    expect(itemActionsEnabled(low, false).accept).toBe(false);
    expect(itemActionsEnabled(mediumSafe, false).apply).toBe(true);
    expect(itemActionsEnabled(danielScreenshot[3], false).apply).toBe(false);
  });

  it("exposes Accept remaining only when review-only open items exist", () => {
    const none = acceptRemainingButton(danielScreenshot.filter((row) => row.status !== "pending_approval"));
    expect(none.showButton).toBe(false);
    expect(none.enabled).toBe(false);

    const remaining = acceptRemainingButton(danielScreenshot);
    expect(remaining.enabled).toBe(true);
    expect(remaining.showButton).toBe(true);
    expect(remaining.count).toBe(6);
    expect(remaining.hint).toMatch(/does not auto-deploy/i);
  });

  it("defaults the filter to pending when open items remain", () => {
    expect(defaultQualityFilter(danielScreenshot)).toBe("pending");
    expect(defaultQualityFilter(danielScreenshot.filter((row) => row.status !== "pending_approval"))).toBe("all");
  });

  it("requires 44px mobile tap targets and never uses hover-only actions", () => {
    expect(QUALITY_MOBILE_TAP_MIN_PX).toBe(44);
    for (const row of danielScreenshot.filter((item) => item.status === "pending_approval")) {
      const actions = itemActionsEnabled(row, false);
      expect(actions.accept || actions.apply).toBe(true);
      expect(actions.reject).toBe(true);
    }
  });
});
