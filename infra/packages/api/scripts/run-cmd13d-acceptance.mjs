#!/usr/bin/env node
/**
 * Production CMD13D Microsoft OneDrive acceptance — multi-phase to respect Worker subrequest limits.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function mintToken() {
  const acceptanceToken = `cmd13d_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(acceptanceToken).digest("hex");
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${tokenHash}', datetime('now', '+1 hour'));`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );
  return acceptanceToken;
}

async function callAcceptance(token, phase, body = {}) {
  const url =
    phase === "discover"
      ? `${API}/api/internal/cmd13d/microsoft-acceptance?phase=discover`
      : `${API}/api/internal/cmd13d/microsoft-acceptance?phase=sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { httpStatus: res.status, body: await res.json().catch(() => ({ error: "Invalid JSON" })) };
}

async function runKnowledgeSearch(queries) {
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const id = `svc_cmd13d_${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const scopes = JSON.stringify(["knowledge.search", "knowledge.read", "system.health"]);

  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'CMD13D probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );

  const results = [];
  let rpcId = 1;
  await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
  });

  for (const query of queries) {
    const res = await fetch(`${API}/api/gateway/v1/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name: "search_company_knowledge", arguments: { query, limit: 5 } },
      }),
    });
    const body = await res.json().catch(() => ({}));
    const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text ? { raw: String(text).slice(0, 300) } : null;
    }
    const hits = parsed?.results ?? parsed?.matches ?? parsed?.documents ?? parsed?.items ?? [];
    results.push({
      query,
      status: res.status,
      ok: res.status === 200 && !body?.error,
      hitCount: Array.isArray(hits) ? hits.length : 0,
      topHits: Array.isArray(hits)
        ? hits.slice(0, 3).map((h) => ({
            title: h.title ?? h.documentTitle ?? h.name ?? null,
            source: h.source ?? h.metadata?.source ?? null,
            topic: h.topic ?? h.metadata?.topic ?? null,
            snippet: String(h.snippet ?? h.text ?? h.excerpt ?? "").slice(0, 120) || null,
          }))
        : [],
    });
  }

  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      `DELETE FROM service_identities WHERE id = '${id}';`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );
  return results;
}

async function main() {
  const discoveryToken = await mintToken();
  const discovery = await callAcceptance(discoveryToken, "discover");
  const output = { discovery };

  if (discovery.body?.verdict === "DISCOVERY_COMPLETE" && discovery.body?.driveId) {
    const syncToken = await mintToken();
    const sync = await callAcceptance(syncToken, "sync", {
      driveId: discovery.body.driveId,
      ownerDisplayName: discovery.body.danielOneDrive?.ownerDisplayName,
    });
    output.sync = sync;

    if (sync.body?.verdict === "SYNC_COMPLETE") {
      const indexed = sync.body.indexedItems ?? [];
      const oneDriveTitle = indexed.find((i) => i.indexingStatus === "indexed")?.title;
      const queries = [
        oneDriveTitle?.replace(/\.[^.]+$/, "") ?? "HeatTech Shareholders",
        "Bare Trust Declararion",
        "Coal Search",
        "Company Van Policy",
      ];
      output.knowledgeSearch = await runKnowledgeSearch(queries);
      output.googleDriveRegression = (await runKnowledgeSearch(["Company Van Policy"])).map((r) => ({
        ...r,
        regression: true,
      }));
      output.verdict = "ACCEPTANCE_COMPLETE";
    } else {
      output.verdict = sync.body?.verdict ?? "SYNC_FAILED";
    }
  } else {
    output.verdict = discovery.body?.verdict ?? "DISCOVERY_FAILED";
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : "Probe failed" }));
  process.exit(1);
});
