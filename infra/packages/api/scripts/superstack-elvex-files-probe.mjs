#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA = "Mozilla/5.0";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function d1File(sql) {
  const file = join(apiDir, ".tmp-elvex-files.sql");
  writeFileSync(file, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", file], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(file);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const verifier = randomBytes(32).toString("base64url");
const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
const code = randomBytes(32).toString("base64url");
d1File(`INSERT INTO oauth_authorization_codes (
  id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
  code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
) VALUES (
  'ocode_${randomBytes(8).toString("hex")}', '${sha256Hex(code)}', '${CLIENT_ID}', '${WILLIAM_USER}', 'co_el', '${WILLIAM_MEM}',
  '${REDIRECT}', '${challenge}', 'S256', 'mcp', NULL, 'chatgpt', '${new Date(Date.now() + 8 * 60 * 1000).toISOString()}', datetime('now')
);`);

const tok = await fetch(`${API}/oauth/token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": UA,
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }),
}).then((res) => res.json());

async function mcp(method, params, id) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const raw = await res.text();
  const body = raw.trim().startsWith("data:")
    ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data:")).slice(5).trim())
    : JSON.parse(raw);
  const text = body?.result?.content?.find((part) => part.type === "text")?.text;
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep */
  }
  return { http: res.status, parsed, err: body.error };
}

await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const files = await mcp("tools/call", { name: "search_elvex_files", arguments: { query: "staff handbook" } }, 2);
const hits = Array.isArray(files.parsed?.results)
  ? files.parsed.results
  : Array.isArray(files.parsed?.files)
    ? files.parsed.files
    : Array.isArray(files.parsed?.documents)
      ? files.parsed.documents
      : Array.isArray(files.parsed)
        ? files.parsed
        : [];
const first = hits[0] ?? null;
const summary = {
  searchHttp: files.http,
  keys: files.parsed && typeof files.parsed === "object" ? Object.keys(files.parsed) : [],
  hitCount: hits.length,
  first: first
    ? {
        id: first.id ?? first.fileId ?? first.documentId ?? first.document_id ?? null,
        title: first.title ?? first.name ?? first.filename ?? null,
        snippet: String(first.snippet ?? first.excerpt ?? first.text ?? "").slice(0, 120),
      }
    : null,
  err: files.err ?? null,
};

const id = summary.first?.id;
const title = summary.first?.title;
if (id) {
  const got = await mcp(
    "tools/call",
    { name: "get_elvex_file", arguments: { id: String(id), documentRef: String(id), title } },
    3,
  );
  const fetchStd = await mcp("tools/call", { name: "fetch", arguments: { id: String(id), title } }, 4);
  summary.get_elvex_file = {
    http: got.http,
    title: got.parsed?.title ?? got.parsed?.name ?? null,
    textChars: String(got.parsed?.text ?? got.parsed?.content ?? "").length,
    untitled: (got.parsed?.title ?? "") === "Untitled document",
    keys: got.parsed && typeof got.parsed === "object" ? Object.keys(got.parsed).slice(0, 16) : [],
  };
  summary.fetch = {
    http: fetchStd.http,
    id: fetchStd.parsed?.id ?? null,
    title: fetchStd.parsed?.title ?? null,
    textChars: String(fetchStd.parsed?.text ?? "").length,
    chunks: Array.isArray(fetchStd.parsed?.chunks) ? fetchStd.parsed.chunks.length : 0,
    untitled: fetchStd.parsed?.title === "Untitled document",
  };
}

console.log(JSON.stringify(summary, null, 2));
