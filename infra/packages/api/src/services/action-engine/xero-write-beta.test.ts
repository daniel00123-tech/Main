import { describe, expect, it, vi } from "vitest";
import { checkBetaProductionGate } from "./xero-write-executors";
import { humanReadablePlanPreview, humanReadableExecutionSummary } from "./human-readable";
import type { ActionPlanRecord } from "@infra/shared";

describe("beta production gate", () => {
  it("blocks send when not production enabled", () => {
    const blocked = checkBetaProductionGate("xero.invoices.send");
    expect(blocked?.ok).toBe(false);
    expect(blocked?.code).toBe("BETA_GATE_BLOCKED");
  });

  it("allows draft invoice create", () => {
    expect(checkBetaProductionGate("xero.invoices.create")).toBeNull();
  });
});

describe("human readable responses", () => {
  const basePlan = {
    id: "act_1",
    companyId: "co_test",
    requestedAction: "xero.invoices.create",
    summary: "Create draft",
    targets: [{
      targetId: "c1",
      targetType: "draft_invoice",
      humanRef: "Elvex",
      currentState: { contactName: "Elvex Property Services Ltd" },
      proposedState: { contactName: "Elvex Property Services Ltd", total: 1 },
      validation: "valid" as const,
    }],
    financialImpact: { currencyCode: "GBP", totalAmount: 1, direction: "debit" as const, itemCount: 1 },
  } as unknown as ActionPlanRecord;

  it("formats plan preview without exposing raw UUIDs as primary label", () => {
    const preview = humanReadablePlanPreview(basePlan);
    expect(preview.counterparty).toBe("Elvex Property Services Ltd");
    expect(String(preview.confirmationPrompt ?? "")).toContain("draft");
  });

  it("formats successful execution summary", () => {
    const summary = humanReadableExecutionSummary(basePlan, {
      ok: true,
      status: "completed",
      executionId: "aex_1",
      xeroResourceId: "inv-id",
      humanReference: "INV-0040",
      verificationStatus: "verified",
      results: { total: 1 },
    });
    expect(summary).toContain("INV-0040");
    expect(summary).toContain("created successfully");
  });
});

describe("direct write bypass invariant", () => {
  it("write tool names remain classified as write tools", async () => {
    const { isXeroWriteToolName } = await import("../xero-tools");
    expect(isXeroWriteToolName("xero_create_draft_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_approve_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_send_invoice")).toBe(true);
    expect(isXeroWriteToolName("xero_create_draft_bill")).toBe(true);
    expect(isXeroWriteToolName("xero_get_invoice")).toBe(false);
  });
});
