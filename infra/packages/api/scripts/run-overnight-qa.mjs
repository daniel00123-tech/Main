#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/overnight-qa";
mkdirSync(outDir, { recursive: true });

function call(stage, extra = {}, destName = stage) {
  const dest = join(outDir, `${String(destName).replace(/[^a-z0-9_-]/gi, "_")}.json`);
  const body = JSON.stringify({ stage, ...extra });
  const result = spawnSync(
    "node",
    ["scripts/run-el-internal.mjs", "/api/internal/overnight-qa", dest, body],
    { cwd: apiDir, encoding: "utf8", timeout: 200_000 },
  );
  return { stage, dest, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const slices = [
  ["inventory"],
  ["whatsapp", { ids: ["WA01", "WA02", "WA03", "WA04"] }],
  ["whatsapp", { ids: ["WA05", "WA06", "WA07", "WA08"] }],
  ["whatsapp", { ids: ["WA09", "WA10", "WA11", "WA12"] }],
  ["whatsapp", { ids: ["WA13", "WA14", "WA15", "WA16"] }],
  ["whatsapp", { ids: ["WA17", "WA18", "WA19", "WA20"] }],
  ["portal", { ids: ["PC01", "PC02", "PC03", "PC04"] }],
  ["portal", { ids: ["PC05", "PC09", "PC10", "PC11"] }],
  ["portal", { ids: ["PC12", "PC13", "PC14", "PC15"] }],
  ["portal", { ids: ["PC16", "PC17", "PC18", "PC19", "PC20"] }],
  ["mcp"],
  ["warehouse", { ids: ["WH01", "WH02", "WH03", "WH04"] }],
  ["warehouse", { ids: ["WH05", "WH06", "WH07"] }],
  ["warehouse", { ids: ["WH08", "WH09", "WH10"] }],
  ["followup"],
  ["routing"],
  ["billing"],
  ["isolation"],
  ["audit"],
];

const results = [];
for (const [stage, extra] of slices) {
  const label = extra?.ids ? `${stage}-${extra.ids[0]}` : stage;
  console.log(JSON.stringify({ starting: label }));
  const row = call(stage, extra ?? {}, label);
  results.push({ label, ...row });
  if (row.status !== 0) console.log(row.stdout || row.stderr);
}

writeFileSync(join(outDir, "index.json"), JSON.stringify({ written: results.map((row) => row.dest) }, null, 2));
console.log(JSON.stringify({ outDir, slices: results.length }, null, 2));
