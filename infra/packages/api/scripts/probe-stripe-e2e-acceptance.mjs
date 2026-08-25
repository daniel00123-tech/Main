#!/usr/bin/env node
/** Run production Stripe sandbox E2E acceptance (remote D1 + webhook). Never prints secrets. */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://infra-api.daniel-dwyer123.workers.dev";

const health = await fetch(`${API}/api/gateway/v1/health`).then((r) => r.json());

execFileSync(
  "npx",
  ["vitest", "run", "src/services/stripe.e2e.test.ts"],
  {
    cwd: apiDir,
    stdio: "inherit",
    env: { ...process.env, STRIPE_E2E: "1" },
  },
);

console.log(
  JSON.stringify(
    {
      acceptance: "passed",
      healthBeforeRun: health,
      note: "£1 sandbox top-up credited and refunded via signed production webhooks; net wallet impact £0.",
    },
    null,
    2,
  ),
);
