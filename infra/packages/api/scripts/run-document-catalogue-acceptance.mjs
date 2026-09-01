#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEMBERSHIP_ID = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";

function d1(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
    { cwd: apiDir, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function membershipRole() {
  const rows = d1(
    `SELECT role, status FROM company_memberships WHERE id = '${MEMBERSHIP_ID}' AND user_id = '${USER_ID}';`,
  );
  return rows[0] ?? null;
}

function mintAcceptanceToken() {
  const token = `catalogue_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

const recorded = membershipRole();
const token = mintAcceptanceToken();
const res = await fetch(`${API}/api/internal/document-catalogue-acceptance`, {
  method: "POST",
  headers: {
    "X-CMD13-Acceptance-Token": token,
    "Content-Type": "application/json",
  },
  signal: AbortSignal.timeout(180_000),
});
const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
const report = { httpStatus: res.status, williamRole: recorded, body };
writeFileSync("/tmp/document-catalogue-acceptance.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
