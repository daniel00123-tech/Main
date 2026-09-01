#!/usr/bin/env node
/**
 * Remaining live acceptance after combined-tree deploy.
 * Records William's role first. Uses current director for authorised
 * Outlook finance@ get (no finance_team). Caddington catalogue + Q&A
 * uses the existing Tester director membership (roles unchanged).
 * William finishes as office_staff.
 */
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
const TESTER_USER = "user_be5a838c-d326-4a3b-bba2-162baf3629f7";
const TESTER_MEM = "membership_813a2656-8834-473d-a63b-1126df232b80";
const CLIENT_ID = "oauth_16c41fc5-c625-4c00-9ff1-a252a28ec518";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

const SEQUENCES = [
  { direct: "What are the main points?", follow: "What exactly?" },
  { direct: "Summarise it", follow: "When?" },
  { direct: "What does it say?", follow: "More?" },
  { direct: "What does it cover?", follow: "When was that?" },
  { direct: "Give me the key points", follow: "Who?" },
  { direct: "What's in this document?", follow: "What about that?" },
  { direct: "What are the main rules?", follow: "What exactly?" },
  { direct: "Summarise the file", follow: "When?" },
  { direct: "What does it mention?", follow: "More?" },
  { direct: "What's the gist?", follow: "What exactly?" },
  { direct: "What should I know from it?", follow: "When was that?" },
  { direct: "Walk me through the important bits", follow: "More?" },
  { direct: "What obligations are listed?", follow: "Who?" },
  { direct: "What is the purpose?", follow: "What exactly?" },
  { direct: "What does it include?", follow: "When?" },
  { direct: "Key takeaways?", follow: "More?" },
  { direct: "What does it require?", follow: "Who?" },
  { direct: "Tell me what it says", follow: "What about that?" },
  { direct: "What's covered?", follow: "What exactly?" },
  { direct: "Walk me through it", follow: "When was that?" },
];

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1File(sql) {
  const sqlFile = join(apiDir, ".tmp-remaining-live.sql");
  writeFileSync(sqlFile, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
    { cwd: apiDir, stdio: "pipe" },
  );
  unlinkSync(sqlFile);
}

function setWilliamRole(role) {
  d1File(
    `UPDATE company_memberships SET role='${role}', updated_at=datetime('now') WHERE id='${WILLIAM_MEM}' AND company_id='co_el';
     INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
     VALUES ('audit_${randomBytes(8).toString("hex")}', 'co_el', 'membership.role_controlled_acceptance', 'cursor-acceptance', 'company_membership', '${WILLIAM_MEM}', '{"toRole":"${role}","reason":"capability completeness remaining live","platformAdmin":false}', datetime('now'));`,
  );
  return d1(`SELECT role FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0]?.role;
}

async function mint(userId, companyId, membershipId) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const code = randomBytes(32).toString("base64url");
  const id = `ocode_${randomBytes(8).toString("hex")}`;
  const expires = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  d1File(`INSERT INTO oauth_authorization_codes (
    id, code_hash, client_id, user_id, company_id, membership_id, redirect_uri,
    code_challenge, code_challenge_method, scope, resource, channel, expires_at, created_at
  ) VALUES (
    '${id}', '${createHash("sha256").update(code).digest("hex")}', '${CLIENT_ID}', '${userId}', '${companyId}', '${membershipId}',
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
  return { httpStatus: res.status, accessToken: body.access_token ?? null, refreshToken: body.refresh_token ?? null };
}

async function revoke(refreshToken) {
  if (!refreshToken) return;
  await fetch(`${API}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ token: refreshToken, client_id: CLIENT_ID }),
  });
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

function hitId(payload) {
  const hits = payload?.results ?? payload?.documents ?? payload?.hits ?? payload?.result?.results ?? [];
  const first = Array.isArray(hits) ? hits[0] : null;
  return {
    count: Array.isArray(hits) ? hits.length : 0,
    id: first?.id ?? first?.documentId ?? first?.document_id ?? null,
    title: first?.title ?? first?.name ?? null,
  };
}

function askSummary(payload) {
  return {
    error: payload?.error ?? null,
    hasAnswer: Boolean(payload?.answer || payload?.reply || payload?.text),
    none: payload?.confidence === "none" || payload?.none === true,
    chunkCount: payload?.diagnostics?.chunkCount ?? payload?.chunkCount ?? null,
    usedDocumentId: payload?.documentId ?? payload?.diagnostics?.documentId ?? null,
    keys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [],
  };
}

async function runQaSequences(token, primaryQuery, altQuery) {
  const primarySearch = hitId(
    toolText(await mcp(token, "tools/call", { name: "search", arguments: { query: primaryQuery } }, `s-${primaryQuery}`).then((r) => r.body)),
  );
  const altSearch = hitId(
    toolText(await mcp(token, "tools/call", { name: "search", arguments: { query: altQuery } }, `s-${altQuery}`).then((r) => r.body)),
  );
  const sequences = [];
  for (let i = 0; i < SEQUENCES.length; i += 1) {
    const row = SEQUENCES[i];
    const docId = primarySearch.id;
    if (!docId) {
      sequences.push({ n: i + 1, class: "SEARCH_EMPTY", primarySearch });
      continue;
    }
    const direct = askSummary(
      toolText(
        await mcp(
          token,
          "tools/call",
          { name: "ask_document", arguments: { documentId: docId, question: row.direct, title: primarySearch.title } },
          `q-${i}-d`,
        ).then((r) => r.body),
      ),
    );
    const follow = askSummary(
      toolText(
        await mcp(
          token,
          "tools/call",
          {
            name: "ask_document",
            arguments: {
              documentId: docId,
              question: row.follow,
              priorQuestion: row.direct,
              title: primarySearch.title,
            },
          },
          `q-${i}-f`,
        ).then((r) => r.body),
      ),
    );
    sequences.push({
      n: i + 1,
      documentId: docId,
      persisted: direct.usedDocumentId === docId || Boolean(direct.hasAnswer || follow.hasAnswer),
      direct,
      follow,
      noResults: Boolean(direct.none && !direct.hasAnswer),
      followNone: Boolean(follow.none && !follow.hasAnswer),
    });
  }
  return { primarySearch, altSearch, sequences };
}

async function catalogue(token) {
  const newest = toolText(
    await mcp(token, "tools/call", { name: "list_company_documents", arguments: { sort: "newest", limit: 10 } }, "cat-n").then(
      (r) => r.body,
    ),
  );
  const latest = toolText(
    await mcp(token, "tools/call", { name: "list_company_documents", arguments: { sort: "latest", limit: 10 } }, "cat-l").then(
      (r) => r.body,
    ),
  );
  const docs = (payload) => payload?.documents ?? payload?.result?.documents ?? [];
  return {
    newest: {
      error: newest?.error ?? null,
      count: docs(newest).length,
      first: docs(newest)[0]
        ? { title: docs(newest)[0].title, created_at: docs(newest)[0].created_at, source: docs(newest)[0].source }
        : null,
    },
    latest: {
      error: latest?.error ?? null,
      count: docs(latest).length,
      first: docs(latest)[0]
        ? { title: docs(latest)[0].title, modified_at: docs(latest)[0].modified_at, source: docs(latest)[0].source }
        : null,
    },
    orderDiffers: docs(newest)[0]?.title !== docs(latest)[0]?.title,
  };
}

const report = {
  recordedBefore: d1(
    `SELECT role, status, updated_at FROM company_memberships WHERE id='${WILLIAM_MEM}';`,
  )[0],
  testerRoleUnchanged: d1(`SELECT role FROM company_memberships WHERE id='${TESTER_MEM}';`)[0]?.role,
  outlookFinance: {},
  elvex: {},
  caddington: {},
  officeStaff: {},
  finalWilliam: null,
};

try {
  const minted = await mint(WILLIAM_USER, "co_el", WILLIAM_MEM);
  if (!minted.accessToken) throw new Error(`william token ${minted.httpStatus}`);
  const token = minted.accessToken;
  await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 1);
  const listed = await mcp(
    token,
    "tools/call",
    { name: "outlook_list_messages", arguments: { mailboxAddress: "finance@elvexpropertyservices.com", limit: 2 } },
    2,
  );
  const mail = toolText(listed.body);
  const messages = mail?.messages ?? mail?.result?.messages ?? [];
  const listId = messages[0]?.id ?? messages[0]?.messageId ?? null;
  report.outlookFinance.list = {
    httpStatus: listed.httpStatus,
    error: listed.body?.error ?? mail?.error ?? null,
    count: Array.isArray(messages) ? messages.length : 0,
    firstId: listId,
  };
  if (listId) {
    const got = await mcp(
      token,
      "tools/call",
      { name: "outlook_get_message", arguments: { mailboxAddress: "finance@elvexpropertyservices.com", messageId: listId } },
      3,
    );
    const payload = toolText(got.body);
    report.outlookFinance.get = {
      httpStatus: got.httpStatus,
      error: got.body?.error ?? payload?.error ?? null,
      usedListId: true,
      hasBody: Boolean(payload?.body || payload?.bodyPreview || payload?.message?.body),
    };
  }
  report.elvex.qa = await runQaSequences(token, "service agreement", "site inspection report");
  report.elvex.catalogue = await catalogue(token);
  await revoke(minted.refreshToken);
} catch (error) {
  report.elvex.error = error instanceof Error ? error.message : String(error);
}

try {
  const minted = await mint(TESTER_USER, "co_caddington", TESTER_MEM);
  if (!minted.accessToken) throw new Error(`tester token ${minted.httpStatus}`);
  const token = minted.accessToken;
  await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 10);
  report.caddington.catalogue = await catalogue(token);
  report.caddington.qa = await runQaSequences(token, "staff handbook", "health and safety policy");
  await revoke(minted.refreshToken);
} catch (error) {
  report.caddington.error = error instanceof Error ? error.message : String(error);
}

report.officeStaff.role = setWilliamRole("office_staff");
try {
  const minted = await mint(WILLIAM_USER, "co_el", WILLIAM_MEM);
  if (minted.accessToken) {
    const token = minted.accessToken;
    await mcp(token, "initialize", { protocolVersion: "2025-03-26" }, 40);
    const listed = await mcp(token, "tools/list", {}, 41);
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    report.officeStaff.xeroTools = names.filter((name) => name.startsWith("xero_") || name.includes("xero"));
    const denied = await mcp(token, "tools/call", { name: "xero_sales_summary", arguments: { period: "today" } }, 42);
    report.officeStaff.salesCall = {
      httpStatus: denied.httpStatus,
      error: denied.body?.error ?? null,
      text: toolText(denied.body),
    };
    await revoke(minted.refreshToken);
  }
} catch (error) {
  report.officeStaff.error = error instanceof Error ? error.message : String(error);
}

report.finalWilliam = d1(`SELECT role, updated_at FROM company_memberships WHERE id='${WILLIAM_MEM}';`)[0];
if (report.finalWilliam?.role !== "office_staff") {
  report.finalWilliam = { role: setWilliamRole("office_staff"), forced: true };
}
report.testerRoleAfter = d1(`SELECT role FROM company_memberships WHERE id='${TESTER_MEM}';`)[0]?.role;
report.oauthStillValid = Boolean(
  d1(
    `SELECT id FROM oauth_refresh_tokens WHERE user_id='${WILLIAM_USER}' AND company_id='co_el' AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1;`,
  )[0]?.id,
);

const qaScore = (block) => {
  const seq = block?.sequences ?? [];
  return {
    ran: seq.length,
    searchEmpty: seq.filter((row) => row.class === "SEARCH_EMPTY").length,
    answered: seq.filter((row) => row.direct?.hasAnswer).length,
    followAnswered: seq.filter((row) => row.follow?.hasAnswer).length,
    none: seq.filter((row) => row.noResults).length,
    followNone: seq.filter((row) => row.followNone).length,
  };
};
report.scores = {
  elvex: qaScore(report.elvex.qa),
  caddington: qaScore(report.caddington.qa),
};

writeFileSync("/tmp/capability-remaining-live.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
