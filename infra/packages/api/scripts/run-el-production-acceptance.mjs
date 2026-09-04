#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_ACCEPTANCE_API ?? "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  const token = `el_prod_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

const token = mintAcceptanceToken();
const res = await fetch(`${API}/api/internal/el-production-acceptance`, {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
    "User-Agent": "InfraAcceptance/1.0",
  },
  signal: AbortSignal.timeout(240_000),
});
const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
const report = { httpStatus: res.status, api: API, body };
writeFileSync("/tmp/el-production-acceptance.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(res.status === 200 ? 0 : 1);
