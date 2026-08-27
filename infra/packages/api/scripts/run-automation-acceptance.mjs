#!/usr/bin/env node
/**
 * Automation Engine V1 acceptance — calls production internal endpoint.
 *
 * Usage:
 *   node scripts/run-automation-acceptance.mjs
 *   INFRA_API_URL=https://... node scripts/run-automation-acceptance.mjs
 */

const apiBase = (process.env.INFRA_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(
  /\/$/,
  "",
);

async function main() {
  const response = await fetch(`${apiBase}/api/internal/automation/acceptance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  const body = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ httpStatus: response.status, ...body }, null, 2));
  process.exit(response.ok && body.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
