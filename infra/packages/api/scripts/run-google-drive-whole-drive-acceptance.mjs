#!/usr/bin/env node
/**
 * Production Google Drive whole-drive acceptance via infra-api internal route.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `gdrive_${randomBytes(24).toString("hex")}`;
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

const res = await fetch(`${API}/api/internal/google-drive/whole-drive-acceptance`, {
  method: "POST",
  headers: { "X-CMD13-Acceptance-Token": token, "Content-Type": "application/json" },
});
console.log(JSON.stringify({ httpStatus: res.status, body: await res.json() }, null, 2));
