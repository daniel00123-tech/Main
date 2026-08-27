#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_cmd15_${randomBytes(4).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const scopes = JSON.stringify(["knowledge.search", "knowledge.read"]);

execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "infra-control-plane",
    "--remote",
    "--command",
    `INSERT INTO service_identities (id, company_id, name, status, identity_type, token_hash, token_prefix, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'cmd15 probe', 'active', 'chatgpt', '${hash}', '${token.slice(0, 12)}', '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  ],
  { cwd: apiDir, stdio: "pipe" },
);

await fetch(`${API}/api/gateway/v1/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
});

const results = [];
for (const query of ["Coal Search", "Company Van Policy", "LLP Agreement"]) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_company_knowledge", arguments: { query, limit: 5 } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  let hits = [];
  try {
    hits = JSON.parse(text || "{}").results ?? [];
  } catch {
    hits = [];
  }
  results.push({ query, status: res.status, hitCount: hits.length, topTitle: hits[0]?.title ?? hits[0]?.documentTitle ?? null });
}

execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", `DELETE FROM service_identities WHERE id='${id}';`],
  { cwd: apiDir, stdio: "pipe" },
);

console.log(JSON.stringify({ results, verdict: results.some((r) => r.hitCount > 0) ? "SEARCH_PASS" : "SEARCH_FAIL" }, null, 2));
