#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}
function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-cat-retest.sql");
  writeFileSync(sqlFile, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
    cwd: apiDir,
    stdio: "pipe",
  });
  unlinkSync(sqlFile);
}

async function mint() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const id = `ocode_${randomBytes(8).toString("hex")}`;
  const expires = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  d1File(`INSERT INTO oauth_authorization_codes (
    id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
    code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
  ) VALUES (
    '${id}', '${createHash("sha256").update(code).digest("hex")}', '${CLIENT_ID}', '${WILLIAM_USER}', 'co_el', '${WILLIAM_MEM}',
    '${REDIRECT}', '${challenge}', 'S256', 'mcp', NULL, 'chatgpt', '${expires}', datetime('now')
  );`);
  const res = await fetch(`${API}/oauth/token`, {
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
  });
  return res.json();
}

async function mcp(token, method, params, id) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const raw = await res.text();
  return JSON.parse(raw.trim().startsWith("data:") ? raw.split("\n").find((l) => l.startsWith("data:")).slice(5) : raw);
}

function parseTool(body) {
  const text = body?.result?.content?.find((p) => p.type === "text")?.text;
  if (!text) return { error: body?.error ?? body };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const role = d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
const minted = await mint();
const token = minted.access_token;
await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 1);
const newest = parseTool(
  await mcp(token, "tools/call", { name: "list_company_documents", arguments: { sort: "newest", limit: 10 } }, 2),
);
const latest = parseTool(
  await mcp(token, "tools/call", { name: "list_company_documents", arguments: { sort: "latest", source: "onedrive", limit: 10 } }, 3),
);
const xeroDenied = await mcp(token, "tools/call", { name: "xero_sales_summary", arguments: { period: "today" } }, 4);
const search = parseTool(
  await mcp(token, "tools/call", { name: "search", arguments: { query: "staff handbook" } }, 5),
);
const hits = search?.results ?? search?.documents ?? search?.hits ?? [];
const firstId = hits[0]?.id ?? hits[0]?.documentId ?? hits[0]?.document_id ?? null;
let ask = null;
if (firstId) {
  ask = parseTool(
    await mcp(
      token,
      "tools/call",
      { name: "ask_document", arguments: { documentId: firstId, question: "What is this document about?", title: hits[0]?.title } },
      6,
    ),
  );
}
const financeMail = await mcp(
  token,
  "tools/call",
  { name: "outlook_list_messages", arguments: { mailboxAddress: "finance@elvexpropertyservices.com", limit: 1 } },
  7,
);
const finalRole = d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
const usage = d1(
  `SELECT tool_name, action, success, settlement_status, recorded_at FROM usage_records
   WHERE company_id='co_el' AND user_id='${WILLIAM_USER}' ORDER BY recorded_at DESC LIMIT 8;`,
);

const report = {
  role,
  finalRole,
  newest: {
    error: newest?.error ?? null,
    sort: newest?.sort ?? newest?.result?.sort ?? null,
    count: (newest?.documents ?? newest?.result?.documents ?? []).length,
    titles: (newest?.documents ?? newest?.result?.documents ?? []).slice(0, 5).map((d) => ({
      title: d.title,
      source: d.source,
      created_at: d.created_at,
      descriptionSource: d.descriptionSource,
    })),
    note: newest?.note ?? newest?.result?.note ?? null,
  },
  latest: {
    error: latest?.error ?? null,
    sort: latest?.sort ?? latest?.result?.sort ?? null,
    count: (latest?.documents ?? latest?.result?.documents ?? []).length,
    titles: (latest?.documents ?? latest?.result?.documents ?? []).slice(0, 5).map((d) => ({
      title: d.title,
      source: d.source,
      modified_at: d.modified_at,
      descriptionSource: d.descriptionSource,
    })),
  },
  xeroDenied: {
    code: xeroDenied?.error?.data?.errorCode ?? xeroDenied?.error?.code ?? null,
    role: xeroDenied?.error?.data?.userRole ?? null,
    action: xeroDenied?.error?.data?.action ?? null,
  },
  searchHitId: firstId,
  ask: ask
    ? {
        error: ask?.error ?? null,
        hasAnswer: Boolean(ask?.answer || ask?.reply || ask?.text),
        keys: ask && typeof ask === "object" ? Object.keys(ask).slice(0, 12) : [],
      }
    : null,
  financeMail: {
    code: financeMail?.error?.data?.errorCode ?? financeMail?.error?.code ?? null,
    message: financeMail?.error?.message ?? null,
  },
  usage,
};
writeFileSync("/tmp/capability-catalogue-retest.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
