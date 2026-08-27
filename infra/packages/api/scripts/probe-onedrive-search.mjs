#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(4).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "infra-control-plane",
    "--remote",
    "--command",
    `INSERT INTO service_identities (id, company_id, name, status, identity_type, token_hash, token_prefix, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'probe', 'active', 'chatgpt', '${hash}', '${token.slice(0, 12)}', '["knowledge.search"]', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  ],
  { cwd: "packages/api", stdio: "pipe" },
);

let rpc = 1;
await fetch(`${API}/api/gateway/v1/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
});

for (const q of [
  "HeatTech Shareholders Agreement",
  "Investment Commitment Agreement Dwyer",
  "Bare Trust Declararion signed",
]) {
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpc++,
      method: "tools/call",
      params: { name: "search_company_knowledge", arguments: { query: q, limit: 3 } },
    }),
  });
  const body = await res.json();
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  const parsed = text ? JSON.parse(text) : {};
  console.log(
    q,
    JSON.stringify(
      (parsed.results || []).slice(0, 2).map((h) => ({
        title: h.title,
        source: h.source,
        topic: (h.topic || "").slice(0, 120),
      })),
      null,
      0,
    ),
  );
}

execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", `DELETE FROM service_identities WHERE id = '${id}';`],
  { cwd: "packages/api", stdio: "pipe" },
);
