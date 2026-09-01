#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_URL ?? "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `ocr_v1_${randomBytes(24).toString("hex")}`;
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
  { cwd: apiDir, stdio: "pipe" },
);

const res = await fetch(`${API}/api/internal/ocr/acceptance`, {
  method: "POST",
  headers: { "X-CMD13-Acceptance-Token": token, "Content-Type": "application/json" },
});
console.log(JSON.stringify({ httpStatus: res.status, body: await res.json() }, null, 2));
