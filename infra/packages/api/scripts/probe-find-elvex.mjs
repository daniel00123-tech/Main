#!/usr/bin/env node
/** Find Elvex contact in production Xero — read only. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const scopes = JSON.stringify(["xero.contacts.search", "xero.contacts.read"]);
const sqlFile = join(apiDir, ".tmp-find-elvex.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'TEMP find elvex', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});

async function mcpContacts(args) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xero_list_contacts", arguments: args },
    }),
  });
  const body = await res.json();
  const text = body?.result?.content?.find((p) => p.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

const broad = await mcpContacts({ limit: 100 });
const all = broad?.contacts ?? [];
const elvexMatches = all.filter((c) => /elvex/i.test(String(c.Name ?? "")));

const searchTerms = ["elvex", "property", "Elvex", "Property Services"];
const searchResults = {};
for (const term of searchTerms) {
  const r = await mcpContacts({ query: term, limit: 20 });
  searchResults[term] = (r?.contacts ?? []).map((c) => ({ ContactID: c.ContactID, Name: c.Name }));
}

writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id='${id}';`);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "pipe",
});
unlinkSync(sqlFile);

console.log(
  JSON.stringify(
    {
      broadCount: all.length,
      elvexInBroadList: elvexMatches.map((c) => ({ ContactID: c.ContactID, Name: c.Name })),
      searchResults,
      sampleNames: all.slice(0, 20).map((c) => c.Name),
    },
    null,
    2,
  ),
);
