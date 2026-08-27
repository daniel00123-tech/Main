#!/usr/bin/env node
/**
 * Production CMD13 Microsoft acceptance — calls deployed infra-api internal route.
 * Never prints secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runKnowledgeSearch(queries) {
  const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
  const id = `svc_cmd13_${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const scopes = JSON.stringify(["knowledge.search", "knowledge.read", "system.health"]);
  const sqlFile = join(apiDir, ".tmp-cmd13-acceptance.sql");

  writeFileSync(
    sqlFile,
    `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', 'co_caddington', 'CMD13 acceptance probe', 'cleanup', 'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}', NULL, 0, '${scopes.replace(/'/g, "''")}', 'mcp_caddington_primary', datetime('now'), datetime('now'));`,
  );
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });

  const results = [];
  let rpcId = 1;
  await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
  });

  for (const query of queries) {
    const res = await fetch(`${API}/api/gateway/v1/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
            source: h.source ?? h.metadata?.source ?? h.provenance?.sourceType ?? null,
            topic: h.topic ?? h.metadata?.topic ?? null,
            snippet: (h.snippet ?? h.text ?? h.excerpt ?? "").slice(0, 120) || null,
          }))
        : [],
    });
  }

  writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(sqlFile);
  return results;
}

async function main() {
  const acceptanceToken = `cmd13_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(acceptanceToken).digest("hex");
  const sqlFile = join(apiDir, ".tmp-cmd13-token.sql");

  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "infra-control-plane",
      "--remote",
      "--command",
      `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${tokenHash}', datetime('now', '+1 hour'));`,
    ],
    { cwd: apiDir, stdio: "pipe" },
  );

  const res = await fetch(`${API}/api/internal/cmd13/microsoft-acceptance`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": acceptanceToken,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const workerReport = await res.json().catch(() => ({ error: "Invalid JSON" }));

  const output = { httpStatus: res.status, workerAcceptance: workerReport };

  if (workerReport.adminBridge?.ok && workerReport.verdict === "ACCEPTANCE_COMPLETE") {
    const indexed = workerReport.indexedItems ?? [];
    const oneDriveTitle = indexed.find(
      (i) => i.sourceType === "onedrive" && i.indexingStatus === "indexed",
    )?.title;
    const sharepointTitle = indexed.find(
      (i) => i.sourceType === "sharepoint" && i.indexingStatus === "indexed",
    )?.title;
    const testFiles = [
      ...(workerReport.testOneDrive?.testFiles ?? []).map((f) => f.name.replace(/\.[^.]+$/, "")),
      ...(workerReport.testSharePoint?.testFiles ?? []).map((f) => f.name.replace(/\.[^.]+$/, "")),
    ];

    const queries = [
      oneDriveTitle ?? "INFRA Knowledge Test",
      sharepointTitle ?? "Coal Search",
      "Microsoft 365",
      ...testFiles.slice(0, 2),
    ].filter(Boolean);

    output.knowledgeSearch = await runKnowledgeSearch([...new Set(queries)].slice(0, 5));
    output.googleDriveRegression = (
      await runKnowledgeSearch(["Company Van Policy", "vehicle mileage policy"])
    ).map((r) => ({ ...r, regression: true }));
  } else if (workerReport.adminBridge && !workerReport.adminBridge.ok) {
    output.stopped = "Stopped before ingestion — admin token mismatch";
  } else if (res.status === 404) {
    output.note = "Acceptance route not deployed yet — deploy infra-api with CMD13 acceptance endpoint";
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : "Probe failed" }));
  process.exit(1);
});
