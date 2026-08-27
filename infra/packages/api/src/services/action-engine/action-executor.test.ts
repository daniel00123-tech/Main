import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActionPlanRecord, ActionTarget } from "@infra/shared";
import { executeApprovedActionPlan } from "./action-executor";
import { claimExecution, finalizeExecution, getExecutionByPlanId } from "./execution-store";
import { runActionPreflight } from "./action-preflight";
import { buildActionDryRunReport } from "./dry-run";
import { evaluateActionPermission } from "./permission-engine";
import {
  draftInvoiceExpectedFromTarget,
  extractInvoiceIdFromMcpResult,
} from "./xero-write-verification";

vi.mock("../approvals", () => ({
  FINANCIAL_WRITES_ENABLED: false,
}));

vi.mock("../control-plane", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
  getCompanyById: vi.fn(async () => ({ id: "co_test", status: "active" })),
  getConnectorInstance: vi.fn(async () => ({
    id: "ci_xero",
    authStatus: "connected",
    capabilitiesEnabled: ["accounting.invoices.read"],
    config: {},
  })),
  listMcpEnvironments: vi.fn(async () => [
    {
      enabled: true,
      endpointUrl: "https://mcp.test",
      authSecretRef: "secret",
      serviceBindingRef: "binding",
    },
  ]),
}));

vi.mock("../usage", () => ({
  recordUsageEvent: vi.fn(async () => ({ id: "usage_1" })),
}));

vi.mock("./action-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./action-engine")>();
  return {
    ...actual,
    updateActionPlanStatus: vi.fn(async () => undefined),
  };
});

vi.mock("./xero-planner", () => ({
  revalidateXeroPlanTargets: vi.fn(async ({ targets }: { targets: ActionTarget[] }) => ({
    targets,
    fingerprint: "live-fp",
  })),
}));

vi.mock("../xero", () => ({
  getValidXeroAccessToken: vi.fn(async () => ({
    ok: true,
    accessToken: "token",
    tenantId: "tenant",
    payload: { organisationName: "Caddington Holdings Ltd" },
  })),
}));

vi.mock("./company-mcp-xero-write", () => ({
  executeXeroDraftInvoiceViaCompanyMcp: vi.fn(),
  draftInvoicePayloadFromPlan: vi.fn(() => ({
    contactId: "contact-1",
    lineItems: [{ description: "Test", quantity: 1, unitAmount: 1 }],
    reference: "REF",
  })),
}));

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
    this.tables = { action_executions: [], execution_plans: [], ...seed };
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, binds: unknown[]): Row | null {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from action_executions where plan_id = ?")) {
      return (
        this.tables.action_executions.find(
          (r) => r.plan_id === binds[0] && r.company_id === binds[1],
        ) ?? null
      );
    }
    return null;
  }

  all(sql: string, _binds: unknown[]): Row[] {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("from action_executions")) {
      return this.tables.action_executions;
    }
    return [];
  }

  run(sql: string, binds: unknown[]) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert into action_executions")) {
      this.tables.action_executions.push({
        id: binds[0],
        plan_id: binds[1],
        company_id: binds[2],
        execution_key: binds[3],
        provider: binds[4],
        requested_action: binds[5],
        status: "executing",
        verification_status: "pending",
        created_at: binds[6],
        updated_at: binds[7],
        started_at: binds[8],
        xero_resource_id: null,
        human_reference: null,
        amount: null,
        currency_code: null,
        result_json: null,
        error_code: null,
        error_message: null,
        completed_at: null,
      });
    }
    if (q.includes("update action_executions")) {
      const row = this.tables.action_executions.find((r) => r.id === binds[11]);
      if (row) {
        row.status = binds[0];
        row.verification_status = binds[1];
        row.xero_resource_id = binds[2];
        row.human_reference = binds[3];
        row.amount = binds[4];
        row.currency_code = binds[5];
        row.result_json = binds[6];
        row.error_code = binds[7];
        row.error_message = binds[8];
        row.updated_at = binds[9];
        row.completed_at = binds[10];
      }
    }
  }
}

const draftTarget: ActionTarget = {
  targetId: "contact-1",
  targetType: "contact",
  humanRef: "Test Contact",
  currentState: { contactName: "Test Contact" },
  proposedState: {
    contactId: "contact-1",
    type: "ACCREC",
    lineItems: [{ description: "INFRA Xero Write Acceptance Test", quantity: 1, unitAmount: 1 }],
    reference: "INFRA-ACCEPTANCE-TEST",
  },
  amount: 1,
  validation: "valid",
};

const approvedPlan: ActionPlanRecord = {
  id: "act_test",
  companyId: "co_test",
  connectorInstanceId: "ci_xero",
  provider: "xero",
  requestedAction: "xero.invoices.create",
  status: "approved",
  idempotencyKey: null,
  actor: "owner@test.com",
  sourceClient: "chatgpt",
  correlationId: null,
  interactionId: null,
  targets: [draftTarget],
  summary: "Draft invoice",
  financialImpact: { totalAmount: 1, currencyCode: "GBP", direction: "debit", itemCount: 1 },
  permissionDecision: null,
  riskClass: "financial_action",
  confirmationStatus: "confirmed",
  approvalStatus: "not_required",
  planFingerprint: "live-fp",
  stateVersion: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  confirmedAt: new Date().toISOString(),
  confirmedBy: "owner@test.com",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  executedAt: null,
};

describe("executeApprovedActionPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks execution when FINANCIAL_WRITES_ENABLED is false", async () => {
    const env = { DB: new FakeD1() as unknown as D1Database } as never;
    const result = await executeApprovedActionPlan(env, {
      plan: approvedPlan,
      actor: "owner@test.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("blocked");
      expect(result.code).toBe("FINANCIAL_WRITES_DISABLED");
    }
  });
});

describe("execution idempotency store", () => {
  it("claims execution atomically for a plan", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const first = await claimExecution(db, {
      planId: "act_1",
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.claimed).toBe(true);

    const second = await claimExecution(db, {
      planId: "act_1",
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
    });
    expect(second.ok).toBe(true);
    if (second.ok && !second.claimed) {
      expect(second.reason).toBe("EXECUTION_IN_PROGRESS");
    }
  });

  it("returns ALREADY_SUCCEEDED for completed executions", async () => {
    const db = new FakeD1({
      action_executions: [
        {
          id: "aex_1",
          plan_id: "act_1",
          company_id: "co_test",
          execution_key: "plan:act_1",
          provider: "xero",
          requested_action: "xero.invoices.create",
          status: "succeeded",
          verification_status: "verified",
          xero_resource_id: "inv-123",
          human_reference: "INV-001",
          amount: 1,
          currency_code: "GBP",
          result_json: JSON.stringify({ xeroInvoiceId: "inv-123" }),
          error_code: null,
          error_message: null,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    }) as unknown as D1Database;

    const claim = await claimExecution(db, {
      planId: "act_1",
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
    });
    expect(claim.ok).toBe(true);
    if (claim.ok && !claim.claimed) {
      expect(claim.reason).toBe("ALREADY_SUCCEEDED");
    }
  });

  it("does not retry uncertain outcomes", async () => {
    const db = new FakeD1({
      action_executions: [
        {
          id: "aex_1",
          plan_id: "act_1",
          company_id: "co_test",
          execution_key: "plan:act_1",
          provider: "xero",
          requested_action: "xero.invoices.create",
          status: "uncertain",
          verification_status: "uncertain",
          xero_resource_id: "inv-maybe",
          human_reference: null,
          amount: null,
          currency_code: null,
          result_json: null,
          error_code: "EXECUTION_EXCEPTION",
          error_message: "timeout",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    }) as unknown as D1Database;

    const claim = await claimExecution(db, {
      planId: "act_1",
      companyId: "co_test",
      requestedAction: "xero.invoices.create",
    });
    expect(claim.ok).toBe(true);
    if (claim.ok && !claim.claimed) expect(claim.reason).toBe("EXECUTION_UNCERTAIN");
  });

  it("finalizes execution evidence without tokens", async () => {
    const db = new FakeD1({
      action_executions: [
        {
          id: "aex_1",
          plan_id: "act_1",
          company_id: "co_test",
          execution_key: "plan:act_1",
          provider: "xero",
          requested_action: "xero.invoices.create",
          status: "executing",
          verification_status: "pending",
          xero_resource_id: null,
          human_reference: null,
          amount: null,
          currency_code: null,
          result_json: null,
          error_code: null,
          error_message: null,
          started_at: new Date().toISOString(),
          completed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    }) as unknown as D1Database;

    await finalizeExecution(db, {
      executionId: "aex_1",
      companyId: "co_test",
      status: "succeeded",
      verificationStatus: "verified",
      xeroResourceId: "inv-123",
      humanReference: "INV-001",
      amount: 1,
      currencyCode: "GBP",
      resultJson: { xeroInvoiceId: "inv-123", status: "DRAFT" },
    });

    const row = await getExecutionByPlanId(db, "co_test", "act_1");
    expect(row?.status).toBe("succeeded");
    expect(row?.xeroResourceId).toBe("inv-123");
    expect(row?.verificationStatus).toBe("verified");
    expect(JSON.stringify(row?.resultJson)).not.toContain("accessToken");
  });
});

describe("preflight checks", () => {
  it("reports execution gate blocked on dry run", async () => {
    const env = { DB: new FakeD1() as unknown as D1Database } as never;
    const result = await runActionPreflight(env, {
      plan: { ...approvedPlan, status: "awaiting_confirmation" },
      actor: "owner@test.com",
      dryRun: true,
    });
    const gate = result.checks.find((c) => c.name === "financial_writes_enabled");
    expect(gate?.ok).toBe(true);
    expect(gate?.detail).toContain("FINANCIAL_WRITES_ENABLED=false");
  });

  it("fails when OAuth write scope missing", async () => {
    const env = { DB: new FakeD1() as unknown as D1Database } as never;
    const result = await runActionPreflight(env, {
      plan: approvedPlan,
      actor: "owner@test.com",
      requireApproved: true,
    });
    expect(result.ok).toBe(false);
    const scope = result.checks.find((c) => c.name === "oauth_write_scope");
    expect(scope?.ok).toBe(false);
  });
});

describe("dry-run report", () => {
  it("derives NOT READY when writes gate is off", async () => {
    const env = { DB: new FakeD1() as unknown as D1Database } as never;
    const report = await buildActionDryRunReport(env, {
      plan: approvedPlan,
      actor: "owner@test.com",
    });
    expect(report.headline).toBe("NOT READY TO EXECUTE");
    expect(report.executionGate.blocked).toBe(true);
    expect(report.executionGate.reason).toContain("FINANCIAL_WRITES_ENABLED=false");
    expect(report.organisation).toBe("Caddington Holdings Ltd");
    expect(report.oauthWriteScope.status).toBe("missing");
  });
});

describe("permission engine — first acceptance policy", () => {
  it("requires confirmation only for directors", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "director",
      grantedScopes: ["accounting.invoices"],
      requiredScopes: ["accounting.invoices"],
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires separate approval for money movement from office staff", () => {
    const decision = evaluateActionPermission({
      action: "xero.payments.allocate",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "office_staff",
      actorType: "user",
      grantedScopes: ["accounting.invoices"],
      requiredScopes: ["accounting.invoices"],
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.requiresApproval).toBe(true);
  });

  it("requires confirmation only for accounting commitment from office staff", () => {
    const decision = evaluateActionPermission({
      action: "xero.credit_notes.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "office_staff",
      actorType: "user",
      grantedScopes: ["accounting.invoices"],
      requiredScopes: ["accounting.invoices"],
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires confirmation only for MCP service identity on invoice approve", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.approve",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorType: "service",
      grantedScopes: ["accounting.invoices"],
      requiredScopes: ["accounting.invoices"],
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reasonCode).toBe("confirmation_required");
  });

  it("requires confirmation only for draft invoice create from office staff", () => {
    const decision = evaluateActionPermission({
      action: "xero.invoices.create",
      riskClass: "financial_action",
      companyStatus: "active",
      connectorConnected: true,
      connectorAuthStatus: "connected",
      actorRole: "office_staff",
      grantedScopes: ["accounting.invoices"],
      requiredScopes: ["accounting.invoices"],
      flags: { financialWritesEnabled: true, writesEnabled: true },
    });
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reasonCode).toBe("confirmation_required");
  });
});

describe("post-write verification helpers", () => {
  it("builds expected draft invoice from plan target", () => {
    const expected = draftInvoiceExpectedFromTarget(draftTarget);
    expect(expected?.type).toBe("ACCREC");
    expect(expected?.status).toBe("DRAFT");
    expect(expected?.total).toBe(1);
    expect(expected?.reference).toBe("INFRA-ACCEPTANCE-TEST");
  });

  it("extracts invoice id from MCP result", () => {
    const id = extractInvoiceIdFromMcpResult({ invoice: { InvoiceID: "abc-123" } });
    expect(id).toBe("abc-123");
  });
});
