import { describe, expect, it } from "vitest";
import { evaluateUnifiedActionPermission } from "./unified-permission";
import {
  actionWriteFlags,
  isHardPlanDenial,
  planPermissionDeniedResponse,
} from "./plan-permission";
import { FINANCIAL_WRITES_ENABLED } from "../approvals";
import type { Env } from "../../env";

class FakeD1 {
  prepare() {
    return {
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    };
  }
}

const db = new FakeD1() as unknown as D1Database;

async function decide(action: string, riskClass: "financial_action" | "external_send" | "delete" | "write") {
  return evaluateUnifiedActionPermission(db, {
    action,
    riskClass,
    companyId: "co_caddington",
    companyStatus: "active",
    connectorConnected: true,
    connectorAuthStatus: "connected",
    grantedScopes: ["accounting.transactions", "accounting.contacts"],
    actorType: "service",
    skipRoleCheck: true,
    flags: actionWriteFlags({} as Env, action),
  });
}

describe("Xero write V1 plan-time confirmation gates", () => {
  it("allows production-enabled draft invoice create to persist a confirmable plan", async () => {
    const decision = await decide("xero.invoices.create", "financial_action");
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
    expect(isHardPlanDenial(decision)).toBe(false);
    expect(FINANCIAL_WRITES_ENABLED).toBe(true);
  });

  it("allows production-enabled invoice approve and draft bill create", async () => {
    expect((await decide("xero.invoices.approve", "financial_action")).allowed).toBe(true);
    expect((await decide("xero.invoices.update", "financial_action")).allowed).toBe(true);
    expect((await decide("xero.bills.create", "financial_action")).allowed).toBe(true);
  });

  it("does not persist confirmable plans for send, combined send, allocate, or credit-invoice", async () => {
    const send = await decide("xero.invoices.send", "external_send");
    const combined = await decide("xero.invoices.create_approve_send", "external_send");
    const allocate = await decide("xero.payments.allocate", "financial_action");
    const creditAllocate = await decide("xero.credit_notes.allocate", "financial_action");
    const creditInvoices = await decide("xero.credit_notes.create", "financial_action");

    for (const decision of [send, combined, allocate, creditAllocate, creditInvoices]) {
      expect(decision.allowed).toBe(false);
      expect(isHardPlanDenial(decision)).toBe(true);
      const denied = planPermissionDeniedResponse(decision, "xero.invoices.send");
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("ACTION_PERMISSION_DENIED");
    }
    expect(send.denialCode).toBe("PLATFORM_RESTRICTED");
    expect(allocate.denialCode).toBe("PLATFORM_RESTRICTED");
  });

  it("denies destructive void without an explicit destructive-writes flag", async () => {
    const voidInvoice = await decide("xero.invoice.void", "delete");
    expect(voidInvoice.allowed).toBe(false);
    expect(isHardPlanDenial(voidInvoice)).toBe(true);
    expect(["PLATFORM_RESTRICTED", "destructive_disabled"]).toContain(voidInvoice.denialCode);
    expect(actionWriteFlags({} as Env, "xero.invoice.void").destructiveWritesEnabled).toBe(false);
  });

  it("keeps prefix-protected INFRA test-draft cleanup plannable", async () => {
    expect(actionWriteFlags({} as Env, "xero.test_artefact.delete_draft").destructiveWritesEnabled).toBe(
      true,
    );
    const decision = await decide("xero.test_artefact.delete_draft", "delete");
    expect(decision.allowed).toBe(true);
    expect(isHardPlanDenial(decision)).toBe(false);
  });
});
