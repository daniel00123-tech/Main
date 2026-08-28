#!/usr/bin/env node
/**
 * Set Caddington Google Drive connector_config to ENTIRE_DRIVE + EXCLUDED images.
 * Safe to re-run (UPSERT).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const configJson = JSON.stringify({
  scopeMode: "ENTIRE_DRIVE",
  imageIngestionPolicy: "EXCLUDED",
  knowledgeFolderName: "Caddington Knowledge",
});

const sql = `
INSERT INTO connector_config (connector_code, config_json, updated_at)
VALUES ('google_drive', '${configJson.replace(/'/g, "''")}', datetime('now'))
ON CONFLICT(connector_code) DO UPDATE SET
  config_json = excluded.config_json,
  updated_at = excluded.updated_at;
`;

const sqlFile = join(pkgDir, ".tmp-gdrive-scope.sql");
writeFileSync(sqlFile, sql);
try {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "caddington-business-data", "--remote", "--file", sqlFile],
    { cwd: pkgDir, stdio: "inherit" },
  );
  console.log(JSON.stringify({ ok: true, scopeMode: "ENTIRE_DRIVE", imageIngestionPolicy: "EXCLUDED" }, null, 2));
} finally {
  unlinkSync(sqlFile);
}
