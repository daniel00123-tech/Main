#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ headersTimeout: 540_000, bodyTimeout: 540_000 }));

const API = process.env.INFRA_API_BASE || "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = process.argv[2];
const out = process.argv[3] || "/tmp/el-internal.json";
const body = process.argv[4] ? JSON.parse(process.argv[4]) : {};

function d1(command) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

const token = `el_int_${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
d1(
  `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
);

const res = await fetch(`${API}${path}`, {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
    "User-Agent": "InfraAcceptance/1.0",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(540_000),
});
const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
const report = { api: API, path, httpStatus: res.status, body: json };
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ written: out, httpStatus: res.status, error: json.error ?? null }, null, 2));
if (res.status !== 200) process.exit(1);
