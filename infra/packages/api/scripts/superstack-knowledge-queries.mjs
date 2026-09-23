#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { membership } from "./lib/william-intended-role.mjs";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA = "Mozilla/5.0";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function d1File(sql) {
  const file = join(apiDir, ".tmp-knowledge-q.sql");
  writeFileSync(file, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", file], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(file);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
const code = randomBytes(32).toString("base64url");
d1File(`INSERT INTO oauth_authorization_codes (
  id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
  code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
) VALUES (
  'ocode_${randomBytes(8).toString("hex")}', '${createHash("sha256").update(code).digest("hex")}', '${CLIENT_ID}', '${WILLIAM_USER}', 'co_el', '${WILLIAM_MEM}',
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
  return { http: res.status, parsed, err: body.error ?? null };
}

await mcp("initialize", { protocolVersion: "2025-03-26" }, 1);
const queries = ["staff handbook", "file", "pdf", "policy", "service agreement", "site inspection", "elvex", "handbook"];
const searches = [];
for (const [index, query] of queries.entries()) {
  const viaSearch = await mcp("tools/call", { name: "search", arguments: { query } }, 10 + index);
  const viaFiles = await mcp("tools/call", { name: "search_elvex_files", arguments: { query } }, 30 + index);
  searches.push({
    query,
    search: {
      http: viaSearch.http,
      count: Array.isArray(viaSearch.parsed?.results) ? viaSearch.parsed.results.length : null,
      firstTitle: viaSearch.parsed?.results?.[0]?.title ?? null,
      firstId: viaSearch.parsed?.results?.[0]?.id ?? null,
      err: viaSearch.err,
    },
    files: {
      http: viaFiles.http,
      count: Array.isArray(viaFiles.parsed?.results) ? viaFiles.parsed.results.length : null,
      firstTitle: viaFiles.parsed?.results?.[0]?.title ?? null,
      firstId: viaFiles.parsed?.results?.[0]?.id ?? null,
      keys: viaFiles.parsed && typeof viaFiles.parsed === "object" ? Object.keys(viaFiles.parsed) : [],
      err: viaFiles.err,
    },
  });
}

const hit = searches.find((row) => row.search.firstId || row.files.firstId);
let fetchProof = null;
if (hit) {
  const id = hit.search.firstId || hit.files.firstId;
  const title = hit.search.firstTitle || hit.files.firstTitle;
  const fetched = await mcp("tools/call", { name: "fetch", arguments: { id, title } }, 80);
  fetchProof = {
    query: hit.query,
    id,
    title: fetched.parsed?.title ?? null,
    textChars: String(fetched.parsed?.text ?? "").length,
    chunks: Array.isArray(fetched.parsed?.chunks) ? fetched.parsed.chunks.length : 0,
    untitled: fetched.parsed?.title === "Untitled document",
    err: fetched.err,
  };
}

const catalogue = await mcp("tools/call", { name: "list_company_documents", arguments: { sort: "latest", limit: 10 } }, 90);
const outlook = await mcp(
  "tools/call",
  { name: "outlook_list_messages", arguments: { mailboxAddress: "info@elvexpropertyservices.com", limit: 1 } },
  91,
);
const firstMail = outlook.parsed?.messages?.[0] ?? outlook.parsed?.items?.[0] ?? null;
let outlookGet = null;
const mailId = firstMail?.id ?? firstMail?.messageId ?? null;
if (mailId) {
  const got = await mcp(
    "tools/call",
    { name: "outlook_get_message", arguments: { mailboxAddress: "info@elvexpropertyservices.com", id: mailId } },
    92,
  );
  outlookGet = {
    sameId: (got.parsed?.id ?? got.parsed?.message?.id) === mailId,
    hasBody: Boolean(got.parsed?.body || got.parsed?.hasBody || got.parsed?.message?.body),
    keys: got.parsed && typeof got.parsed === "object" ? Object.keys(got.parsed).slice(0, 16) : [],
    err: got.err,
  };
}

const summary = {
  role: membership(apiDir),
  tokenOk: Boolean(tok.access_token),
  searches,
  fetchProof,
  catalogue: {
    http: catalogue.http,
    count: Array.isArray(catalogue.parsed?.documents) ? catalogue.parsed.documents.length : null,
    firstTitle: catalogue.parsed?.documents?.[0]?.title ?? null,
    note: catalogue.parsed?.note ?? null,
    err: catalogue.err,
  },
  outlookList: {
    http: outlook.http,
    count: outlook.parsed?.count ?? (Array.isArray(outlook.parsed?.messages) ? outlook.parsed.messages.length : null),
    firstId: mailId,
    err: outlook.err,
  },
  outlookGet,
};

console.log(JSON.stringify(summary, null, 2));
