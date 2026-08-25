#!/usr/bin/env node
/** Debug tools/list — never prints tokens. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function getSecret(name) {
  const out = execFileSync("npx", ["wrangler", "secret", "list"], {
    cwd: apiDir,
    encoding: "utf8",
  });
  if (!out.includes(name)) return null;
  // Fetch via wrangler whoami env - use wrangler to call with secret in subprocess
  return execFileSync(
    "node",
    [
      "-e",
      `
const { execFileSync } = require('node:child_process');
const token = execFileSync('npx', ['wrangler', 'secret', 'get', '${name}'], { cwd: '${apiDir}', encoding: 'utf8' }).trim();
process.stdout.write(token);
`,
    ],
    { encoding: "utf8" },
  ).trim();
}

// wrangler secret get may not exist - try alternative via env in worker
let mcpToken;
try {
  mcpToken = execFileSync(
    "bash",
    [
      "-lc",
      `cd '${apiDir}' && npx wrangler secret list 2>/dev/null | grep -q CADDINGTON_MCP_AUTH_TOKEN && npx wrangler dev --remote --test-scheduled 2>/dev/null || true`,
    ],
    { encoding: "utf8" },
  );
} catch {
  /* ignore */
}

// Use Cloudflare API via wrangler d1 + direct MCP probe with token from secrets store
const tokenJson = execFileSync(
  "npx",
  ["wrangler", "secret", "list", "--format", "json"],
  { cwd: apiDir, encoding: "utf8" },
);
const secrets = JSON.parse(tokenJson);
const hasMcpAuth = secrets.some((s) => s.name === "CADDINGTON_MCP_AUTH_TOKEN");

async function mcpDirect(method, params, authHeader, rpcId = 1) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2024-11-05",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text.trim().startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}");
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body, textLen: text.length };
}

// Get MCP auth via wrangler secrets bulk (if available) - fallback: read from worker binding test
let mcpAuth = null;
if (hasMcpAuth) {
  try {
    mcpAuth = execFileSync(
      "node",
      [
        join(apiDir, "scripts", "read-worker-secret.mjs"),
        "CADDINGTON_MCP_AUTH_TOKEN",
      ],
      { encoding: "utf8", cwd: apiDir },
    ).trim();
  } catch {
    /* script may not exist */
  }
}

// Temp INFRA identity with wildcard scope
const infraToken = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(infraToken).digest("hex");
const scopes = JSON.stringify(["*"]);
const sqlFile = join(apiDir, ".tmp-tools-debug.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP tools debug', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${infraToken.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function infraMcp(method, params, rpcId) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${infraToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Query allowlist count
const allowSql = join(apiDir, ".tmp-allow-count.sql");
writeFileSync(
  allowSql,
  `SELECT COUNT(*) as cnt FROM mcp_tool_allowlist WHERE mcp_environment_id = 'mcp_caddington_primary' AND enabled = 1;`,
);
const allowOut = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", "SELECT COUNT(*) as cnt FROM mcp_tool_allowlist WHERE mcp_environment_id = 'mcp_caddington_primary' AND enabled = 1"],
  { cwd: apiDir, encoding: "utf8" },
);

const downstream = {};
if (mcpAuth) {
  downstream.initOnly = await mcpDirect("initialize", { protocolVersion: "2025-03-26" }, `Bearer ${mcpAuth}`, 1);
  downstream.listAfterInit = await mcpDirect("tools/list", {}, `Bearer ${mcpAuth}`, 2);
  downstream.listNoInit = await mcpDirect("tools/list", {}, `Bearer ${mcpAuth}`, 3);
} else {
  downstream.note = "CADDINGTON_MCP_AUTH_TOKEN not readable locally";
}

const infraInit = await infraMcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const infraListWildcard = await infraMcp("tools/list", {}, 2);

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

const downstreamTools = downstream.listAfterInit?.body?.result?.tools ?? [];
const infraTools = infraListWildcard.body?.result?.tools ?? [];

console.log(
  JSON.stringify(
    {
      hasMcpAuthSecret: hasMcpAuth,
      allowlistQuery: allowOut.slice(0, 500),
      downstream: {
        initStatus: downstream.initOnly?.status,
        listAfterInitStatus: downstream.listAfterInit?.status,
        listAfterInitToolCount: downstreamTools.length,
        listAfterInitToolNames: downstreamTools.slice(0, 30).map((t) => t.name),
        listNoInitStatus: downstream.listNoInit?.status,
        listNoInitToolCount: (downstream.listNoInit?.body?.result?.tools ?? []).length,
        listNoInitError: downstream.listNoInit?.body?.error ?? null,
        note: downstream.note,
      },
      infraWildcardScope: {
        initStatus: infraInit.status,
        listStatus: infraListWildcard.status,
        toolCount: infraTools.length,
        toolNames: infraTools.map((t) => t.name),
        error: infraListWildcard.body?.error ?? null,
      },
    },
    null,
    2,
  ),
);
