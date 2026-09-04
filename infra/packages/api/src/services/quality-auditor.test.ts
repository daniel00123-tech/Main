import { describe, expect, it } from "vitest";
import {
  detectQualitySignals,
  processQualityAudit,
  qualityFingerprint,
  qualityScore,
  shouldSampleAudit,
} from "./quality-auditor";

describe("quality auditor", () => {
  it("does not treat expected RBAC denials as operational quality failures", () => {
    const signals = detectQualitySignals({
      interactionId: "int_denied",
      companyId: "co_el",
      usage: [
        {
          toolName: "xero_sales_summary",
          action: "xero.sales.summary",
          success: 0,
          settlementStatus: "denied",
          durationMs: 80,
          customerChargeCents: 0,
          metadata: { denied: true, result: "permission_denied", accessOutcome: "permission_denied" },
        },
      ],
      gateway: [{ errorCode: "forbidden", errorMessage: "Permission denied", status: "denied" }],
    });
    const categories = signals.map((s) => s.category);
    expect(categories).not.toContain("tool_call_failed");
    expect(categories).not.toContain("auth_permission_failure");
  });

  it("detects evidence-backed tool failure, permission, timeout, and high cost", () => {
    const signals = detectQualitySignals({
      interactionId: "int_a",
      companyId: "co_1",
      usage: [
        { toolName: "search_company_knowledge", success: false, durationMs: 20000, customerChargeCents: 80 },
      ],
      gateway: [{ errorCode: "forbidden", errorMessage: "Permission denied", status: "denied" }],
    });
    const categories = signals.map((s) => s.category);
    expect(categories).toContain("auth_permission_failure");
    expect(categories).toContain("high_latency");
    expect(categories).toContain("high_cost");
    expect(categories).not.toContain("unsupported_ungrounded");
  });

  it("groups repeated issues by fingerprint and increments count", async () => {
    const issues: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM quality_issues WHERE fingerprint")) {
                  return issues.find((row) => row.fingerprint === values[0]) ?? null;
                }
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO quality_issues")) {
                  issues.push({
                    id: values[0],
                    fingerprint: values[1],
                    occurrence_count: 1,
                  });
                }
                if (sql.includes("UPDATE quality_issues")) {
                  const row = issues.find((item) => item.id === values[values.length - 1]);
                  if (row) row.occurrence_count = values[6];
                }
                if (sql.includes("INSERT INTO quality_issue_events")) {
                  events.push({ id: values[0], quality_issue_id: values[1] });
                }
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const input = {
      interactionId: "int_1",
      companyId: "co_1",
      usage: [{ toolName: "search", success: false }],
      gateway: [{ errorCode: "upstream", errorMessage: "tool failed", status: "error" }],
    };
    const first = await processQualityAudit(db, input);
    const second = await processQualityAudit(db, { ...input, interactionId: "int_2" });
    expect(first.issueIds).toHaveLength(1);
    expect(second.issueIds).toEqual(first.issueIds);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(events).toHaveLength(2);
    expect(qualityFingerprint({ companyId: "co_1", category: "tool_call_failed", toolName: "search" })).toContain(
      "tool_call_failed",
    );
  });

  it("samples audits deterministically", () => {
    expect(shouldSampleAudit("int_always", 1)).toBe(true);
    expect(shouldSampleAudit("int_never", 0)).toBe(false);
    const a = shouldSampleAudit("int_sample_key", 0.5);
    const b = shouldSampleAudit("int_sample_key", 0.5);
    expect(a).toBe(b);
  });

  it("scores from evidence, not model opinion", () => {
    expect(qualityScore([])).toBe(100);
    expect(qualityScore([{ category: "tool_call_failed", severity: "high", confidence: 0.9, evidence: {}, suggestedInvestigation: "" }])).toBe(75);
  });
});
