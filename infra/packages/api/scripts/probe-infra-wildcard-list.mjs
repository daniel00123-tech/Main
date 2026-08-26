#!/usr/bin/env node
/** INFRA tools/list debug with wildcard scopes — never prints tokens. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");

const sqlFile = join(apiDir, ".tmp-wildcard.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP wildcard probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '["*"]', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcp(method, params, rpcId) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const init = await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const list = await mcp("tools/list", {}, 2);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

const tools = list.body?.result?.tools ?? [];
console.log(
  JSON.stringify(
    {
      initStatus: init.status,
      listStatus: list.status,
      listError: list.body?.error ?? null,
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
    },
    null,
    2,
  ),
);
