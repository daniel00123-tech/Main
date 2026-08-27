import { describe, expect, it } from "vitest";
import {
  FINANCIAL_WRITES_ENABLED,
  evaluateApprovalRequirement,
} from "./approvals";
import { prepareXeroMcpExecution } from "./xero-tools";
import {
  createExecutionPlan,
  findExecutionPlanByIdempotency,
} from "./execution-plan";
import { CONNECTOR_ERROR_CODES } from "@infra/shared";

describe("Xero full-capability gates", () => {
  it("allows financial writes when operator gate is enabled", () => {
    expect(FINANCIAL_WRITES_ENABLED).toBe(true);
    const decision = evaluateApprovalRequirement({
      riskClass: "financial_action",
      action: "xero.invoices.create",
      companyStatus: "active",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.writesSupported).toBe(true);
    expect(decision.writesEnabled).toBe(true);
  });

  it("requires scope upgrade before write tools when OAuth lacks write scopes", async () => {
    class FakeD1 {
      prepare() {
        return {
          bind: () => ({
            first: async () => ({
              id: "ci_xero",
              company_id: "co_a",
              connector_definition_id: "conn_xero",
              auth_status: "connected",
              external_account_id: "tenant-1",
              capabilities_enabled_json: JSON.stringify([
                "offline_access",
                "accounting.invoices.read",
              ]),
              config_json: "{}",
            }),
            all: async () => ({
              results: [
                {
                  id: "ci_xero",
                  company_id: "co_a",
                  connector_definition_id: "conn_xero",
                  auth_status: "connected",
                  external_account_id: "tenant-1",
                  capabilities_enabled_json: JSON.stringify([
                    "offline_access",
                    "accounting.invoices.read",
                  ]),
                  config_json: "{}",
                },
              ],
            }),
          }),
        };
      }
    }
    const env = { DB: new FakeD1() } as never;
    const result = await prepareXeroMcpExecution({
      env,
      companyId: "co_a",
      toolName: "xero_create_draft_invoice",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.code).toBe(CONNECTOR_ERROR_CODES.OAUTH_SCOPE_UPGRADE_REQUIRED);
    }
  });
});

describe("execution plan idempotency", () => {
  it("returns existing plan for duplicate idempotency key", async () => {
    const rows: Record<string, unknown>[] = [];
    class FakeD1 {
      prepare(sql: string) {
        const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
        const stmt = {
          binds: [] as unknown[],
          bind(...args: unknown[]) {
            this.binds = args;
            return this;
          },
          async first() {
            if (q.includes("from execution_plans")) {
              return (
                rows.find(
                  (r) =>
                    r.company_id === stmt.binds[0] &&
                    r.idempotency_key === stmt.binds[1],
                ) ?? null
              );
            }
            return null;
          },
          async run() {
            if (q.includes("insert into execution_plans")) {
              rows.push({
                id: stmt.binds[0],
                company_id: stmt.binds[1],
                connector_instance_id: stmt.binds[2],
                provider: stmt.binds[3],
                requested_action: stmt.binds[4],
                idempotency_key: stmt.binds[5],
                payload_json: stmt.binds[9],
                status: "draft",
                actor: stmt.binds[6],
                required_approval: stmt.binds[11],
                approval_status: stmt.binds[12],
                summary: stmt.binds[13],
                created_at: stmt.binds[14],
                updated_at: stmt.binds[15],
              });
            }
            if (q.includes("insert into audit_events")) {
              return { success: true };
            }
            return { success: true };
          },
        };
        return stmt;
      }
    }
    const db = new FakeD1() as unknown as D1Database;
    const input = {
      companyId: "co_a",
      requestedAction: "xero.credit_notes.create",
      idempotencyKey: "idem-1",
      actor: "user@example.com",
      items: [
        {
          itemId: "item-1",
          targetType: "invoice",
          targetRef: "inv-1",
          proposedChange: { amount: 100 },
        },
      ],
      requiredApproval: true,
    };
    const first = await createExecutionPlan(db, input);
    const second = await createExecutionPlan(db, input);
    expect(second.id).toBe(first.id);
    const found = await findExecutionPlanByIdempotency(db, "co_a", "idem-1");
    expect(found?.id).toBe(first.id);
  });
});
