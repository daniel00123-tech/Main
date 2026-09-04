#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["director_memory", "director_systems", "office", "parity"];

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
  const token = `portal_chat_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function runSuite(token, suite) {
  const res = await fetch(`${API}/api/internal/portal-chat-acceptance?suite=${suite}`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(240_000),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, suite, body };
}

const token = mintAcceptanceToken();
const suites = {};
for (const suite of SUITES) {
  suites[suite] = await runSuite(token, suite);
}

const officeStaff = await fetch(`${API}/api/internal/office-staff-rbac-acceptance`, {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
  },
  signal: AbortSignal.timeout(240_000),
})
  .then(async (res) => ({ httpStatus: res.status, body: await res.json().catch(() => ({ error: `HTTP ${res.status}` })) }))
  .catch((err) => ({ httpStatus: 0, body: { error: String(err) } }));

const outcomes = [...Object.values(suites).map((row) => row.body?.outcome), officeStaff.body?.verdict];
const report = {
  health: await fetch(`${API}/health`).then((res) => res.json()),
  suites,
  officeStaffGateway: officeStaff,
  outcome: outcomes.every((value) => value === "PASS") ? "PASS" : "PARTIAL",
};
writeFileSync("/tmp/portal-chat-acceptance.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
