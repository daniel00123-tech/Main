#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.INFRA_API_BASE || "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const CONVERSATIONS = {
  xero: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15", "D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  outlook: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13", "B14", "B15"],
  mixed: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"],
  rbac_office: ["E1", "E2", "E3"],
  rbac_auth: ["E4"],
  failure: ["E5"],
};

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
  const token = `el_wa50_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function runSlice(ids, memory) {
  const token = mintAcceptanceToken();
  const res = await fetch(`${API}/api/internal/el-whatsapp-qa`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
      "User-Agent": "InfraAcceptance/1.0",
    },
    body: JSON.stringify({ ids, memory }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, body };
}

function chunk(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const report = { api: API, worker: "3158c849-2d46-4519-811e-4b1af66e267f", turns: [], errors: [] };
for (const [conversation, ids] of Object.entries(CONVERSATIONS)) {
  let memory = null;
  for (const idsChunk of chunk(ids, 2)) {
    const result = await runSlice(idsChunk, memory);
    if (result.httpStatus !== 200 || result.body?.error) {
      report.errors.push({ conversation, ids: idsChunk, result });
      console.error("FAIL", conversation, idsChunk, result.httpStatus, result.body?.error ?? result.body);
      continue;
    }
    memory = result.body?.memory ?? memory;
    for (const turn of result.body?.turns ?? []) report.turns.push({ conversation, ...turn });
    console.log(conversation, idsChunk.join(","), result.body?.tallies, (result.body?.turns ?? []).map((t) => `${t.id}:${t.grade}`).join(" "));
  }
}

writeFileSync("/tmp/el-whatsapp-qa.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ written: "/tmp/el-whatsapp-qa.json", turns: report.turns.length, errors: report.errors.length }));
