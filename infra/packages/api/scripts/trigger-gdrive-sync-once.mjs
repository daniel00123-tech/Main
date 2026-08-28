#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = `sync_${randomBytes(16).toString("hex")}`;
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
    `INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  ],
  { cwd: apiDir, stdio: "pipe" },
);
const res = await fetch(`${API}/api/internal/google-drive/trigger-sync`, {
  method: "POST",
  headers: { "X-CMD13-Acceptance-Token": token, "Content-Type": "application/json" },
  body: JSON.stringify({ dryRun: false, autoIndex: true }),
});
console.log(JSON.stringify({ status: res.status, body: await res.json() }, null, 2));
