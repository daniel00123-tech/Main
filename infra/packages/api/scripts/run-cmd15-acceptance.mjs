#!/usr/bin/env node
/**
 * Production CMD15 Microsoft queue activation acceptance — phased.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function mintToken() {
  const acceptanceToken = `cmd15_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(acceptanceToken).digest("hex");
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${tokenHash}', datetime('now', '+3 hours'));`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );
  return acceptanceToken;
}

async function callAcceptance(token, phase, body = {}) {
  const url = `${API}/api/internal/cmd15/microsoft-acceptance?phase=${phase}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { httpStatus: res.status, body: await res.json().catch(() => ({ error: "Invalid JSON" })) };
}

async function main() {
  const phases = [
    "queue-status",
    "queue-prove",
    "queue",
    "idempotency",
    "lifecycle",
    "exclusion",
    "regression",
    "graph",
  ];
  const output = { phases: {} };

  for (const phase of phases) {
    const token = await mintToken();
    output.phases[phase] = await callAcceptance(token, phase);
  }

  const fullToken = await mintToken();
  output.full = await callAcceptance(fullToken, "full");

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : "Probe failed" }));
  process.exit(1);
});
