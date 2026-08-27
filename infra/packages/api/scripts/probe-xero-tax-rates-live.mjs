#!/usr/bin/env node
/** Fetch live Xero tax rates for Caddington — read only. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { XERO_AUTH } = await import("@infra/shared");
const { xeroGetJson, resolveXeroTaxTypeForDraftInvoice } = await import("@infra/xero-core");

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = `SELECT credential_ref_id FROM connector_instances WHERE company_id='co_caddington' AND connector_definition_id='conn_xero' AND auth_status='connected' LIMIT 1;`;
const out = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
  { cwd: apiDir, encoding: "utf8" },
);
const row = JSON.parse(out)?.[0]?.results?.[0];
if (!row?.credential_ref_id) {
  console.error("No connected Xero instance");
  process.exit(1);
}

// Tax resolution happens inside deployed worker; use production plan dry-run instead.
console.log(
  JSON.stringify(
    {
      note: "Use probe-draft-invoice-dry-run.mjs after deploy for live tax resolution evidence.",
      xeroApiBase: XERO_AUTH.apiBaseUrl,
    },
    null,
    2,
  ),
);
