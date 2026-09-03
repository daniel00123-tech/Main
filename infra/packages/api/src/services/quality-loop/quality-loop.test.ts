import { describe, expect, it, vi } from "vitest";
import { assertTenantIsolation, evaluateWhatsAppConversation } from "./evaluator";
import { groupQualityPatterns } from "./patterns";
import { isHighRiskProposal, proposeImprovements } from "./proposals";
import { replayProposal } from "./replay";
import {
  baselineFromRunMetrics,
  canaryShouldRollback,
  decideCanaryClose,
  isSafeAutoApplyPatch,
  resolveApplyBase,
  validateBeforePromote,
} from "./apply";
import { londonParts, resolvePhase, shouldRunCadence } from "./cadence";
import { qualityReviewEmail, qualityReviewSubject } from "./email";
import { buildThreadFromFixture } from "./runner";
import { createReviewToken, ensureQualityLoopConfig, resolveReviewToken, insertHistory, insertQualityRun, insertProposals, updateProposalStatus } from "./store";
import { DEFAULT_QUALITY_RUNTIME } from "./runtime-config";
import type { QualityProposalDraft } from "./types";

function memoryDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    quality_loop_config: [],
    quality_loop_runs: [],
    quality_conversation_scores: [],
    quality_patterns: [],
    quality_proposals: [],
    quality_review_tokens: [],
    quality_improvement_history: [],
    quality_runtime_config: [],
    users: [{ email: "daniel.dwyer123@gmail.com", is_platform_admin: 1, status: "active" }],
    interactions: [],
    usage_records: [],
    audit_events: [],
    platform_ops_heartbeats: [],
  };

  function runSql(sql: string, values: unknown[]) {
    if (sql.includes("FROM quality_loop_config")) {
      return tables.quality_loop_config[0] ?? null;
    }
    if (sql.includes("INSERT INTO quality_loop_config")) {
      tables.quality_loop_config.push({
        id: values[0],
        activated_at: values[1],
        phase: "daily",
        updated_at: values[2],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE quality_loop_config")) {
      const row = tables.quality_loop_config[0];
      if (row) {
        if (values[0]) row.phase = values[0];
        if (values[1]) row.last_run_at = values[1];
        if (values[2]) row.last_period_from = values[2];
        if (values[3]) row.last_period_to = values[3];
        if (values[4]) row.last_cadence = values[4];
        if (values[5]) row.baseline_completed_at = values[5];
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO quality_loop_runs")) {
      tables.quality_loop_runs.push({
        id: values[0],
        kind: values[1],
        phase: values[2],
        period_from: values[3],
        period_to: values[4],
        status: "running",
        metrics_json: "{}",
        created_at: values[5],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE quality_loop_runs")) {
      const row = tables.quality_loop_runs.find((item) => item.id === values[5]);
      if (row) {
        row.status = values[0];
        row.metrics_json = values[1];
        row.email_sent = values[2];
        row.email_error = values[3];
        row.completed_at = values[4];
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO quality_proposals")) {
      tables.quality_proposals.push({
        id: values[0],
        run_id: values[1],
        company_id: values[2],
        title: values[3],
        summary: values[4],
        kind: values[5],
        risk: values[6],
        auto_applyable: values[7],
        engineering_required: values[8],
        patch_json: values[9],
        evidence_json: values[10],
        fingerprint: values[11],
        status: values[12],
        pretest_json: values[13],
        created_at: values[14],
        updated_at: values[15],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE quality_proposals SET status")) {
      const row = tables.quality_proposals.find((item) => item.id === values[2]);
      if (row) {
        row.status = values[0];
        row.updated_at = values[1];
      }
      return { success: true };
    }
    if (sql.includes("FROM quality_proposals WHERE id")) {
      return tables.quality_proposals.find((item) => item.id === values[0]) ?? null;
    }
    if (sql.includes("FROM quality_proposals WHERE run_id")) {
      return tables.quality_proposals.filter((item) => item.run_id === values[0]);
    }
    if (sql.includes("FROM quality_proposals") && sql.includes("rejected")) {
      return tables.quality_proposals.filter((item) =>
        ["rejected", "rejected_pretest", "failed_validation", "rolled_back"].includes(String(item.status)),
      );
    }
    if (sql.includes("INSERT INTO quality_review_tokens")) {
      tables.quality_review_tokens.push({
        id: values[0],
        run_id: values[1],
        token_hash: values[2],
        expires_at: values[3],
        created_at: values[4],
      });
      return { success: true };
    }
    if (sql.includes("FROM quality_review_tokens WHERE token_hash")) {
      return tables.quality_review_tokens.find((item) => item.token_hash === values[0]) ?? null;
    }
    if (sql.includes("INSERT INTO quality_improvement_history")) {
      tables.quality_improvement_history.push({
        id: values[0],
        proposal_id: values[1],
        action: values[3],
        actor: values[4],
        created_at: values[7],
      });
      return { success: true };
    }
    if (sql.includes("INSERT INTO quality_conversation_scores")) {
      tables.quality_conversation_scores.push({ id: values[0], run_id: values[1], company_id: values[2] });
      return { success: true };
    }
    if (sql.includes("INSERT INTO quality_patterns")) {
      tables.quality_patterns.push({ id: values[0], fingerprint: values[9] });
      return { success: true };
    }
    if (sql.includes("INSERT INTO quality_runtime_config")) {
      tables.quality_runtime_config.push({
        id: values[0],
        version: values[1],
        status: values[2],
        config_json: values[3],
        proposal_id: values[4],
        created_at: values[7],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE quality_runtime_config") && sql.includes("Superseded by a newer canary")) {
      for (const row of tables.quality_runtime_config) {
        if (row.status === "canary") {
          row.status = "rolled_back";
          row.rollback_reason = "Superseded by a newer canary";
        }
      }
      return { success: true };
    }
    if (sql.includes("MAX(version)")) {
      const max = tables.quality_runtime_config.reduce((n, row) => Math.max(n, Number(row.version ?? 0)), 0);
      return { version: max || null };
    }
    if (sql.includes("FROM quality_runtime_config WHERE status = 'canary'")) {
      return [...tables.quality_runtime_config].reverse().find((row) => row.status === "canary") ?? null;
    }
    if (sql.includes("FROM quality_runtime_config WHERE status = 'promoted'")) {
      return [...tables.quality_runtime_config].reverse().find((row) => row.status === "promoted") ?? null;
    }
    if (sql.includes("FROM users WHERE is_platform_admin")) {
      return tables.users;
    }
    if (sql.includes("FROM interactions")) {
      return tables.interactions;
    }
    if (sql.includes("FROM usage_records")) {
      return tables.usage_records.filter((row) => !values[0] || row.interaction_id === values[0]);
    }
    if (sql.includes("INSERT INTO audit_events") || sql.includes("INSERT INTO platform_ops_heartbeats") || sql.includes("INSERT INTO usage_records")) {
      return { success: true };
    }
    return null;
  }

  const db = {
    tables,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              const result = runSql(sql, values);
              return Array.isArray(result) ? result[0] ?? null : result;
            },
            async all() {
              const result = runSql(sql, values);
              return { results: Array.isArray(result) ? result : result ? [result] : [] };
            },
            async run() {
              runSql(sql, values);
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { tables: typeof tables };
}

const goodThread = () =>
  buildThreadFromFixture({
    companyId: "co_caddington",
    conversationKey: "int_good",
    interactionId: "int_good",
    userMessages: ["Find Coal Search"],
    assistantMessages: ["Coal Search is a £49.92 payment confirmation. https://contoso.sharepoint.com/docs/CoalSearch.pdf"],
    sourceUrls: ["https://contoso.sharepoint.com/docs/CoalSearch.pdf"],
    toolNames: ["search_company_knowledge"],
    finalSent: true,
    totalMs: 1800,
  });

describe("quality evaluator signals", () => {
  it("does not treat a delivered reply with no stored body as silence", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_bodyless",
        userMessages: ["Find Coal Search"],
        assistantMessages: [],
        finalSent: true,
        totalMs: 1400,
      }),
    );
    expect(evaluation.failed).toBe(false);
    expect(evaluation.flags.some((flag) => flag.category === "silence")).toBe(false);
    expect(evaluation.overallQualityScore).toBeGreaterThanOrEqual(90);
  });

  it("does not flag a successful conversation", () => {
    const evaluation = evaluateWhatsAppConversation(goodThread());
    expect(evaluation.failed).toBe(false);
    expect(evaluation.overallQualityScore).toBeGreaterThanOrEqual(85);
    expect(evaluation.flags.every((flag) => flag.polarity === "positive" || flag.severity === "low")).toBe(true);
  });

  it("flags silence", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_silent",
        userMessages: ["Find the invoice"],
        assistantMessages: [],
        finalSent: false,
        acknowledgementSent: false,
        totalMs: 35_000,
        qualitySignals: ["whatsapp_silent"],
      }),
    );
    expect(evaluation.failed).toBe(true);
    expect(evaluation.flags.some((flag) => flag.category === "silence")).toBe(true);
  });

  it("flags rephrase without treating missing thanks as failure", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_rephrase",
        userMessages: ["Find Coal Search please", "Can you find Coal Search for me"],
        assistantMessages: ["I found something."],
        qualitySignals: ["repeated_user_rephrase"],
        totalMs: 4000,
      }),
    );
    expect(evaluation.flags.some((flag) => flag.category === "rephrase")).toBe(true);
    expect(evaluation.flags.some((flag) => flag.category === "thanks")).toBe(false);
  });

  it("flags raw dump", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_raw",
        userMessages: ["Open Coal Search"],
        assistantMessages: ['{"id":"doc_1","bytes":"JVBERi0xLjQK"}'],
        rawLeak: true,
        qualitySignals: ["whatsapp_raw_output"],
      }),
    );
    expect(evaluation.flags.some((flag) => flag.category === "raw_dump")).toBe(true);
    expect(evaluation.failed).toBe(true);
  });

  it("flags context loss", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_ctx",
        userMessages: ["Summarise it"],
        assistantMessages: ["Which document?"],
        followUp: true,
        contextLost: true,
        qualitySignals: ["whatsapp_context_lost"],
      }),
    );
    expect(evaluation.flags.some((flag) => flag.category === "context_loss")).toBe(true);
  });

  it("flags excessive latency", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_slow",
        userMessages: ["Sales this month?"],
        assistantMessages: ["Sales were £12k."],
        totalMs: 62_000,
      }),
    );
    expect(evaluation.flags.some((flag) => flag.category === "excessive_latency")).toBe(true);
  });

  it("does not treat a correct permission denial as model failure", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_perm",
        userMessages: ["Show overdue invoices"],
        assistantMessages: ["You don’t currently have permission to access Xero financial information."],
        permissionDenied: true,
        permissionDenialCorrect: true,
        finalSent: true,
        totalMs: 900,
      }),
    );
    expect(evaluation.failed).toBe(false);
    expect(evaluation.permissionDenialCorrect).toBe(true);
    expect(evaluation.flags.some((flag) => flag.category === "permission_denial_correct")).toBe(true);
    expect(evaluation.flags.some((flag) => flag.category === "permission_ux" && flag.polarity === "negative")).toBe(false);
  });
});

describe("patterns, proposals, replay", () => {
  it("groups patterns per company and keeps platform aggregates anonymised", () => {
    const a = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "a",
        rawLeak: true,
        assistantMessages: ["{}"],
        qualitySignals: ["whatsapp_raw_output"],
      }),
    );
    const b = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_other",
        conversationKey: "b",
        rawLeak: true,
        assistantMessages: ["{}"],
        qualitySignals: ["whatsapp_raw_output"],
      }),
    );
    const patterns = groupQualityPatterns([a, b]);
    expect(patterns.some((pattern) => pattern.companyId === "co_caddington")).toBe(true);
    expect(patterns.some((pattern) => pattern.companyId === "co_other")).toBe(true);
    const platform = patterns.filter((pattern) => pattern.platformAggregate);
    expect(platform.every((pattern) => pattern.evidence.length === 0 && pattern.companyId == null)).toBe(true);
  });

  it("proposes a config action for raw dumps and blocks high-risk auto-apply", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "raw",
        rawLeak: true,
        assistantMessages: ["{}"],
        qualitySignals: ["whatsapp_raw_output"],
      }),
    );
    const drafts = proposeImprovements(groupQualityPatterns([evaluation]));
    expect(drafts.some((draft) => draft.kind === "response_rule" && draft.autoApplyable)).toBe(true);
    expect(
      isHighRiskProposal({
        kind: "engineering_change",
        title: "Weaken OAuth isolation",
        summary: "Change tenant auth",
      }),
    ).toBe(true);
    expect(isSafeAutoApplyPatch([{ path: "planner.oauthScopes", value: "*" }])).toBe(false);
    expect(isSafeAutoApplyPatch([{ path: "responseRules.stripRawJson", value: true }])).toBe(true);
  });

  it("accepts a replay that improves raw dumps and rejects a worsening proposal", () => {
    const failed = buildThreadFromFixture({
      companyId: "co_caddington",
      conversationKey: "raw",
      userMessages: ["Open it"],
      assistantMessages: ['{"dump":true}'],
      rawLeak: true,
      askedForSource: false,
    });
    const good = proposeImprovements(
      groupQualityPatterns([evaluateWhatsAppConversation(failed)]),
    ).find((draft) => draft.kind === "response_rule")!;
    const improved = replayProposal({ proposal: good, failedThreads: [failed] });
    expect(improved.accepted).toBe(true);
    expect(improved.afterScore).toBeGreaterThanOrEqual(improved.beforeScore);

    const bad: QualityProposalDraft = {
      ...good,
      engineeringRequired: false,
      autoApplyable: true,
      patch: { patches: [{ path: "planner.skipToolsOnCheapIntents", value: false }] },
    };
    const rejected = replayProposal({
      proposal: bad,
      failedThreads: [failed],
      similarThreads: [
        buildThreadFromFixture({
          companyId: "co_caddington",
          conversationKey: "good2",
          userMessages: ["Hi"],
          assistantMessages: ["Hello"],
          qualitySignals: ["whatsapp_unnecessary_tool"],
          toolNames: ["search_company_knowledge"],
        }),
      ],
    });
    expect(rejected.accepted).toBe(false);
  });
});

describe("cadence, email, isolation", () => {
  it("transitions daily to weekly after 60 days and only fires Friday in weekly phase", () => {
    const activated = "2026-06-01T07:00:00.000Z";
    expect(resolvePhase(activated, "2026-07-15T08:00:00.000Z")).toBe("daily");
    expect(resolvePhase(activated, "2026-08-15T08:00:00.000Z")).toBe("weekly");

    const friday = findLondon(8, 0, 5);
    const thursday = findLondon(8, 0, 4);
    const weeklyState = { activatedAt: activated, phase: "weekly" as const };
    expect(shouldRunCadence(weeklyState, friday).run).toBe(true);
    expect(shouldRunCadence(weeklyState, friday).kind).toBe("weekly");
    expect(shouldRunCadence(weeklyState, thursday).run).toBe(false);

    const daily = findLondon(8, 0, 1);
    expect(shouldRunCadence({ activatedAt: "2026-08-20T00:00:00.000Z", phase: "daily" }, daily).kind).toBe("daily");
    expect(shouldRunCadence({ activatedAt: "2026-08-20T00:00:00.000Z", phase: "daily" }, daily).run).toBe(true);
  });

  it("builds daily and weekly review emails without full bodies", () => {
    const daily = qualityReviewEmail({
      date: "2026-08-30",
      kind: "daily",
      cadence: "Daily 08:00 Europe/London",
      periodFrom: "2026-08-29T00:00:00.000Z",
      periodTo: "2026-08-30T00:00:00.000Z",
      metrics: {
        messagesAnalysed: 12,
        conversationsAnalysed: 6,
        qualityAverage: 81,
        failedRate: 0.16,
        rephraseRate: 0.08,
        ackLatencyMs: 900,
        finalLatencyMs: 4200,
        openProposals: 2,
        approvedProposals: 0,
        deployedProposals: 0,
        rolledBackProposals: 0,
        evaluatorCostCents: 0,
      },
      failures: [{ companyLabel: "Caddington", category: "raw_dump", snippet: "Raw dump", interactionId: "int_1" }],
      patterns: [{ title: "Raw dumps", count: 2, rootCause: "Compression" }],
      proposals: [{ title: "Tighten dump rules", risk: "low", autoApplyable: true, engineeringRequired: false }],
      reviewUrl: "https://app.infrastack.app/quality/improvements?review=tok",
    });
    expect(daily.subject).toBe(qualityReviewSubject("2026-08-30"));
    expect(daily.bodyText).toContain("Review & approve");
    expect(daily.bodyHtml).toContain("Review &amp; Approve Improvements");
    expect(daily.bodyHtml).not.toContain("JVBERi0");
    const weekly = qualityReviewEmail({
      date: "2026-09-04",
      kind: "weekly",
      cadence: "Weekly Friday 08:00 Europe/London",
      periodFrom: "2026-08-28T00:00:00.000Z",
      periodTo: "2026-09-04T00:00:00.000Z",
      metrics: {
        messagesAnalysed: 40,
        conversationsAnalysed: 20,
        qualityAverage: 83,
        failedRate: 0.1,
        rephraseRate: 0.05,
        ackLatencyMs: 800,
        finalLatencyMs: 3900,
        openProposals: 1,
        approvedProposals: 1,
        deployedProposals: 0,
        rolledBackProposals: 0,
        evaluatorCostCents: 0,
      },
      failures: [{ companyLabel: "Caddington", category: "silence", snippet: "No final reply", interactionId: "int_2" }],
      patterns: [{ title: "Silent turns", count: 3, rootCause: "Watchdog" }],
      proposals: [{ title: "ENGINEERING CHANGE REQUIRED — voice", risk: "high", autoApplyable: false, engineeringRequired: true }],
      reviewUrl: "https://app.infrastack.app/quality/improvements?review=weekly",
    });
    expect(qualityReviewSubject("2026-09-04")).toContain("2026-09-04");
    expect(weekly.bodyHtml).toContain("app.infrastack.app/quality/improvements");
    expect(weekly.bodyText).toContain("ENGINEERING CHANGE REQUIRED");
  });

  it("never mixes tenants in one evaluation context", () => {
    const mixed = [
      evaluateWhatsAppConversation(goodThread()),
      evaluateWhatsAppConversation(
        buildThreadFromFixture({
          companyId: "co_other",
          conversationKey: "other",
          userMessages: ["Hi"],
          assistantMessages: ["Hello"],
        }),
      ),
    ];
    mixed[1]!.evidence.companyId = "co_caddington";
    const check = assertTenantIsolation(mixed);
    expect(check.ok).toBe(false);
    const clean = assertTenantIsolation([
      evaluateWhatsAppConversation(goodThread()),
      evaluateWhatsAppConversation(
        buildThreadFromFixture({
          companyId: "co_other",
          conversationKey: "other",
          userMessages: ["Hi"],
          assistantMessages: ["Hello"],
        }),
      ),
    ]);
    expect(clean.ok).toBe(true);
  });
});

describe("approval, tokens, canary, rollback", () => {
  it("creates a deep-link token that does not execute changes and expires", async () => {
    const db = memoryDb();
    await ensureQualityLoopConfig(db, "2026-08-30T07:00:00.000Z");
    const run = await insertQualityRun(db, {
      kind: "daily",
      phase: "daily",
      periodFrom: "2026-08-29T00:00:00.000Z",
      periodTo: "2026-08-30T00:00:00.000Z",
    });
    const token = await createReviewToken(db, run.id);
    const ok = await resolveReviewToken(db, token, "2026-08-30T08:00:00.000Z");
    expect(ok && "runId" in ok && ok.runId).toBe(run.id);
    const expired = await resolveReviewToken(db, token, "2099-01-01T00:00:00.000Z");
    expect(expired && "expired" in expired).toBe(true);
    const unknown = await resolveReviewToken(db, "not-a-token");
    expect(unknown).toBeNull();
  });

  it("does not reset an already-canary proposal back to approved", async () => {
    const { decideProposal } = await import("./runner");
    const db = memoryDb();
    const run = await insertQualityRun(db, {
      kind: "daily",
      phase: "daily",
      periodFrom: "2026-08-29T00:00:00.000Z",
      periodTo: "2026-08-30T00:00:00.000Z",
    });
    const ids = await insertProposals(
      db,
      run.id,
      [
        {
          companyId: "co_caddington",
          patternFingerprint: "co_caddington:rephrase",
          title: "Completeness",
          summary: "First answer",
          kind: "prompt_tweak",
          risk: "low",
          autoApplyable: true,
          engineeringRequired: false,
          patch: { patches: [{ path: "prompts.systemNote", value: "Answer first." }] },
          evidence: { occurrenceCount: 1 },
          fingerprint: "prop:complete",
        },
      ],
      { "prop:complete": { accepted: true } },
    );
    await updateProposalStatus(db, ids[0]!, "canary");
    const env = { DB: db } as never;
    const result = await decideProposal(env, {
      proposalId: ids[0]!,
      decision: "approve",
      actor: "system:quality-apply",
      runId: run.id,
    });
    expect(result.status).toBe("canary");
    const row = (db as unknown as { tables: { quality_proposals: Array<{ status: string }> } }).tables.quality_proposals[0];
    expect(row?.status).toBe("canary");
  });

  it("records approval and rejection without applying high-risk changes", async () => {
    const db = memoryDb();
    const run = await insertQualityRun(db, {
      kind: "daily",
      phase: "daily",
      periodFrom: "2026-08-29T00:00:00.000Z",
      periodTo: "2026-08-30T00:00:00.000Z",
    });
    const drafts: QualityProposalDraft[] = [
      {
        companyId: "co_caddington",
        patternFingerprint: "co_caddington:raw_dump",
        title: "Tighten dumps",
        summary: "Strip JSON",
        kind: "response_rule",
        risk: "low",
        autoApplyable: true,
        engineeringRequired: false,
        patch: { patches: [{ path: "responseRules.stripRawJson", value: true }] },
        evidence: { occurrenceCount: 2 },
        fingerprint: "prop:raw",
      },
    ];
    const ids = await insertProposals(db, run.id, drafts, {
      "prop:raw": { accepted: true, beforeScore: 50, afterScore: 80 },
    });
    await updateProposalStatus(db, ids[0]!, "approved");
    await insertHistory(db, { proposalId: ids[0]!, action: "approved", actor: "daniel.dwyer123@gmail.com" });
    await updateProposalStatus(db, ids[0]!, "rejected");
    await insertHistory(db, { proposalId: ids[0]!, action: "rejected", actor: "daniel.dwyer123@gmail.com" });
    const row = (db as unknown as { tables: { quality_proposals: Array<{ status: string }> } }).tables.quality_proposals[0];
    expect(row?.status).toBe("rejected");
  });

  it("rejects unauthorised approvers at the route layer", async () => {
    const { requirePlatformAdmin } = await import("../../auth/middleware");
    const denied: string[] = [];
    const mw = requirePlatformAdmin;
    const c = {
      get: () => ({ isPlatformAdmin: false, email: "staff@example.com" }),
      json: (body: unknown, status: number) => {
        denied.push(`${status}:${(body as { error?: string }).error}`);
        return body;
      },
    };
    await mw(c as never, async () => undefined);
    expect(denied[0]).toContain("403");
  });

  it("fails validation when a proposal would disable write blocking", async () => {
    const result = await validateBeforePromote({
      ...DEFAULT_QUALITY_RUNTIME,
      planner: { ...DEFAULT_QUALITY_RUNTIME.planner, blockWriteIntents: false },
    });
    expect(result.ok).toBe(false);
  });

  it("starts canary for Caddington/10% and rolls back if quality worsens", () => {
    expect(
      canaryShouldRollback({
        baselineQuality: 88,
        canaryQuality: 70,
        baselineErrorRate: 0.05,
        canaryErrorRate: 0.2,
        baselineLatencyMs: 4000,
        canaryLatencyMs: 9000,
        permissionSafetyWorsened: false,
      }).rollback,
    ).toBe(true);
    expect(
      canaryShouldRollback({
        baselineQuality: 80,
        canaryQuality: 84,
        baselineErrorRate: 0.1,
        canaryErrorRate: 0.08,
        baselineLatencyMs: 5000,
        canaryLatencyMs: 4800,
        permissionSafetyWorsened: false,
      }).rollback,
    ).toBe(false);
    expect(
      canaryShouldRollback({
        baselineQuality: 80,
        canaryQuality: 90,
        baselineErrorRate: 0.1,
        canaryErrorRate: 0.05,
        baselineLatencyMs: 5000,
        canaryLatencyMs: 4000,
        permissionSafetyWorsened: true,
      }).reason,
    ).toMatch(/Permission-safety/);
  });

  it("does not roll back a canary from pre-canary daily scores or a hardcoded 15% baseline", () => {
    const v6Incident = decideCanaryClose({
      canaryCreatedAt: "2026-09-03T07:21:45.098Z",
      nowMs: Date.parse("2026-09-03T07:30:28.598Z"),
      postCanaryScores: 0,
      canaryQuality: 96,
      canaryErrorRate: 1,
      baselineQuality: 80,
      baselineErrorRate: 0.15,
    });
    expect(v6Incident).toEqual({
      action: "hold",
      reason: "Canary still soaking; pre-canary scores are not evidence",
    });

    const soakedButNoLiveTraffic = decideCanaryClose({
      canaryCreatedAt: "2026-09-03T07:21:45.098Z",
      nowMs: Date.parse("2026-09-03T10:00:00.000Z"),
      postCanaryScores: 0,
      canaryQuality: 96,
      canaryErrorRate: 1,
      baselineQuality: 96,
      baselineErrorRate: 1,
    });
    expect(soakedButNoLiveTraffic.action).toBe("hold");
    expect(soakedButNoLiveTraffic.reason).toMatch(/post-canary/);

    const sameRateAsPreviousRun = decideCanaryClose({
      canaryCreatedAt: "2026-09-03T07:21:45.098Z",
      nowMs: Date.parse("2026-09-04T08:00:00.000Z"),
      postCanaryScores: 12,
      canaryQuality: 96,
      canaryErrorRate: 1,
      baselineQuality: 96,
      baselineErrorRate: 1,
    });
    expect(sameRateAsPreviousRun.action).toBe("promote");

    const genuinelyWorse = decideCanaryClose({
      canaryCreatedAt: "2026-09-03T07:21:45.098Z",
      nowMs: Date.parse("2026-09-04T08:00:00.000Z"),
      postCanaryScores: 12,
      canaryQuality: 96,
      canaryErrorRate: 0.4,
      baselineQuality: 96,
      baselineErrorRate: 0.18,
    });
    expect(genuinelyWorse).toEqual({
      action: "rollback",
      reason: "Error rate worsened on canary",
    });
  });

  it("uses the last completed quality-run metrics as the canary baseline", () => {
    expect(
      baselineFromRunMetrics({
        qualityAverage: 96,
        failedRate: 1,
        finalLatencyMs: 51_838,
      }),
    ).toEqual({
      baselineQuality: 96,
      baselineErrorRate: 1,
      baselineLatencyMs: 51_838,
    });
    expect(baselineFromRunMetrics(null)).toEqual({
      baselineQuality: 80,
      baselineErrorRate: 0.15,
      baselineLatencyMs: 20_000,
    });
  });
});

function findLondon(hour: number, minute: number, weekday: number): Date {
  const start = Date.UTC(2026, 7, 1, 0, 0, 0);
  for (let i = 0; i < 21 * 24 * 4; i += 1) {
    const date = new Date(start + i * 15 * 60 * 1000);
    const parts = londonParts(date);
    if (parts.hour === hour && parts.minute === minute && parts.weekday === weekday) return date;
  }
  throw new Error("No matching London slot");
}

describe("control centre classification and source URL policy", () => {
  it("classifies the three persisted email proposals and engineering leftovers", async () => {
    const { classifyApplyClass, canAutoApply } = await import("./classify");
    expect(
      classifyApplyClass({
        kind: "prompt_tweak",
        risk: "low",
        autoApplyable: true,
        engineeringRequired: false,
        patchPaths: ["prompts.systemNote"],
      }),
    ).toBe("AUTO_APPLY_SAFE");
    expect(
      classifyApplyClass({
        kind: "planner_config",
        risk: "medium",
        autoApplyable: true,
        engineeringRequired: false,
        patchPaths: ["planner.requireSourceUrlWhenAsked"],
      }),
    ).toBe("AUTO_APPLY_SAFE");
    expect(
      classifyApplyClass({
        kind: "threshold",
        risk: "medium",
        autoApplyable: true,
        engineeringRequired: false,
        patchPaths: ["thresholds.ackWarningMs", "thresholds.slowTotalMs"],
      }),
    ).toBe("AUTO_APPLY_SAFE");
    expect(
      classifyApplyClass({
        kind: "engineering_change",
        risk: "high",
        autoApplyable: false,
        engineeringRequired: true,
      }),
    ).toBe("REQUIRES_ENGINEERING");
    expect(
      canAutoApply({
        kind: "engineering_change",
        risk: "high",
        autoApplyable: false,
        engineeringRequired: true,
        status: "pending_approval",
      }),
    ).toBe(false);
  });

  it("maps ack_no_final, first_visible_slow, repeated excerpt, and negative feedback", () => {
    const failed = [
      evaluateWhatsAppConversation(
        buildThreadFromFixture({
          companyId: "co_caddington",
          conversationKey: "int_ack",
          userMessages: ["Find Coal Search"],
          assistantMessages: ["Got it"],
          qualitySignals: ["whatsapp_ack_no_final_over_30s"],
        }),
      ),
      evaluateWhatsAppConversation(
        buildThreadFromFixture({
          companyId: "co_caddington",
          conversationKey: "int_excerpt",
          userMessages: ["More detail"],
          assistantMessages: ["Same excerpt"],
          qualitySignals: ["whatsapp_answer_repeated_excerpt"],
        }),
      ),
      evaluateWhatsAppConversation(
        buildThreadFromFixture({
          companyId: "co_caddington",
          conversationKey: "int_neg",
          userMessages: ["That's not it"],
          assistantMessages: ["Which document?"],
          qualitySignals: ["whatsapp_negative_result_feedback"],
        }),
      ),
    ];
    const drafts = proposeImprovements(groupQualityPatterns(failed));
    expect(drafts.some((row) => row.title.includes("ack without a terminal"))).toBe(true);
    expect(drafts.some((row) => row.title.includes("repeated search excerpt"))).toBe(true);
    expect(drafts.some((row) => row.title.includes("Negative result feedback"))).toBe(true);
    expect(drafts.every((row) => row.engineeringRequired)).toBe(true);
  });

  it("never treats invented Drive file URLs as genuine provider links", async () => {
    const { isGenuineProviderHttpsUrl } = await import("./runtime-policy");
    expect(isGenuineProviderHttpsUrl("https://drive.google.com/file/d/{id}/view")).toBe(false);
    expect(isGenuineProviderHttpsUrl("https://drive.google.com/file/d/no-url-file/view")).toBe(false);
    expect(isGenuineProviderHttpsUrl("https://app.infrastack.app")).toBe(false);
    expect(isGenuineProviderHttpsUrl("https://drive.google.com/file/d/1abcGenuineId/view")).toBe(true);
    const { sourceLinkReply } = await import("../whatsapp-synthesize");
    expect(
      sourceLinkReply({
        id: "doc",
        title: "Coal Search",
        url: "https://drive.google.com/file/d/{id}/view",
      } as never),
    ).not.toContain("drive.google.com");
  });

  it("composes sequential AUTO_APPLY_SAFE canaries instead of replacing them", () => {
    const first = resolveApplyBase({
      promoted: null,
      canary: {
        config: {
          ...DEFAULT_QUALITY_RUNTIME,
          prompts: { ...DEFAULT_QUALITY_RUNTIME.prompts, systemNote: "Answer the user's ask in the first reply." },
        },
      },
    });
    expect(first.prompts.systemNote).toContain("first reply");
    const second = resolveApplyBase({
      promoted: null,
      canary: {
        config: {
          ...first,
          thresholds: { ...first.thresholds, ackWarningMs: 2_000, slowTotalMs: 45_000 },
        },
      },
    });
    expect(second.prompts.systemNote).toContain("first reply");
    expect(second.thresholds.ackWarningMs).toBe(2_000);
    expect(second.thresholds.slowTotalMs).toBe(45_000);
    expect(second.planner.blockWriteIntents).toBe(true);
  });

  it("uses applied runtime warning thresholds when scoring", () => {
    const evaluation = evaluateWhatsAppConversation(
      buildThreadFromFixture({
        companyId: "co_caddington",
        conversationKey: "int_warn",
        userMessages: ["Find Coal Search"],
        assistantMessages: ["Found it."],
        firstVisibleMs: 2_400,
        totalMs: 2_400,
        finalSent: true,
      }),
      { thresholds: { ackWarningMs: 2_000, silenceMs: 30_000, stuckMs: 60_000, slowTotalMs: 45_000 } },
    );
    expect(evaluation.flags.some((flag) => flag.category === "first_visible_slow")).toBe(true);
    expect(evaluation.flags.find((flag) => flag.category === "first_visible_slow")?.severity).toBe("medium");
    expect(evaluation.failed).toBe(false);
    expect(evaluation.overallQualityScore).toBeGreaterThanOrEqual(90);
  });

  it("points the review email at /quality/improvements?run=", () => {
    const mail = qualityReviewEmail({
      date: "2026-08-31",
      kind: "daily",
      cadence: "Daily 08:00 Europe/London, auto-changes to weekly after 60 days",
      periodFrom: "2026-08-29T23:00:00.000Z",
      periodTo: "2026-08-30T23:00:00.000Z",
      metrics: {
        messagesAnalysed: 163,
        conversationsAnalysed: 163,
        qualityAverage: 99.4,
        failedRate: 0.18,
        rephraseRate: 0.03,
        ackLatencyMs: 2084,
        finalLatencyMs: 8805,
        openProposals: 3,
        approvedProposals: 0,
        deployedProposals: 0,
        rolledBackProposals: 0,
        evaluatorCostCents: 0,
      },
      failures: [],
      patterns: [],
      proposals: [
        { title: "Strengthen first-answer completeness guidance", risk: "low", autoApplyable: true, engineeringRequired: false },
      ],
      reviewUrl: "https://app.infrastack.app/quality/improvements?run=qlr_6ed56444-6d13-4b87-b7ad-ddfdc170818a",
    });
    expect(mail.bodyHtml).toContain("https://app.infrastack.app/quality/improvements?run=qlr_");
    expect(mail.bodyHtml).toContain("Clicking this email does not apply changes");
  });

  it("says when approved improvements are already applied", () => {
    const mail = qualityReviewEmail({
      date: "2026-08-31",
      kind: "manual",
      cadence: "Daily 08:00 Europe/London, auto-changes to weekly after 60 days",
      periodFrom: "2026-08-29T23:00:00.000Z",
      periodTo: "2026-08-30T23:00:00.000Z",
      metrics: {
        messagesAnalysed: 163,
        conversationsAnalysed: 163,
        qualityAverage: 99.4,
        failedRate: 0.18,
        rephraseRate: 0.03,
        ackLatencyMs: 2084,
        finalLatencyMs: 8805,
        openProposals: 4,
        approvedProposals: 3,
        deployedProposals: 0,
        rolledBackProposals: 0,
        evaluatorCostCents: 0,
      },
      failures: [],
      patterns: [],
      proposals: [
        {
          title: "Strengthen first-answer completeness guidance",
          risk: "low",
          autoApplyable: true,
          engineeringRequired: false,
          status: "canary",
        },
        {
          title: "ENGINEERING CHANGE REQUIRED — repeated search excerpt",
          risk: "high",
          autoApplyable: false,
          engineeringRequired: true,
          status: "pending_approval",
        },
      ],
      reviewUrl: "https://app.infrastack.app/quality/improvements?run=qlr_6ed56444-6d13-4b87-b7ad-ddfdc170818a",
      appliedNote: "3 approved improvements are live on the Caddington canary. 4 items still need review.",
    });
    expect(mail.bodyText).toContain("already applied");
    expect(mail.bodyText).toContain("Caddington canary");
    expect(mail.bodyHtml).toContain("Clicking this email does not apply changes");
  });
});

vi.mock("../email/providers/cloudflare-email", () => ({
  sendCloudflareEmail: vi.fn(async () => ({ ok: true, providerMessageId: "msg_1" })),
}));
