#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(apiDir, "../../..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const gitSha = git(["rev-parse", "HEAD"]);
const branch = git(["branch", "--show-current"]);
const generatedAt = new Date().toISOString();
const contents = `/** Written by scripts/write-production-lineage.mjs immediately before production deploy. */
export const GENERATED_PRODUCTION_LINEAGE = {
  gitSha: ${JSON.stringify(gitSha)},
  branch: ${JSON.stringify(branch || "unknown")},
  generatedAt: ${JSON.stringify(generatedAt)},
} as const;
`;

writeFileSync(join(apiDir, "src/generated/production-lineage.ts"), contents);
console.log(`Wrote production lineage ${gitSha} (${branch})`);
