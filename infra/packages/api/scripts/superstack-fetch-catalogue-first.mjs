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
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function d1File(sql) {
  const file = join(apiDir, ".tmp-fetch-cat.sql");
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
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
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
const catalogue = await mcp("tools/call", { name: "list_company_documents", arguments: { sort: "latest", limit: 5 } }, 2);
const docs = Array.isArray(catalogue.parsed?.documents) ? catalogue.parsed.documents : [];
const first = docs[0] ?? null;
let fetched = null;
let asked = null;
if (first?.id) {
  fetched = await mcp("tools/call", { name: "fetch", arguments: { id: String(first.id), title: first.title } }, 3);
  asked = await mcp(
    "tools/call",
    {
      name: "ask_document",
      arguments: { documentId: String(first.id), question: "what is this document about?", title: first.title },
    },
    4,
  );
}
const outlook = await mcp(
  "tools/call",
  { name: "outlook_list_messages", arguments: { mailboxAddress: "info@elvexpropertyservices.com", limit: 1 } },
  5,
);
const mail = outlook.parsed?.messages?.[0] ?? null;
let outlookGet = null;
if (mail?.id) {
  const got = await mcp(
    "tools/call",
    { name: "outlook_get_message", arguments: { mailboxAddress: "info@elvexpropertyservices.com", id: mail.id } },
    6,
  );
  outlookGet = {
    listedId: mail.id,
    gotId: got.parsed?.id ?? got.parsed?.message?.id ?? null,
    sameId: (got.parsed?.id ?? got.parsed?.message?.id) === mail.id,
    hasBody: Boolean(got.parsed?.hasBody || got.parsed?.body || got.parsed?.message?.body),
    keys: got.parsed && typeof got.parsed === "object" ? Object.keys(got.parsed).slice(0, 20) : [],
    err: got.err,
  };
}

console.log(
  JSON.stringify(
    {
      role: membership(apiDir),
      catalogueTitles: docs.map((doc) => ({ id: doc.id, title: doc.title, modified_at: doc.modified_at })),
      fetch: first
        ? {
            id: first.id,
            requestedTitle: first.title,
            title: fetched?.parsed?.title ?? null,
            textChars: String(fetched?.parsed?.text ?? "").length,
            chunks: Array.isArray(fetched?.parsed?.chunks) ? fetched.parsed.chunks.length : 0,
            untitled: fetched?.parsed?.title === "Untitled document",
            err: fetched?.err ?? null,
          }
        : null,
      ask: asked
        ? {
            title: asked.parsed?.title ?? null,
            noneInDocument: asked.parsed?.noneInDocument ?? null,
            answerChars: String(asked.parsed?.answer ?? "").length,
            err: asked.err,
          }
        : null,
      outlookGet,
    },
    null,
    2,
  ),
);
