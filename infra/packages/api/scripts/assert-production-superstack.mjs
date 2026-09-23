#!/usr/bin/env node
/**
 * Production deploy must fail if this tree is not the combined superstack.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "npx",
  ["vitest", "run", "src/services/production-superstack.guard.test.ts"],
  { cwd: apiDir, stdio: "inherit", env: process.env },
);

if (result.status !== 0) {
  console.error(
    "PRODUCTION DEPLOY BLOCKED: this tree is missing a critical combined capability. Do not deploy a partial branch over the live superstack.",
  );
  process.exit(result.status ?? 1);
}
