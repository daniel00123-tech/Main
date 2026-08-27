#!/usr/bin/env node
/**
 * Production CMD14 Microsoft queue scale acceptance — multi-phase.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function mintToken() {
  const acceptanceToken = `cmd14_${randomBytes(24).toString("hex")}`;
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
      `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${tokenHash}', datetime('now', '+2 hours'));`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );
  return acceptanceToken;
}

async function callAcceptance(token, phase, body = {}) {
  const url = `${API}/api/internal/cmd14/microsoft-acceptance?phase=${phase}`;
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
  const discoverToken = await mintToken();
  const discovery = await callAcceptance(discoverToken, "discover");
  const output = { discovery };

  if (discovery.body?.verdict === "DISCOVERY_COMPLETE") {
    const syncToken = await mintToken();
    const sync = await callAcceptance(syncToken, "sync", {
      sourceId: discovery.body.sourceId,
      waitMs: 600000,
    });
    output.sync = sync;

    if (sync.body?.verdict === "SYNC_COMPLETE") {
      const searchToken = await mintToken();
      output.search = await callAcceptance(searchToken, "search");
      output.classification = sync.body.targetFiles?.llpAgreement?.indexed &&
        sync.body.targetFiles?.mizzenXlsx?.indexed &&
        output.search.body?.verdict === "SEARCH_PASS"
        ? "MICROSOFT KNOWLEDGE SCALE PASS"
        : "BETA READY WITH LIMITATIONS";
    } else {
      output.classification = "FAIL";
    }
  } else {
    output.classification = "FAIL";
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : "Probe failed" }));
  process.exit(1);
});
