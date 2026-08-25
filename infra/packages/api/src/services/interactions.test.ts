import { describe, expect, it } from "vitest";
import type { UsageRecord } from "@infra/shared";
import {
  groupLedgerCharges,
  groupOperationsIntoInteractions,
  labelForOperation,
  labelInteraction,
  operationIdempotencyKey,
  resolveInteractionIds,
  sanitizeInteractionId,
} from "./interactions";

function record(
  partial: Partial<UsageRecord> & Pick<UsageRecord, "id">,
): UsageRecord {
  return {
    companyId: "co_ht",
    resourceType: "gateway",
    resourceId: "search_company_knowledge",
    quantity: 1,
    unit: "request",
    recordedAt: "2026-08-24T21:06:00.000Z",
    metadata: {},
    actorEmail: "HT probe",
    sourceClient: "chatgpt",
    action: "knowledge.search",
    toolName: "search_company_knowledge",
    customerChargeCents: 1,
    underlyingCostCents: null,
    costBasis: "unknown",
    success: true,
    ...partial,
  };
}

describe("resolveInteractionIds", () => {
  it("never treats JSON-RPC 0 as an interaction id", () => {
    const resolved = resolveInteractionIds({
      headerInteractionId: "0",
      parentRequestId: "0",
      mcpSessionId: "0",
    });
    expect(resolved.interactionId).toMatch(/^int_/);
    expect(resolved.interactionId).not.toBe("0");
    expect(resolved.parentRequestId).toBeNull();
    expect(resolved.mcpSessionId).toBeNull();
    expect(resolved.sourcedFrom).toBe("generated");
    expect(resolved.clientInteractionRef).toBeNull();
  });

  it("preserves a trustworthy client interaction id", () => {
    const resolved = resolveInteractionIds({
      headerInteractionId: "int_prompt_abc123",
    });
    expect(resolved.interactionId).toBe("int_prompt_abc123");
    expect(resolved.sourcedFrom).toBe("client");
    expect(resolved.clientInteractionRef).toBe("int_prompt_abc123");
  });

  it("does not use company or MCP ids as grouping keys", () => {
    const resolved = resolveInteractionIds({
      headerInteractionId: "mcp_caddington_primary",
    });
    expect(resolved.interactionId).toMatch(/^int_/);
    expect(resolved.interactionId).not.toBe("mcp_caddington_primary");
    expect(resolved.sourcedFrom).toBe("generated");
    expect(resolved.clientInteractionRef).toBe("mcp_caddington_primary");
  });

  it("generates a new id per call when the client sends nothing", () => {
    const a = resolveInteractionIds({});
    const b = resolveInteractionIds({});
    expect(a.interactionId).toMatch(/^int_/);
    expect(b.interactionId).toMatch(/^int_/);
    expect(a.interactionId).not.toBe(b.interactionId);
  });

  it("rejects malformed client ids for grouping", () => {
    expect(sanitizeInteractionId("mcp_caddington_primary")).toBeNull();
    expect(sanitizeInteractionId("int_")).toBeNull();
    expect(sanitizeInteractionId("0")).toBeNull();
    expect(sanitizeInteractionId("int_ok_123")).toBe("int_ok_123");
  });
});

describe("operationIdempotencyKey", () => {
  it("does not use JSON-RPC 0", () => {
    const key = operationIdempotencyKey({
      companyId: "co_ht",
      clientRequestId: "0",
      requestId: "req_server_1",
    });
    expect(key).toBe("op:co_ht:req_server_1");
  });

  it("uses an explicit client request id when present", () => {
    expect(
      operationIdempotencyKey({
        companyId: "co_ht",
        clientRequestId: "hdr-1",
        requestId: "req_server_1",
      }),
    ).toBe("op:co_ht:hdr-1");
  });

  it("gives different keys for two operations in one interaction", () => {
    const search = operationIdempotencyKey({
      companyId: "co_ht",
      clientRequestId: "call-search",
      requestId: "req_a",
    });
    const read = operationIdempotencyKey({
      companyId: "co_ht",
      clientRequestId: "call-read",
      requestId: "req_b",
    });
    expect(search).not.toBe(read);
  });
});

describe("groupOperationsIntoInteractions", () => {
  it("keeps uncorrelated operations separate", () => {
    const groups = groupOperationsIntoInteractions([
      record({ id: "u1", action: "knowledge.search", interactionId: "int_aaaaaa" }),
      record({ id: "u2", action: "knowledge.read", interactionId: "int_bbbbbb" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.customerChargeCents).toBe(1);
    expect(groups[1]?.customerChargeCents).toBe(1);
  });

  it("groups only when interaction_id is shared", () => {
    const groups = groupOperationsIntoInteractions([
      record({ id: "u1", action: "knowledge.search", interactionId: "int_shared" }),
      record({
        id: "u2",
        action: "knowledge.read",
        toolName: "get_knowledge_document",
        interactionId: "int_shared",
        recordedAt: "2026-08-24T21:06:01.000Z",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("AI Knowledge Request");
    expect(groups[0]?.operationCount).toBe(2);
    expect(groups[0]?.customerChargeCents).toBe(2);
    expect(groups[0]?.providerCostKnown).toBe(false);
    expect(groups[0]?.providerCostCents).toBeNull();
    expect(groups[0]?.operations.map((o) => o.action)).toEqual([
      "knowledge.search",
      "knowledge.read",
    ]);
  });

  it("does not invent groups for missing interaction ids", () => {
    const groups = groupOperationsIntoInteractions([
      record({ id: "u1", action: "knowledge.search" }),
      record({ id: "u2", action: "knowledge.read" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does not treat nearby timestamps as the same interaction", () => {
    const groups = groupOperationsIntoInteractions([
      record({
        id: "u1",
        action: "knowledge.search",
        interactionId: "int_oneaaa",
        recordedAt: "2026-08-24T21:06:00.000Z",
      }),
      record({
        id: "u2",
        action: "knowledge.read",
        interactionId: "int_twoaaa",
        recordedAt: "2026-08-24T21:06:01.000Z",
      }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("ledger presentation grouping", () => {
  it("aggregates usage debits that share a trustworthy interaction id", () => {
    const groups = groupLedgerCharges([
      {
        id: "l1",
        entryType: "usage_debit",
        amountCents: -1,
        description: "ChatGPT · Knowledge Search",
        createdAt: "t1",
        metadata: { interactionId: "int_shared" },
      },
      {
        id: "l2",
        entryType: "usage_debit",
        amountCents: -1,
        description: "ChatGPT · Knowledge Read",
        createdAt: "t2",
        metadata: { interactionId: "int_shared" },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.amountCents).toBe(-2);
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[0]?.kind).toBe("interaction");
  });

  it("does not group credits or uncorrelated debits", () => {
    const groups = groupLedgerCharges([
      {
        id: "c1",
        entryType: "promotional_credit",
        amountCents: 1000,
        description: "Opening credit",
        createdAt: "t0",
      },
      {
        id: "l1",
        entryType: "usage_debit",
        amountCents: -1,
        description: "ChatGPT · Knowledge Search",
        createdAt: "t1",
        metadata: { interactionId: "int_aaaaaa" },
      },
      {
        id: "l2",
        entryType: "usage_debit",
        amountCents: -1,
        description: "ChatGPT · Knowledge Search",
        createdAt: "t2",
        metadata: { interactionId: "int_bbbbbb" },
      },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.amountCents)).toEqual([1000, -1, -1]);
  });
});

describe("labels", () => {
  it("names a single search as Knowledge Search", () => {
    expect(labelInteraction([record({ id: "u1" })])).toBe("Knowledge Search");
    expect(labelForOperation("knowledge.read")).toBe("Knowledge Document Read");
  });
});
