#!/usr/bin/env node
/** Create £10 Stripe Sandbox checkout via remote worker bindings — never prints secrets. */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const out = execFileSync(
  "npx",
  [
    "vitest",
    "run",
    "src/services/stripe.e2e.test.ts",
    "-t",
    "confirms test/sandbox configuration",
  ],
  {
    cwd: apiDir,
    encoding: "utf8",
    env: { ...process.env, STRIPE_E2E: "1" },
  },
);

console.log(out);
