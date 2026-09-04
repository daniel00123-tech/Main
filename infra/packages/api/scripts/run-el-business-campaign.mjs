#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_ACCEPTANCE_API ?? "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = (process.env.CAMPAIGN_SUITES ?? "r1_xero,r1_outlook,r1_knowledge,r1_infra,r1_rbac").split(",");

function d1(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
    { cwd: apiDir, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function mintAcceptanceToken() {
  const token = `el_campaign_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

const token = mintAcceptanceToken();
const report = { api: API, startedAt: new Date().toISOString(), suites: [] };
for (const suite of SUITES) {
  const res = await fetch(`${API}/api/internal/el-business-campaign?suite=${encodeURIComponent(suite)}`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "InfraAcceptance/1.0",
    },
    signal: AbortSignal.timeout(420_000),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  report.suites.push({ httpStatus: res.status, suite, body });
  console.log(JSON.stringify({ suite, httpStatus: res.status, average: body.average, turnCount: body.turnCount }, null, 2));
}
writeFileSync("/tmp/el-business-campaign.json", JSON.stringify(report, null, 2));
const failed = report.suites.some((row) => row.httpStatus !== 200);
process.exit(failed ? 1 : 0);
