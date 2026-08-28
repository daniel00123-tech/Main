import { describe, expect, it } from "vitest";
import {
  assertXeroActionAllowedInContext,
  assertXeroToolAllowedInContext,
  classifyNaturalLanguageXeroIntent,
  isXeroMutationToolName,
  isXeroReadToolName,
  xeroToolGovernance,
} from "@infra/shared";

describe("Xero governance metadata", () => {
  it("classifies read tools as mutation none", () => {
    const gov = xeroToolGovernance("xero_search_invoices");
    expect(gov?.mutationType).toBe("none");
    expect(gov?.riskLevel).toBe("read");
    expect(gov?.requiresExplicitWriteIntent).toBe(false);
    expect(isXeroReadToolName("xero_search_invoices")).toBe(true);
    expect(isXeroMutationToolName("xero_search_invoices")).toBe(false);
  });

  it("classifies draft invoice create as explicit write", () => {
    const gov = xeroToolGovernance("xero_create_draft_invoice");
    expect(gov?.mutationType).toBe("create");
    expect(gov?.requiresExplicitWriteIntent).toBe(true);
    expect(gov?.requiresConfirmation).toBe(true);
    expect(isXeroMutationToolName("xero_create_draft_invoice")).toBe(true);
  });

  it("blocks mutation tools in read_only execution context", () => {
    const gate = assertXeroToolAllowedInContext({
      executionMode: "read_only",
      toolName: "xero_create_draft_invoice",
      companyWriteMode: "CONTROLLED_WRITE",
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.code).toBe("XERO_READ_ONLY_CONTEXT");
  });

  it("allows read tools in read_only context", () => {
    const gate = assertXeroToolAllowedInContext({
      executionMode: "read_only",
      toolName: "xero_get_invoice",
      companyWriteMode: "READ_ONLY",
    });
    expect(gate.allowed).toBe(true);
  });

  it("blocks writes for READ_ONLY company even in action engine context", () => {
    const gate = assertXeroActionAllowedInContext({
      executionMode: "action_engine_execute",
      action: "xero.invoices.create",
      companyWriteMode: "READ_ONLY",
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.code).toBe("XERO_COMPANY_READ_ONLY");
  });

  it("allows draft write for Caddington-style CONTROLLED_WRITE via action engine", () => {
    const gate = assertXeroActionAllowedInContext({
      executionMode: "action_engine_execute",
      action: "xero.invoices.create",
      companyWriteMode: "CONTROLLED_WRITE",
    });
    expect(gate.allowed).toBe(true);
  });

  it("blocks destructive actions under CONTROLLED_WRITE", () => {
    const gate = assertXeroActionAllowedInContext({
      executionMode: "action_engine_execute",
      action: "xero.invoice.void",
      companyWriteMode: "CONTROLLED_WRITE",
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.code).toBe("XERO_WRITE_NOT_APPROVED");
  });

  it("defaults ambiguous natural language to read classification helper", () => {
    expect(classifyNaturalLanguageXeroIntent("show me July invoices")).toBe("read");
    expect(classifyNaturalLanguageXeroIntent("create a £1 draft invoice")).toBe("write");
    expect(classifyNaturalLanguageXeroIntent("check invoice and update if wrong")).toBe("ambiguous");
  });
});
