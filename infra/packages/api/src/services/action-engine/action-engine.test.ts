import { describe, expect, it, vi, beforeEach } from "vitest";
import { evaluateActionPermission } from "./permission-engine";
import {
  fingerprintTargets,
  generateConfirmationToken,
  createActionPlan,
  confirmActionPlan,
  approveActionPlan,
  rejectActionPlan,
  isPlanStale,
} from "./action-engine";
import type { ActionTarget, PermissionDecision } from "@infra/shared";

type Row = Record<string, unknown>;

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
    private binds: unknown[] = [],
  ) {}

  bind(...args: unknown[]) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first() {
    return this.db.first(this.sql, this.binds);
  }

  async all() {
    return { results: this.db.all(this.sql, this.binds) };
  }

  async run() {
    this.db.run(this.sql, this.binds);
    return { success: true };
  }
}

class FakeD1 {
  tables: Record<string, Row[]>;

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = { execution_plans: [], audit_events: [], ...seed };
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from execution_plans where id = ? and company_id = ?")) {
      return (
        this.tables.execution_plans.find(
          (r) => r.id === binds[0] && r.company_id === binds[1],
        ) ?? null
      );
    }
    if (q.includes("from execution_plans where company_id = ? and idempotency_key = ?")) {
      return (
        this.tables.execution_plans.find(
          (r) => r.company_id === binds[0] && r.idempotency_key === binds[1],
        ) ?? null
      );
    }
    if (q.includes("confirmation_token_hash from execution_plans")) {
      const row = this.tables.execution_plans.find(
        (r) => r.id === binds[0] && r.company_id === binds[1],
      );
      return row ? { confirmation_token_hash: row.confirmation_token_hash } : null;
    }
    return null;
  }

  all(sql: string, binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from execution_plans where company_id = ?")) {
      return this.tables.execution_plans.filter((r) => r.company_id === binds[0]);
    }
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into execution_plans")) {
      this.tables.execution_plans.push({
        id: binds[0],
        company_id: binds[1],
        connector_instance_id: binds[2],
        provider: binds[3],
        requested_action: binds[4],
        status: binds[5],
        idempotency_key: binds[6],
        actor: binds[7],
        correlation_id: binds[8],
        interaction_id: binds[9],
        payload_json: binds[10],
        proposed_changes_json: binds[11],
        required_approval: binds[12],
        approval_status: binds[13],
        summary: binds[14],
        created_at: binds[15],
        updated_at: binds[16],
        risk_class: binds[17],
        source_client: binds[18],
        permission_decision_json: binds[19],
        financial_impact_json: binds[20],
        confirmation_status: binds[21],
        confirmation_token_hash: binds[22],
        plan_fingerprint: binds[23],
        state_version: 1,
        expires_at: binds[24],
        confirmed_at: null,
        confirmed_by: null,
        executed_at: null,
      });
    }
    if (q.includes("update execution_plans set confirmation_status")) {
      const row = this.tables.execution_plans.find(
        (r) => r.id === binds[5] && r.company_id === binds[6],
      );
      if (row) {
        row.confirmation_status = "confirmed";
        row.confirmed_at = binds[0];
        row.confirmed_by = binds[1];
        row.status = binds[2];
        row.updated_at = binds[3];
      }
    }
    if (q.includes("update execution_plans set approval_status = 'approved'")) {
      const row = this.tables.execution_plans.find(
        (r) => r.id === binds[1] && r.company_id === binds[2],
      );
      if (row) {
        row.approval_status = "approved";
        row.status = "approved";
        row.updated_at = binds[0];
      }
    }
    if (q.includes("update execution_plans set approval_status = 'denied'")) {
      const row = this.tables.execution_plans.find(
        (r) => r.id === binds[1] && r.company_id === binds[2],
      );
      if (row) {
        row.approval_status = "denied";
        row.updated_at = binds[0];
      }
    }
    if (q.includes("update execution_plans set status = ?")) {
      const row = this.tables.execution_plans.find(
        (r) => r.id === binds[4] && r.company_id === binds[5],
      );
      if (row) {
        row.status = binds[0];
        row.updated_at = binds[1];
      }
    }
    if (q.startsWith("insert into audit_events") || q.includes("audit")) {
      this.tables.audit_events.push({ event: binds });
    }
  }
}

const basePermission: PermissionDecision = {
  allowed: true,
  reasonCode: "confirmation_required",
  requiredPermission: "xero.invoices.create",
  riskClass: "financial_action",
  writesSupported: true,
  writesEnabled: false,
  financialWritesEnabled: false,
  destructiveWritesEnabled: false,
  requiresConfirmation: true,
  requiresApproval: false,
};

const validTarget: ActionTarget = {
  targetId: "inv-1",
  targetType: "invoice",
  humanRef: "INV-001",
  currentState: { amountDue: 100 },
  proposedState: { creditAmount: 100 },
  amount: 100,
  validation: "valid",
};

vi.mock("../control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

describe("permission engine", () => {
  it("denies financial writes when disabled", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      flags: { financialWritesEnabled: false, writesEnabled: false },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("writes_disabled");
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("denies when company suspended", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "suspended",
      connectorConnected: true,
      connectorAuthStatus: "connected",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("company_suspended");
  });

  it("denies when OAuth scope missing", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      grantedScopes: ["accounting.invoices.read"],
      requiredScopes: ["accounting.invoices"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("scope_missing");
  });

  it("denies destructive writes by default", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoice.void",
      riskClass: "delete",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      flags: { destructiveWritesEnabled: false },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("destructive_disabled");
  });

  it("denies when connector disconnected", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: false,
      connectorAuthStatus: "disconnected",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("connector_disconnected");
  });
});

describe("action plan fingerprint", () => {
  it("changes when proposed state changes", async () => {
    const base: ActionTarget[] = [validTarget];
    const changed: ActionTarget[] = [
      { ...validTarget, proposedState: { creditAmount: 50 } },
    ];
    expect(await fingerprintTargets(base)).not.toBe(await fingerprintTargets(changed));
  });

  it("detects stale plans", async () => {
    const fp = await fingerprintTargets([validTarget]);
    expect(isPlanStale({ planFingerprint: fp } as never, fp)).toBe(false);
    expect(isPlanStale({ planFingerprint: fp } as never, "different")).toBe(true);
  });
});

describe("action plan lifecycle", () => {
  it("creates failed plan when targets fail preflight", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const invalidTarget: ActionTarget = {
      ...validTarget,
      validation: "invalid",
      validationDetail: "Contact could not be resolved.",
    };
    const { plan, confirmationToken } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      targets: [invalidTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
      summary: "Draft invoice plan failed — contact not found.",
    });
    expect(plan.status).toBe("failed");
    expect(plan.confirmationStatus).toBe("not_required");
    expect(confirmationToken).toBeNull();
  });

  it("rejects confirmation for failed planning plan", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      targets: [{ ...validTarget, validation: "invalid", validationDetail: "Contact not found" }],
      permissionDecision: basePermission,
      riskClass: "financial_action",
      summary: "Draft invoice plan failed — contact not found.",
    });
    const result = await confirmActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "user@test.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PLAN_NOT_EXECUTABLE");
  });

  it("creates plan with confirmation token", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan, confirmationToken } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    expect(plan.id.startsWith("act_")).toBe(true);
    expect(plan.status).toBe("awaiting_confirmation");
    expect(confirmationToken).toBeTruthy();
  });

  it("returns existing plan for duplicate idempotency key", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const first = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      idempotencyKey: "idem-1",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    const second = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      idempotencyKey: "idem-1",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.confirmationToken).toBeNull();
  });

  it("rejects invalid confirmation token", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan, confirmationToken } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    const result = await confirmActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "user@test.com",
      confirmationToken: "wrong-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONFIRMATION_INVALID");
    expect(confirmationToken).not.toBe("wrong-token");
  });

  it("confirms valid plan and allows execution when operator gate is enabled", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan, confirmationToken } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
      actor: "user@test.com",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    const result = await confirmActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "user@test.com",
      confirmationToken: confirmationToken!,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executionBlocked).toBe(false);
      expect(result.blockReason).toBeUndefined();
    }
  });

  it("prevents self-approval", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.credit_notes.create",
      actor: "requester@test.com",
      targets: [validTarget],
      permissionDecision: { ...basePermission, requiresApproval: true },
      riskClass: "financial_action",
    });
    (db as unknown as FakeD1).tables.execution_plans[0]!.status = "awaiting_approval";
    (db as unknown as FakeD1).tables.execution_plans[0]!.approval_status = "pending";
    const result = await approveActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "requester@test.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF_APPROVAL_DENIED");
  });

  it("allows director approval by different user", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.credit_notes.create",
      actor: "requester@test.com",
      targets: [validTarget],
      permissionDecision: { ...basePermission, requiresApproval: true },
      riskClass: "financial_action",
    });
    (db as unknown as FakeD1).tables.execution_plans[0]!.status = "awaiting_approval";
    (db as unknown as FakeD1).tables.execution_plans[0]!.approval_status = "pending";
    const result = await approveActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "director@test.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.status).toBe("approved");
  });

  it("rejects action plan", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const { plan } = await createActionPlan(db, {
      companyId: "co_test",
      requestedAction: "xero.credit_notes.create",
      actor: "requester@test.com",
      targets: [validTarget],
      permissionDecision: basePermission,
      riskClass: "financial_action",
    });
    const result = await rejectActionPlan(db, {
      companyId: "co_test",
      planId: plan.id,
      actor: "director@test.com",
      reason: "Not authorised",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.status).toBe("rejected");
  });
});

describe("confirmation token", () => {
  it("generates unique tokens", () => {
    const a = generateConfirmationToken();
    const b = generateConfirmationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});
