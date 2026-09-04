#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `el_ingest_audit_${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "infra-control-plane",
    "--remote",
    "--command",
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  ],
  { cwd: apiDir, stdio: "inherit" },
);

const res = await fetch("https://api.infrastack.app/api/internal/el-knowledge-ingestion-audit", {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    windowFrom: "2026-09-03T17:39:03.388Z",
    windowTo: "2026-09-04T17:39:03.388Z",
    persistEvents: true,
  }),
  signal: AbortSignal.timeout(180_000),
});
const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
const report = { httpStatus: res.status, body };
writeFileSync("/tmp/el-knowledge-ingestion-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
