#!/usr/bin/env node
/**
 * @deprecated Use verify-stripe-live-1-gbp-acceptance.mjs — live acceptance is £1.00 GBP (100 pence).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "verify-stripe-live-1-gbp-acceptance.mjs");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
