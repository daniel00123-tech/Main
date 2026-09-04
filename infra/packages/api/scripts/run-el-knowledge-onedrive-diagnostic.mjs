#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_BASE || "https://infra-api.daniel-dwyer123.workers.dev";
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
  const token = `el_kod_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

const token = mintAcceptanceToken();
const res = await fetch(`${API}/api/internal/el-knowledge-onedrive-diagnostic`, {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
    "User-Agent": "InfraAcceptance/1.0",
  },
  signal: AbortSignal.timeout(90_000),
});
const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
const out = { api: API, httpStatus: res.status, body };
writeFileSync(join(apiDir, "../../tmp-el-knowledge-onedrive-diagnostic.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
