#!/usr/bin/env node
/**
 * Backfill ledger metadata for Stripe sandbox top-ups — sets creditClass=test
 * when authoritative stripeMode=test is present. Does not alter amounts.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1Exec(sql) {
  if (dryRun) return;
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql],
    { cwd: apiDir, encoding: "utf8", stdio: "pipe" },
  );
}

const rows = d1Query(
  `SELECT id, company_id, metadata_json FROM ledger_entries
   WHERE entry_type = 'top_up' AND metadata_json LIKE '%"stripeMode":"test"%'`,
);

let updated = 0;
for (const row of rows) {
  let meta = {};
  try {
    meta = JSON.parse(String(row.metadata_json ?? "{}"));
  } catch {
    continue;
  }
  if (meta.creditClass === "test") continue;
  meta.creditClass = "test";
  const escaped = JSON.stringify(meta).replace(/'/g, "''");
  d1Exec(
    `UPDATE ledger_entries SET metadata_json = '${escaped}' WHERE id = '${String(row.id).replace(/'/g, "''")}'`,
  );
  updated += 1;
}

console.log(JSON.stringify({ dryRun, scanned: rows.length, updated }, null, 2));
