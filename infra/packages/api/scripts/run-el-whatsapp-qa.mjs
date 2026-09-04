#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_BASE || "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const CONVERSATIONS = ["xero", "outlook", "mixed", "rbac_office", "rbac_auth", "failure"];

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
  const token = `el_wa50_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function runSlice(conversation, memory) {
  const token = mintAcceptanceToken();
  const res = await fetch(`${API}/api/internal/el-whatsapp-qa`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "InfraAcceptance/1.0",
    },
    body: JSON.stringify({ conversation, memory }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, body };
}

const report = { api: API, conversations: {} };
let memory = null;
for (const conversation of CONVERSATIONS) {
  const next = conversation === "xero" || conversation === "outlook" || conversation === "mixed" ? memory : null;
  const result = await runSlice(conversation, next);
  report.conversations[conversation] = result;
  memory = result.body?.memory ?? null;
  console.log(conversation, result.httpStatus, result.body?.tallies ?? result.body?.error ?? result.body);
}

writeFileSync("/tmp/el-whatsapp-qa.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ written: "/tmp/el-whatsapp-qa.json" }));
