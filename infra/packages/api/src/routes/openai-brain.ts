import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Env } from "../env";
import {
  EMAIL_FOLLOWUP_SEQUENCE,
  frozenElCases,
  scoreEmailFollowUpShadow,
  scoreFrozenBenchmark,
  scoreLiveOpenAiShadowSlice,
  scoreMixedToolShadow,
  scoreNoToolConversationShadow,
  scoreXeroFollowUpShadow,
} from "../services/intelligence/eval/el-frozen-benchmark.js";
import { scoreExactToolChoiceShadow } from "../services/intelligence/eval/exact-tool-bench.js";
import { resolveBrainPolicy } from "../services/intelligence/brain-policy.js";
import { inspectOpenAiKey } from "../services/intelligence/openai-responses.js";
import {
  listRecentShadowEvals,
  persistShadowEval,
  runOpenAiConnectivitySmoke,
} from "../services/intelligence/shadow-eval.js";

const routes = new Hono<{ Bindings: Env }>();

async function verifyCmdAcceptanceToken(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): Promise<boolean> {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  if (!valid) return false;
  await c.env.DB.prepare(`DELETE FROM cmd13_acceptance_tokens WHERE token_hash = ?`).bind(hash).run();
  return true;
}

function flagState(env: Env) {
  const el = resolveBrainPolicy({ env, companyId: "co_el" });
  const elPa = resolveBrainPolicy({ env, companyId: "co_el", channel: "portal_chat" });
  const elRequest = resolveBrainPolicy({ env, companyId: "co_el", channel: "whatsapp" });
  const elChatbot = resolveBrainPolicy({ env, companyId: "co_el", channel: "chatgpt" });
  const caddington = resolveBrainPolicy({ env, companyId: "co_caddington" });
  const caddingtonPa = resolveBrainPolicy({ env, companyId: "co_caddington", channel: "portal_chat" });
  const caddingtonRequest = resolveBrainPolicy({ env, companyId: "co_caddington", channel: "whatsapp" });
  const caddingtonChatbot = resolveBrainPolicy({ env, companyId: "co_caddington", channel: "chatgpt" });
  const ht = resolveBrainPolicy({ env, companyId: "co_ht" });
  const publicDecision = (row: ReturnType<typeof resolveBrainPolicy>) => ({
    mode: row.mode,
    shadow: row.shadow,
    useOpenAi: row.useOpenAi,
    reason: row.reason,
    role: row.role,
    designatedBrain: row.designatedBrain,
    userVisibleBrain: row.userVisibleBrain,
  });
  return {
    keyConfigured: inspectOpenAiKey(env).configured,
    el: publicDecision(el),
    elPa: publicDecision(elPa),
    elRequest: publicDecision(elRequest),
    elChatbot: publicDecision(elChatbot),
    caddington: publicDecision(caddington),
    caddingtonPa: publicDecision(caddingtonPa),
    caddingtonRequest: publicDecision(caddingtonRequest),
    caddingtonChatbot: publicDecision(caddingtonChatbot),
    ht: publicDecision(ht),
  };
}

routes.post("/api/internal/openai-brain-smoke", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const smoke = await runOpenAiConnectivitySmoke(c.env);
  if (smoke.success) {
    await persistShadowEval(
      c.env.DB,
      {
        provider: "openai",
        model: smoke.model,
        latencyMs: smoke.latencyMs,
        promptTokens: smoke.promptTokens,
        completionTokens: smoke.completionTokens,
        cachedTokens: smoke.cachedTokens,
        estimatedCostUsd: smoke.estimatedCostUsd,
        costBasis: smoke.costBasis,
        correlationId: smoke.correlationId,
        toolProposal: [],
        failure: smoke.failure,
        reusedEvidence: false,
        executedLiveTools: false,
        userVisibleProvider: "cloudflare",
      },
      "co_el",
      "smoke",
    );
  }
  return c.json({
    ok: smoke.ok,
    action: "smoke",
    flags: flagState(c.env),
    smoke,
    userVisibleAnswers: "cloudflare",
  });
});

routes.post("/api/internal/openai-brain-shadow-bench", async (c) => {
  if (!(await verifyCmdAcceptanceToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const body = await c.req.json<{ action?: string; offset?: number; limit?: number; ids?: string[] }>().catch(() => ({}));
  const action = String(body.action ?? "slice").trim();
  if (action === "flags") {
    return c.json({ ok: true, action, flags: flagState(c.env), userVisibleAnswers: "cloudflare" });
  }
  if (action === "email_sequence") {
    const sequence = await scoreEmailFollowUpShadow(c.env);
    return c.json({ ok: true, action, flags: flagState(c.env), sequence, userVisibleAnswers: "cloudflare" });
  }
  if (action === "xero_sequence") {
    const sequence = await scoreXeroFollowUpShadow(c.env);
    return c.json({ ok: true, action, flags: flagState(c.env), sequence, userVisibleAnswers: "cloudflare" });
  }
  if (action === "mixed_tool") {
    const sequence = await scoreMixedToolShadow(c.env);
    return c.json({ ok: true, action, flags: flagState(c.env), sequence, userVisibleAnswers: "cloudflare" });
  }
  if (action === "no_tool") {
    const sequence = await scoreNoToolConversationShadow(c.env);
    return c.json({ ok: true, action, flags: flagState(c.env), sequence, userVisibleAnswers: "cloudflare" });
  }
  if (action === "exact_tool") {
    const scored = await scoreExactToolChoiceShadow(c.env);
    return c.json({
      ok: true,
      action,
      flags: flagState(c.env),
      source: scored.source,
      scorecard: scored.scorecard,
      rows: scored.rows.map((row) => ({
        id: row.id,
        family: row.family,
        required: row.required,
        expectedFamilies: row.expectedFamilies,
        actualFamilies: row.actualFamilies,
        tools: row.tools,
        familyOk: row.familyOk,
        requiredOk: row.requiredOk,
        inboxNoTool: row.inboxNoTool,
        xeroNoTool: row.xeroNoTool,
      })),
      userVisibleAnswers: "cloudflare",
    });
  }
  if (action === "cloudflare_mock") {
    const scored = await scoreFrozenBenchmark("cloudflare");
    return c.json({
      ok: true,
      action,
      source: "MOCK",
      scorecard: scored.scorecard,
      userVisibleAnswers: "cloudflare",
    });
  }
  if (action === "recent") {
    const rows = await listRecentShadowEvals(c.env.DB, "co_el", 12);
    return c.json({ ok: true, action, rows, userVisibleAnswers: "cloudflare" });
  }
  const all = frozenElCases();
  const selected = Array.isArray(body.ids) && body.ids.length
    ? all.filter((row) => body.ids!.includes(row.id))
    : all.slice(Math.max(0, Number(body.offset ?? 0)), Math.max(0, Number(body.offset ?? 0)) + Math.min(4, Math.max(1, Number(body.limit ?? 4))));
  const scored = await scoreLiveOpenAiShadowSlice(c.env, selected);
  for (const row of scored.rows) {
    await persistShadowEval(c.env.DB, row.shadow, "co_el", "shadow_bench");
  }
  return c.json({
    ok: true,
    action: "slice",
    source: "LIVE_API",
    offset: Number(body.offset ?? 0),
    limit: selected.length,
    total: all.length,
    flags: flagState(c.env),
    scorecard: scored.scorecard,
    rows: scored.rows.map((row) => ({
      id: row.id,
      pass: row.pass,
      cloudflareTools: row.tools,
      shadowTools: row.shadowTools,
      userVisibleProvider: row.userVisibleProvider,
      model: row.shadow.model,
      latencyMs: row.shadow.latencyMs,
      promptTokens: row.shadow.promptTokens,
      completionTokens: row.shadow.completionTokens,
      costBasis: row.shadow.costBasis,
      estimatedCostUsd: row.shadow.estimatedCostUsd,
      failure: row.shadow.failure,
      reusedEvidence: row.shadow.reusedEvidence,
    })),
    userVisibleAnswers: "cloudflare",
    emailSequenceIds: EMAIL_FOLLOWUP_SEQUENCE.map((row) => row.id),
  });
});

export default routes;
