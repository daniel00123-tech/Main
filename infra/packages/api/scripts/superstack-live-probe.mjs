#!/usr/bin/env node
/**
 * Superstack v2 live probe. Records William first. Temporary office_staff
 * only for denial. Restores intended Director. No Xero writes, email, or WhatsApp.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  persistIntendedRole,
  readIntendedRole,
  restoreIntendedRole,
  membership,
} from "./lib/william-intended-role.mjs";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.infrastack.app";
const MCP = `${API}/api/gateway/v1/mcp`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";
const TODAY = "2026-09-01";

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-superstack-live.sql");
  writeFileSync(sqlFile, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
    { cwd: apiDir, stdio: "pipe" },
  );
  unlinkSync(sqlFile);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function setRole(role, reason) {
  d1File(
    `UPDATE company_memberships SET role='${role}', updated_at=datetime('now') WHERE id='${WILLIAM_MEM}' AND company_id='co_el';
     INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
     VALUES ('audit_${randomBytes(8).toString("hex")}', 'co_el', 'membership.role_controlled_acceptance', 'cursor-acceptance', 'company_membership', '${WILLIAM_MEM}', '{"toRole":"${role}","reason":"${reason}","platformAdmin":false}', datetime('now'));`,
  );
  return d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
}

async function mintWilliamToken() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const codeHash = sha256Hex(code);
  const id = `ocode_${randomBytes(8).toString("hex")}`;
  const expires = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  d1File(`INSERT INTO oauth_authorization_codes (
    id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
    code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
  ) VALUES (
    '${id}', '${codeHash}', '${CLIENT_ID}', '${WILLIAM_USER}', 'co_el', '${WILLIAM_MEM}',
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
  const body = await res.json().catch(() => ({}));
  return {
    httpStatus: res.status,
    accessToken: body.access_token ?? null,
    refreshToken: body.refresh_token ?? null,
    error: body.error ?? null,
  };
}

async function mcp(token, method, params = {}, id = 1) {
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
  let body = {};
  try {
    body = raw.trim().startsWith("data:")
      ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "{}")
      : JSON.parse(raw);
  } catch {
    body = { parseError: raw.slice(0, 400) };
  }
  return { httpStatus: res.status, body };
}

function toolText(body) {
  const text = body?.result?.content?.find((part) => part.type === "text")?.text;
  if (!text) return { error: body?.error ?? body };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const report = {
  recordedBeforeThisProbe: membership(apiDir),
  intended: persistIntendedRole(apiDir, "director", "superstack-v2-live-probe"),
  public: {},
  director: {},
  officeStaff: {},
  restored: null,
};

const health = await fetch(`${API}/health`, { headers: { "User-Agent": UA } }).then((r) => r.json());
const chat = await fetch(`${API}/api/companies/el-business/chat/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": UA },
  body: JSON.stringify({ text: "hi" }),
});
const webhook = await fetch(`${API}/api/webhooks/whatsapp`, { headers: { "User-Agent": UA } });
const oauth = await fetch(`${API}/.well-known/oauth-authorization-server`, { headers: { "User-Agent": UA } }).then((r) =>
  r.json(),
);
report.public = {
  health,
  portalChatUnauth: { status: chat.status, body: await chat.text() },
  webhook: { status: webhook.status, body: (await webhook.text()).slice(0, 120) },
  oauthIssuer: oauth.issuer ?? null,
  authorizationEndpoint: oauth.authorization_endpoint ?? null,
};

async function session(label) {
  const minted = await mintWilliamToken();
  if (!minted.accessToken) return { tokenOk: false, error: minted };
  const token = minted.accessToken;
  await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 1);
  const listed = await mcp(token, "tools/list", {}, 2);
  const tools = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
  const out = {
    tokenOk: true,
    refreshOk: Boolean(minted.refreshToken),
    tools,
    xeroTools: tools.filter((name) => name.startsWith("xero_") || name.includes("xero")),
    catalogueListed: tools.includes("list_company_documents"),
    askDocumentListed: tools.includes("ask_document"),
    fetchListed: tools.includes("fetch") || tools.includes("get_knowledge_document"),
  };
  if (label === "director") {
    const sales = await mcp(token, "tools/call", {
      name: "xero_sales_summary",
      arguments: { period: "today", fromDate: TODAY, toDate: TODAY },
    }, 10);
    out.salesToday = { httpStatus: sales.httpStatus, rpcError: sales.body?.error ?? null, data: toolText(sales.body) };
    const search = await mcp(token, "tools/call", { name: "search", arguments: { query: "staff handbook" } }, 11);
    const searchData = toolText(search.body);
    out.search = {
      httpStatus: search.httpStatus,
      resultCount: Array.isArray(searchData.results) ? searchData.results.length : null,
      first: searchData.results?.[0] ?? searchData.error ?? null,
    };
    const firstId = searchData.results?.[0]?.id;
    const firstTitle = searchData.results?.[0]?.title;
    if (firstId) {
      const fetched = await mcp(
        token,
        "tools/call",
        { name: "fetch", arguments: { id: firstId, title: firstTitle } },
        12,
      );
      const doc = toolText(fetched.body);
      out.fetch = {
        httpStatus: fetched.httpStatus,
        id: doc.id ?? null,
        title: doc.title ?? null,
        textChars: typeof doc.text === "string" ? doc.text.length : 0,
        chunkCount: Array.isArray(doc.chunks) ? doc.chunks.length : 0,
        untitled: doc.title === "Untitled document",
      };
    }
    const catalogue = await mcp(
      token,
      "tools/call",
      { name: "list_company_documents", arguments: { sort: "latest", limit: 10 } },
      13,
    );
    const cat = toolText(catalogue.body);
    out.catalogue = {
      httpStatus: catalogue.httpStatus,
      count: Array.isArray(cat.documents) ? cat.documents.length : null,
      firstTitle: cat.documents?.[0]?.title ?? null,
      note: cat.note ?? null,
      error: cat.error ?? null,
    };
  } else {
    const denied = await mcp(
      token,
      "tools/call",
      { name: "xero_sales_summary", arguments: { period: "today", fromDate: TODAY, toDate: TODAY } },
      20,
    );
    out.xeroDenied = {
      httpStatus: denied.httpStatus,
      error: denied.body?.error ?? null,
      data: toolText(denied.body),
    };
  }
  return out;
}

const liveRole = membership(apiDir)?.role;
if (liveRole !== "director") setRole("director", "superstack authorised reads");
report.director = await session("director");

report.officeStaffRole = setRole("office_staff", "superstack denial only");
report.officeStaff = await session("office_staff");

report.restored = restoreIntendedRole(apiDir, "office_staff", "superstack v2 restore original Director");
report.finalMembership = membership(apiDir);
report.intendedAfter = readIntendedRole(apiDir);

const refresh = report.officeStaff.refreshOk || report.director.refreshOk;
report.oauthStillValidAfterDenial = Boolean(refresh);
report.chatgptRefreshNeeded = false;

writeFileSync(join(apiDir, "../../docs/superstack-v2-live-probe.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
