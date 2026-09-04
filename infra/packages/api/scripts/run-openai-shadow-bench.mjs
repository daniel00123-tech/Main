#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_BASE || "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function d1(command) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const out = execFileSync(
        "npx",
        ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
        { cwd: apiDir, encoding: "utf8" },
      );
      const parsed = JSON.parse(out);
      return parsed[0]?.results ?? [];
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function mintAcceptanceToken() {
  const token = `openai_shadow_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function post(path, body) {
  const token = mintAcceptanceToken();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "InfraAcceptance/1.0",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, body: json };
}

const report = {
  api: API,
  startedAt: new Date().toISOString(),
  smoke: null,
  flags: null,
  cloudflareMock: null,
  slices: [],
  emailSequence: null,
  errors: [],
};

const smoke = await post("/api/internal/openai-brain-smoke", {});
report.smoke = smoke;
if (smoke.httpStatus !== 200 || !smoke.body?.smoke) {
  report.errors.push({ step: "smoke", smoke });
}

const flags = await post("/api/internal/openai-brain-shadow-bench", { action: "flags" });
report.flags = flags.body?.flags ?? flags;

const mock = await post("/api/internal/openai-brain-shadow-bench", { action: "cloudflare_mock" });
report.cloudflareMock = mock.body?.scorecard ?? mock;

for (let offset = 0; offset < 100; offset += 4) {
  const slice = await post("/api/internal/openai-brain-shadow-bench", { action: "slice", offset, limit: 4 });
  if (slice.httpStatus !== 200 || slice.body?.error) {
    report.errors.push({ step: "slice", offset, slice });
    continue;
  }
  report.slices.push({
    offset,
    scorecard: slice.body.scorecard,
    rows: slice.body.rows,
    source: slice.body.source,
  });
}

const email = await post("/api/internal/openai-brain-shadow-bench", { action: "email_sequence" });
report.emailSequence = email.body?.sequence ?? email;

const totals = {
  cases: 0,
  intent: 0,
  tool: 0,
  grounding: 0,
  firstAnswer: 0,
  naturalness: 0,
  followUp: 0,
  unnecessaryTools: 0,
  hallucination: 0,
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  estimatedCostUsd: 0,
  failures: 0,
};
for (const slice of report.slices) {
  const n = slice.scorecard?.cases ?? 0;
  totals.cases += n;
  totals.intent += (slice.scorecard?.intent ?? 0) * n;
  totals.tool += (slice.scorecard?.tool ?? 0) * n;
  totals.grounding += (slice.scorecard?.grounding ?? 0) * n;
  totals.firstAnswer += (slice.scorecard?.firstAnswer ?? 0) * n;
  totals.naturalness += (slice.scorecard?.naturalness ?? 0) * n;
  totals.followUp += (slice.scorecard?.followUp ?? 0) * n;
  totals.unnecessaryTools += (slice.scorecard?.unnecessaryTools ?? 0) * n;
  totals.hallucination += (slice.scorecard?.hallucination ?? 0) * n;
  totals.latencyMs += (slice.scorecard?.avgLatencyMs ?? 0) * n;
  for (const row of slice.rows ?? []) {
    totals.promptTokens += row.promptTokens ?? 0;
    totals.completionTokens += row.completionTokens ?? 0;
    totals.estimatedCostUsd += row.estimatedCostUsd ?? 0;
    if (row.failure) totals.failures += 1;
  }
}
report.openaiLive = {
  source: "LIVE_API",
  cases: totals.cases,
  intent: totals.cases ? Math.round(totals.intent / totals.cases * 10) / 10 : 0,
  tool: totals.cases ? Math.round(totals.tool / totals.cases * 10) / 10 : 0,
  grounding: totals.cases ? Math.round(totals.grounding / totals.cases * 10) / 10 : 0,
  firstAnswer: totals.cases ? Math.round(totals.firstAnswer / totals.cases * 10) / 10 : 0,
  naturalness: totals.cases ? Math.round(totals.naturalness / totals.cases * 10) / 10 : 0,
  followUp: totals.cases ? Math.round(totals.followUp / totals.cases * 10) / 10 : 0,
  unnecessaryTools: totals.cases ? Math.round(totals.unnecessaryTools / totals.cases * 10) / 10 : 0,
  hallucination: totals.cases ? Math.round(totals.hallucination / totals.cases * 10) / 10 : 0,
  avgLatencyMs: totals.cases ? Math.round(totals.latencyMs / totals.cases) : 0,
  promptTokens: totals.promptTokens,
  completionTokens: totals.completionTokens,
  estimatedCostUsd: totals.estimatedCostUsd || null,
  costBasis: totals.estimatedCostUsd ? "estimated" : "unknown",
  failures: totals.failures,
  costInputs: {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    rates: "published gpt-5.6-luna/terra/sol from developers.openai.com/api/docs/models",
  },
};
report.finishedAt = new Date().toISOString();

const out = join(apiDir, "openai-shadow-bench-report.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.errors.length === 0, out, smoke: report.smoke?.body?.smoke, openaiLive: report.openaiLive, errors: report.errors.length }, null, 2));
