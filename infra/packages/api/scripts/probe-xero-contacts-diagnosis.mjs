#!/usr/bin/env node
/**
 * Read-only diagnosis of xero_list_contacts on production.
 * Uses ChatGPT-equivalent scopes (infra_1HS3Nn). Does NOT mutate Xero.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const MCP = `${API}/api/gateway/v1/mcp`;
const EXEC = `${API}/api/gateway/v1/execute`;
const COMPANY_ID = "co_caddington";
const MCP_ID = "mcp_caddington_primary";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHATGPT_SCOPES = [
  "system.health",
  "knowledge.search",
  "knowledge.read",
  "xero.organisation.read",
  "xero.contacts.search",
  "xero.contacts.read",
  "xero.invoices.search",
  "xero.invoices.read",
  "xero.payments.read",
  "xero.accounts.read",
  "xero.banktransactions.read",
  "xero.reports.pnl.read",
  "xero.reports.balance.read",
  "xero.reports.aged.read",
  "xero.sales.summary",
  "xero.action.plan",
  "xero.action.confirm",
  "xero.action.execute",
  "xero.action.status",
  "xero.action.list",
];

function hashServiceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function d1ExecuteFile(file) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", file],
    { cwd: apiDir, stdio: "pipe" },
  );
}

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const hash = hashServiceToken(token);
const prefix = token.slice(0, 12);
const now = new Date().toISOString();
const scopesJson = JSON.stringify(CHATGPT_SCOPES).replace(/'/g, "''");

const sqlFile = join(apiDir, ".tmp-contact-diagnosis.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', '${COMPANY_ID}', 'TEMP contact diagnosis', 'Auto cleanup', 'active', NULL, 'chatgpt', '${hash}', '${prefix}', NULL, 0, '${scopesJson}', '${MCP_ID}', '${now}', '${now}');`,
);
d1ExecuteFile(sqlFile);

async function mcpCall(method, params, rpcId) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { httpStatus: res.status, body, rawText: text.slice(0, 1000) };
}

async function executeCall(toolName, args = {}) {
  const res = await fetch(EXEC, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      companyId: COMPANY_ID,
      toolName,
      arguments: args,
      sourceClient: "contact-diagnosis-probe",
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { httpStatus: res.status, body, rawText: text.slice(0, 1000) };
}

function toolText(mcpBody) {
  const text = mcpBody?.result?.content?.find?.((p) => p.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function summarizeContacts(payload) {
  if (!payload) return null;
  const contacts = payload.contacts ?? payload.result?.contacts;
  if (!Array.isArray(contacts)) return { hasContacts: false, keys: Object.keys(payload) };
  return {
    count: contacts.length,
    samples: contacts.slice(0, 3).map((c) => ({
      ContactID: c.ContactID,
      Name: c.Name,
      ContactStatus: c.ContactStatus,
    })),
  };
}

const report = { probeIdentity: { id, prefix }, tests: {} };

try {
  await mcpCall("initialize", { protocolVersion: "2025-03-26" }, 1);

  const toolList = await mcpCall("tools/list", {}, 2);
  const toolNames = toolList.body?.result?.tools?.map((t) => t.name) ?? [];
  report.tests.tools_list = {
    httpStatus: toolList.httpStatus,
    toolCount: toolNames.length,
    hasPlanXeroDraftInvoice: toolNames.includes("plan_xero_draft_invoice"),
    hasListContacts: toolNames.includes("xero_list_contacts"),
  };

  const orgMcp = await mcpCall("tools/call", { name: "xero_get_organisation", arguments: {} }, 3);
  report.tests.xero_get_organisation_mcp = {
    httpStatus: orgMcp.httpStatus,
    rpcError: orgMcp.body?.error ?? null,
    organisationName: toolText(orgMcp.body)?.organisationName ?? null,
  };

  const orgExec = await executeCall("xero_get_organisation");
  report.tests.xero_get_organisation_execute = {
    httpStatus: orgExec.httpStatus,
    error: orgExec.body?.error ?? null,
    organisationName: orgExec.body?.result?.organisationName ?? null,
  };

  const unfilteredMcp = await mcpCall(
    "tools/call",
    { name: "xero_list_contacts", arguments: { limit: 5 } },
    4,
  );
  const unfilteredPayload = toolText(unfilteredMcp.body);
  report.tests.xero_list_contacts_unfiltered_mcp = {
    httpStatus: unfilteredMcp.httpStatus,
    rpcError: unfilteredMcp.body?.error ?? null,
    data: unfilteredPayload?.error ? { error: unfilteredPayload.error, code: unfilteredPayload.code } : summarizeContacts(unfilteredPayload),
  };

  const unfilteredExec = await executeCall("xero_list_contacts", { limit: 5 });
  report.tests.xero_list_contacts_unfiltered_execute = {
    httpStatus: unfilteredExec.httpStatus,
    error: unfilteredExec.body?.error ?? null,
    code: unfilteredExec.body?.code ?? null,
    data: summarizeContacts(unfilteredExec.body?.result ?? unfilteredExec.body),
  };

  for (const query of ["Elvex", "Elvex Property Services", "Elvex Property Services Ltd"]) {
    const mcp = await mcpCall(
      "tools/call",
      { name: "xero_list_contacts", arguments: { query, limit: 10 } },
      10 + query.length,
    );
    const payload = toolText(mcp.body);
    report.tests[`xero_list_contacts_search_${query.replace(/\s+/g, "_")}_mcp`] = {
      httpStatus: mcp.httpStatus,
      rpcError: mcp.body?.error ?? null,
      data: payload?.error
        ? { error: payload.error, code: payload.code }
        : summarizeContacts(payload),
    };

    const exec = await executeCall("xero_list_contacts", { query, limit: 10 });
    report.tests[`xero_list_contacts_search_${query.replace(/\s+/g, "_")}_execute`] = {
      httpStatus: exec.httpStatus,
      error: exec.body?.error ?? null,
      code: exec.body?.code ?? null,
      data: summarizeContacts(exec.body?.result ?? exec.body),
    };
  }

  const elvexContacts =
    toolText(
      (
        await mcpCall(
          "tools/call",
          { name: "xero_list_contacts", arguments: { query: "Elvex", limit: 10 } },
          99,
        )
      ).body,
    )?.contacts ?? [];

  if (elvexContacts[0]?.ContactID) {
    const getContact = await mcpCall(
      "tools/call",
      { name: "xero_get_contact", arguments: { contactId: elvexContacts[0].ContactID } },
      100,
    );
    report.tests.xero_get_contact_by_id = {
      httpStatus: getContact.httpStatus,
      contactId: elvexContacts[0].ContactID,
      name: elvexContacts[0].Name,
      payload: toolText(getContact.body)?.contact
        ? { ContactID: toolText(getContact.body).contact.ContactID, Name: toolText(getContact.body).contact.Name }
        : toolText(getContact.body),
    };
  } else {
    report.tests.xero_get_contact_by_id = { skipped: true, reason: "No Elvex ContactID resolved" };
  }
} finally {
  writeFileSync(sqlFile, `DELETE FROM service_identities WHERE id = '${id}';`);
  d1ExecuteFile(sqlFile);
  unlinkSync(sqlFile);
}

console.log(JSON.stringify(report, null, 2));
