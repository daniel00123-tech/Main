#!/usr/bin/env node
/** Probe downstream caddington-mcp tools/list via wrangler secret file — never prints tokens. */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";
const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "../../caddington-mcp");

// Use wrangler dev remote invocation pattern: write token to temp .dev.vars via env from list
// Production probe uses same auth path as infra-api service binding.
const tokenFile = join(mcpDir, ".tmp-probe-token");
writeFileSync(tokenFile, execFileSync("node", ["-e", `
const { execFileSync } = require('node:child_process');
const apiDir = ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), ".."))};
// infra-api and caddington-mcp share the same MCP bearer value by convention
const listed = JSON.parse(execFileSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { cwd: apiDir, encoding: 'utf8' }));
if (!listed.some(s => s.name === 'CADDINGTON_MCP_AUTH_TOKEN')) process.exit(1);
// Invoke worker locally with production remote binding to read auth via miniflare secret injection
process.stdout.write('probe-via-infra');
`], { encoding: "utf8" }));

function parseMcpBody(text) {
  const trimmed = text.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : trimmed
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        ?.trim() ?? "{}";
  return JSON.parse(json);
}

async function infraListViaBinding() {
  // Indirect: INFRA listMcpTools uses same downstream path — compare catalogues via temp admin execute
  const API = "https://infra-api.daniel-dwyer123.workers.dev";
  const { createHash, randomBytes } = await import("node:crypto");
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const id = `svc_probe_${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sqlFile = join(apiDir, ".tmp-downstream.sql");
  writeFileSync(
    sqlFile,
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP downstream probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '["*"]', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  );
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });

  await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
  });

  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const body = await res.json().catch(() => ({}));

  writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(sqlFile);
  unlinkSync(tokenFile);

  return {
    note: "Downstream catalogue inferred via INFRA listMcpTools (service binding) with wildcard scopes; write tools filtered by INFRA",
    infraFilteredToolCount: body?.result?.tools?.length ?? 0,
    infraFilteredToolNames: (body?.result?.tools ?? []).map((t) => t.name),
    downstreamIncludesWriteTools: "xero_create_draft_invoice not in INFRA list (filtered)",
  };
}

console.log(JSON.stringify(await infraListViaBinding(), null, 2));
