#!/usr/bin/env node
/**
 * Caddington Phase 1 Operational UAT — genuine production MCP path.
 * Mints a short-lived ChatGPT identity with the SAME scopes as the live
 * customer ChatGPT identity. Never prints tokens or document bodies.
 * Cleans up the identity and any probe automation.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = "/tmp/caddington-phase1-uat-evidence.json";

const LIVE_CHATGPT_SCOPES = [
  "knowledge.search",
  "knowledge.read",
  "system.health",
  "xero.organisation.read",
  "xero.contacts.read",
  "xero.contacts.search",
  "xero.invoices.read",
  "xero.invoices.search",
  "xero.invoices.get",
  "xero.payments.read",
  "xero.accounts.read",
  "xero.bank_transactions.read",
  "xero.reports.pnl.read",
  "xero.reports.balance_sheet.read",
  "xero.reports.aged.read",
  "xero.sales.summary",
  "xero.top_customers",
  "xero.top_suppliers",
  "xero.list_tax_rates",
  "xero.vat.capability",
  "xero.health",
  "xero.token_refresh",
  "xero.action.plan",
  "xero.action.read",
  "xero.action.confirm",
  "xero.action.execute",
  "xero.action.cancel",
  "xero.action.list",
];

const EXPECTED_AUTOMATION_TOOLS = [
  "automation_list",
  "automation_get",
  "automation_plan",
  "automation_create",
  "automation_plan_update",
  "automation_update",
  "automation_pause",
  "automation_resume",
  "automation_run_now",
  "automation_delete",
];

const DIRECT_XERO_WRITES = [
  "xero_create_draft_invoice",
  "xero_create_credit_note",
  "xero_approve_invoice",
  "xero_send_invoice",
  "xero_create_draft_bill",
];

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const id = `svc_uat_p1_${Date.now()}`;
const hash = createHash("sha256").update(token).digest("hex");
const now = new Date().toISOString();
const sqlFile = join(apiDir, ".tmp-phase1-uat.sql");

function d1File(sql) {
  writeFileSync(sqlFile, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
    { cwd: apiDir, stdio: "pipe" },
  );
}

function d1Json(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)?.[0]?.results ?? [];
}

async function mcp(method, params, rpcId, extra = {}) {
  const body = { jsonrpc: "2.0", id: rpcId, method, params: params ?? {} };
  if (extra.companyId) body.params = { ...body.params, companyId: extra.companyId };
  const res = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { http: res.status, json };
}

function toolText(body) {
  const text = body?.result?.content?.find?.((p) => p.type === "text")?.text;
  if (!text) return { error: body?.error ?? null, raw: null };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 240) };
  }
}

function summariseHits(payload) {
  const hits = payload?.results ?? payload?.hits ?? payload?.documents ?? payload?.matches ?? [];
  if (!Array.isArray(hits)) return { count: 0, sources: {}, titles: [] };
  const sources = {};
  const titles = [];
  for (const hit of hits.slice(0, 8)) {
    const meta = hit.metadata && typeof hit.metadata === "object" ? hit.metadata : {};
    const source =
      hit.sourceType ||
      hit.source_type ||
      meta.sourceType ||
      meta.source_type ||
      hit.source ||
      meta.source ||
      "unknown";
    sources[String(source)] = (sources[String(source)] ?? 0) + 1;
    titles.push({
      id: String(hit.id ?? hit.documentId ?? hit.document_id ?? "").slice(0, 80),
      title: String(hit.title ?? hit.name ?? hit.filename ?? "").slice(0, 80),
      source: String(source),
    });
  }
  return { count: hits.length, sources, titles };
}

function summariseXero(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const key of [
    "organisationName",
    "organisationId",
    "legalName",
    "baseCurrency",
    "fromDate",
    "toDate",
    "totalSales",
    "netSales",
    "invoiceCount",
    "creditNoteCount",
    "currency",
    "status",
    "connected",
    "error",
    "code",
  ]) {
    if (payload[key] != null) out[key] = payload[key];
  }
  if (payload.totals && typeof payload.totals === "object") {
    out.totals = payload.totals;
  }
  if (payload.period) out.period = payload.period;
  if (!Object.keys(out).length) {
    out.keys = Object.keys(payload).slice(0, 20);
  }
  return out;
}

function hasRpcError(resp) {
  return Boolean(resp.json?.error);
}

const evidence = {
  startedAt: now,
  identityId: id,
  identityScopes: LIVE_CHATGPT_SCOPES,
  tests: {},
};

d1File(`INSERT INTO service_identities (
  id, company_id, name, description, status, secret_ref,
  identity_type, token_hash, token_prefix, last_used_at, request_count,
  scopes_json, mcp_environment_id, created_at, updated_at
) VALUES (
  '${id}', 'co_caddington', 'TEMP Phase 1 Operational UAT',
  'Short-lived ChatGPT-equivalent identity for Caddington Phase 1 UAT. Disable after run.',
  'active', NULL, 'chatgpt', '${hash}', '${token.slice(0, 12)}',
  NULL, 0, '${JSON.stringify(LIVE_CHATGPT_SCOPES).replace(/'/g, "''")}',
  'mcp_caddington_primary', '${now}', '${now}'
);`);

try {
  const noAuth = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
  });
  evidence.tests.mcp_unauthenticated = {
    http: noAuth.status,
    denied: noAuth.status === 401 || noAuth.status === 403,
  };

  const badTok = await fetch(`${API}/api/gateway/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: "Bearer infra_invalid_uat_token",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
  });
  evidence.tests.mcp_invalid_token = {
    http: badTok.status,
    denied: badTok.status === 401 || badTok.status === 403,
  };

  const init = await mcp("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "phase1-uat", version: "1" } }, 1);
  evidence.tests.mcp_initialize = {
    http: init.http,
    ok: init.http === 200 && !hasRpcError(init),
    protocolVersion: init.json?.result?.protocolVersion ?? null,
    serverName: init.json?.result?.serverInfo?.name ?? null,
  };

  const listed = await mcp("tools/list", {}, 2);
  const tools = (listed.json?.result?.tools ?? []).map((t) => t.name).sort();
  const missingAutomation = EXPECTED_AUTOMATION_TOOLS.filter((n) => !tools.includes(n));
  const leakedWrites = DIRECT_XERO_WRITES.filter((n) => tools.includes(n));
  evidence.tests.mcp_tools_list = {
    http: listed.http,
    ok: listed.http === 200 && !hasRpcError(listed),
    toolCount: tools.length,
    tools,
    hasSearch: tools.includes("search") || tools.includes("search_company_knowledge"),
    hasFetch: tools.includes("fetch") || tools.includes("get_knowledge_document"),
    hasSystemHealth: tools.includes("system_health"),
    hasXeroRead: tools.includes("xero_get_organisation") && tools.includes("xero_sales_summary"),
    hasActionPlan: tools.includes("plan_xero_draft_invoice"),
    hasAutomation: missingAutomation.length === 0,
    missingAutomation,
    leakedDirectXeroWrites: leakedWrites,
  };

  const health = await mcp("tools/call", { name: "system_health", arguments: {} }, 3);
  const healthBody = toolText(health.json);
  evidence.tests.system_health = {
    http: health.http,
    ok: health.http === 200 && !hasRpcError(health) && !healthBody.error,
    payload: summariseXero(healthBody),
  };

  const searchQueries = [
    { key: "knowledge_search_general", query: "Caddington", limit: 8 },
    { key: "knowledge_search_drive", query: "invoice contract policy", limit: 8 },
    { key: "knowledge_search_microsoft", query: "SharePoint OneDrive Outlook", limit: 8 },
  ];
  let fetchId = null;
  for (const q of searchQueries) {
    const resp = await mcp(
      "tools/call",
      { name: "search_company_knowledge", arguments: { query: q.query, limit: q.limit } },
      10 + searchQueries.indexOf(q),
    );
    const body = toolText(resp.json);
    const summary = summariseHits(body);
    evidence.tests[q.key] = {
      http: resp.http,
      ok: resp.http === 200 && !hasRpcError(resp) && !body.error,
      hitCount: summary.count,
      sources: summary.sources,
      sampleTitles: summary.titles,
    };
    if (!fetchId && summary.titles[0]?.id) fetchId = summary.titles[0].id;
  }

  const stdSearch = await mcp("tools/call", { name: "search", arguments: { query: "Caddington" } }, 20);
  const stdBody = toolText(stdSearch.json);
  const stdSummary = summariseHits(stdBody);
  evidence.tests.knowledge_search_standard = {
    http: stdSearch.http,
    ok: stdSearch.http === 200 && !hasRpcError(stdSearch) && !stdBody.error,
    hitCount: stdSummary.count,
    sources: stdSummary.sources,
  };
  if (!fetchId && stdSummary.titles[0]?.id) fetchId = stdSummary.titles[0].id;

  if (fetchId) {
    const fetched = await mcp("tools/call", { name: "fetch", arguments: { id: fetchId } }, 21);
    const fetchedBody = toolText(fetched.json);
    const content =
      fetchedBody?.content ?? fetchedBody?.text ?? fetchedBody?.document ?? fetchedBody?.body ?? "";
    evidence.tests.knowledge_fetch = {
      http: fetched.http,
      ok: fetched.http === 200 && !hasRpcError(fetched) && !fetchedBody.error,
      idPrefix: String(fetchId).slice(0, 24),
      hasTitle: Boolean(fetchedBody?.title || fetchedBody?.name),
      contentChars: typeof content === "string" ? content.length : 0,
      source:
        fetchedBody?.sourceType ||
        fetchedBody?.source_type ||
        fetchedBody?.metadata?.sourceType ||
        fetchedBody?.metadata?.source ||
        null,
    };
  } else {
    evidence.tests.knowledge_fetch = { ok: false, skipped: "no search hit id" };
  }

  const org = await mcp("tools/call", { name: "xero_get_organisation", arguments: {} }, 30);
  evidence.tests.xero_get_organisation = {
    http: org.http,
    ok: org.http === 200 && !hasRpcError(org),
    payload: summariseXero(toolText(org.json)),
  };

  const sales = await mcp(
    "tools/call",
    { name: "xero_sales_summary", arguments: { fromDate: "2026-08-01", toDate: "2026-08-29" } },
    31,
  );
  evidence.tests.xero_sales_summary = {
    http: sales.http,
    ok: sales.http === 200 && !hasRpcError(sales),
    payload: summariseXero(toolText(sales.json)),
  };

  const pnl = await mcp(
    "tools/call",
    { name: "xero_profit_and_loss", arguments: { fromDate: "2026-08-01", toDate: "2026-08-29" } },
    32,
  );
  evidence.tests.xero_profit_and_loss = {
    http: pnl.http,
    ok: pnl.http === 200 && !hasRpcError(pnl),
    payload: summariseXero(toolText(pnl.json)),
  };

  const xeroHealth = await mcp("tools/call", { name: "xero_connection_test", arguments: {} }, 33);
  evidence.tests.xero_connection_test = {
    http: xeroHealth.http,
    ok: xeroHealth.http === 200 && !hasRpcError(xeroHealth),
    payload: summariseXero(toolText(xeroHealth.json)),
  };

  const directWrite = await mcp(
    "tools/call",
    {
      name: "xero_create_draft_invoice",
      arguments: {
        contactName: "INFRA UAT MUST NOT WRITE",
        lineItems: [{ description: "UAT blocked write", quantity: 1, unitAmount: 1 }],
      },
    },
    34,
  );
  const directBody = toolText(directWrite.json);
  evidence.tests.xero_direct_write_blocked = {
    http: directWrite.http,
    ok:
      hasRpcError(directWrite) ||
      Boolean(directBody.error) ||
      directBody.code === "ACTION_ENGINE_REQUIRED" ||
      /Action Engine|not found|denied|forbidden/i.test(JSON.stringify(directBody).slice(0, 400)),
    code: directBody.code ?? directWrite.json?.error?.data?.errorCode ?? null,
    message: String(directBody.error ?? directWrite.json?.error?.message ?? "").slice(0, 200),
  };

  const planWrite = await mcp(
    "tools/call",
    {
      name: "plan_xero_draft_invoice",
      arguments: {
        contactName: "INFRA UAT MUST NOT WRITE",
        reference: "INFRA-UAT-NOEXEC-20260829",
        lineItems: [{ description: "UAT plan only — do not execute", quantity: 1, unitAmount: 1 }],
      },
    },
    35,
  );
  const planBody = toolText(planWrite.json);
  const planId = planBody.planId || planBody.plan_id || planBody.id || null;
  evidence.tests.xero_write_plan = {
    http: planWrite.http,
    ok: planWrite.http === 200 && !hasRpcError(planWrite),
    created: Boolean(planId),
    planId: planId ? String(planId).slice(0, 40) : null,
    status: planBody.status ?? planBody.confirmationStatus ?? null,
    requiresConfirmation: Boolean(
      planBody.confirmationToken || planBody.confirmation_token || planBody.requiresConfirmation,
    ),
    executed: Boolean(planBody.executed || planBody.xeroInvoiceId),
  };

  if (planId) {
    const execBare = await mcp(
      "tools/call",
      { name: "execute_action_plan", arguments: { planId } },
      36,
    );
    const execBody = toolText(execBare.json);
    evidence.tests.xero_execute_without_confirm = {
      http: execBare.http,
      ok:
        hasRpcError(execBare) ||
        Boolean(execBody.error) ||
        /confirm|denied|forbidden|required/i.test(JSON.stringify(execBody).slice(0, 400)),
      code: execBody.code ?? null,
      message: String(execBody.error ?? execBare.json?.error?.message ?? "").slice(0, 200),
    };
    const cancel = await mcp(
      "tools/call",
      { name: "cancel_action_plan", arguments: { planId } },
      37,
    );
    const cancelBody = toolText(cancel.json);
    evidence.tests.xero_write_plan_cancelled = {
      http: cancel.http,
      ok: cancel.http === 200 && !hasRpcError(cancel) && !cancelBody.error,
      status: cancelBody.status ?? null,
    };
  }

  const autoList = await mcp("tools/call", { name: "automation_list", arguments: {} }, 40);
  const autoListBody = toolText(autoList.json);
  const automations = Array.isArray(autoListBody.automations) ? autoListBody.automations : [];
  evidence.tests.automation_list = {
    http: autoList.http,
    ok: autoList.http === 200 && !hasRpcError(autoList) && !autoListBody.error,
    count: automations.length,
    items: automations.map((a) => ({
      automationId: a.automationId,
      name: a.name,
      status: a.status,
      schedule: a.schedule,
      createdVia: a.createdVia ?? null,
      recipient: a.recipient ?? null,
    })),
    managementUrl: autoListBody.managementUrl ?? null,
  };

  const salesId = "aut_4aaad1ae-8494-40ea-b606-75aab871db58";
  const docsId = "aut_df4dcc96-2a1a-418f-8285-aafa134b3f99";
  const getSales = await mcp("tools/call", { name: "automation_get", arguments: { automationId: salesId } }, 41);
  const getDocs = await mcp("tools/call", { name: "automation_get", arguments: { automationId: docsId } }, 42);
  evidence.tests.automation_get_sales = {
    http: getSales.http,
    ok: getSales.http === 200 && !hasRpcError(getSales),
    automation: toolText(getSales.json).automation ?? null,
  };
  evidence.tests.automation_get_docs = {
    http: getDocs.http,
    ok: getDocs.http === 200 && !hasRpcError(getDocs),
    automation: toolText(getDocs.json).automation ?? null,
  };

  const dupPlan = await mcp(
    "tools/call",
    {
      name: "automation_plan",
      arguments: {
        name: "Daily month-to-date sales",
        templateKey: "xero_month_to_date_sales_email",
        frequency: "daily",
        time: "08:00",
        timezone: "Europe/London",
        recipientEmail: "daniel.dwyer123@gmail.com",
      },
    },
    43,
  );
  const dupPlanBody = toolText(dupPlan.json);
  evidence.tests.automation_plan_duplicate_warning = {
    http: dupPlan.http,
    ok: dupPlan.http === 200 && !hasRpcError(dupPlan) && !dupPlanBody.error,
    planId: dupPlanBody.planId ?? dupPlanBody.plan?.id ?? null,
    duplicate: Boolean(
      dupPlanBody.duplicate ||
        dupPlanBody.duplicateWarning ||
        dupPlanBody.existingAutomationId ||
        dupPlanBody.warnings,
    ),
    created: Boolean(dupPlanBody.created || dupPlanBody.automationId),
  };

  const noConfirm = await mcp(
    "tools/call",
    {
      name: "automation_create",
      arguments: {
        planId: dupPlanBody.planId ?? dupPlanBody.plan?.id ?? "plan_missing",
        confirmationToken: dupPlanBody.confirmationToken ?? "tok_missing",
      },
    },
    44,
  );
  const noConfirmBody = toolText(noConfirm.json);
  evidence.tests.automation_create_without_confirm = {
    http: noConfirm.http,
    ok:
      noConfirmBody.code === "CONFIRMATION_REQUIRED" ||
      /confirm/i.test(String(noConfirmBody.error ?? "")),
    code: noConfirmBody.code ?? null,
    created: Boolean(noConfirmBody.created),
  };

  const dupCreate = await mcp(
    "tools/call",
    {
      name: "automation_create",
      arguments: {
        planId: dupPlanBody.planId ?? dupPlanBody.plan?.id ?? "plan_missing",
        confirmationToken: dupPlanBody.confirmationToken,
        confirmed: true,
      },
    },
    45,
  );
  const dupCreateBody = toolText(dupCreate.json);
  evidence.tests.automation_create_duplicate_blocked = {
    http: dupCreate.http,
    ok:
      dupCreateBody.code === "DUPLICATE_AUTOMATION" ||
      /duplicate/i.test(String(dupCreateBody.error ?? "")),
    code: dupCreateBody.code ?? null,
    created: Boolean(dupCreateBody.created),
  };

  const htSpoof = await mcp(
    "tools/call",
    { name: "automation_list", arguments: {} },
    46,
    { companyId: "co_ht" },
  );
  const elSpoof = await mcp(
    "tools/call",
    { name: "search_company_knowledge", arguments: { query: "secret", limit: 1 } },
    47,
    { companyId: "co_el" },
  );
  evidence.tests.isolation_ht_spoof = {
    http: htSpoof.http,
    denied: htSpoof.http === 403 || Boolean(htSpoof.json?.error) || toolText(htSpoof.json).code === "AUTOMATION_FORBIDDEN",
    message: String(htSpoof.json?.error?.message ?? toolText(htSpoof.json).error ?? "").slice(0, 160),
  };
  evidence.tests.isolation_el_spoof = {
    http: elSpoof.http,
    denied: elSpoof.http === 403 || Boolean(elSpoof.json?.error),
    message: String(elSpoof.json?.error?.message ?? toolText(elSpoof.json).error ?? "").slice(0, 160),
  };

  const probePlan = await mcp(
    "tools/call",
    {
      name: "automation_plan",
      arguments: {
        name: "Phase 1 UAT probe (delete)",
        templateKey: "document_activity_daily_email",
        frequency: "daily",
        time: "05:17",
        timezone: "Europe/London",
        recipientEmail: "daniel.dwyer123@gmail.com",
      },
    },
    50,
  );
  const probePlanBody = toolText(probePlan.json);
  evidence.tests.automation_plan_unique = {
    http: probePlan.http,
    ok: probePlan.http === 200 && !hasRpcError(probePlan) && !probePlanBody.error,
    planId: probePlanBody.planId ?? probePlanBody.plan?.id ?? null,
    duplicate: Boolean(probePlanBody.duplicate || probePlanBody.existingAutomationId),
  };

  let probeId = null;
  if (probePlanBody.planId && probePlanBody.confirmationToken) {
    const created = await mcp(
      "tools/call",
      {
        name: "automation_create",
        arguments: {
          planId: probePlanBody.planId,
          confirmationToken: probePlanBody.confirmationToken,
          confirmed: true,
        },
      },
      51,
    );
    const createdBody = toolText(created.json);
    probeId = createdBody.automationId ?? null;
    evidence.tests.automation_create_probe = {
      http: created.http,
      ok: created.http === 200 && createdBody.created === true && Boolean(probeId),
      automationId: probeId,
      createdVia: "chatgpt",
      status: createdBody.status ?? null,
    };
  }

  if (probeId) {
    const paused = await mcp(
      "tools/call",
      { name: "automation_pause", arguments: { automationId: probeId } },
      52,
    );
    evidence.tests.automation_pause = {
      http: paused.http,
      ok: paused.http === 200 && !hasRpcError(paused) && !toolText(paused.json).error,
      status: toolText(paused.json).status ?? toolText(paused.json).automation?.status ?? null,
    };

    const updPlan = await mcp(
      "tools/call",
      {
        name: "automation_plan_update",
        arguments: { automationId: probeId, time: "05:19" },
      },
      53,
    );
    const updPlanBody = toolText(updPlan.json);
    evidence.tests.automation_plan_update = {
      http: updPlan.http,
      ok: updPlan.http === 200 && !hasRpcError(updPlan) && !updPlanBody.error,
      planId: updPlanBody.planId ?? null,
    };
    if (updPlanBody.planId && updPlanBody.confirmationToken) {
      const updated = await mcp(
        "tools/call",
        {
          name: "automation_update",
          arguments: {
            planId: updPlanBody.planId,
            confirmationToken: updPlanBody.confirmationToken,
            confirmed: true,
          },
        },
        54,
      );
      evidence.tests.automation_update = {
        http: updated.http,
        ok: updated.http === 200 && !hasRpcError(updated) && !toolText(updated.json).error,
        status: toolText(updated.json).status ?? null,
        schedule: toolText(updated.json).schedule ?? null,
      };
    }

    const resumed = await mcp(
      "tools/call",
      { name: "automation_resume", arguments: { automationId: probeId } },
      55,
    );
    evidence.tests.automation_resume = {
      http: resumed.http,
      ok: resumed.http === 200 && !hasRpcError(resumed) && !toolText(resumed.json).error,
      status: toolText(resumed.json).status ?? toolText(resumed.json).automation?.status ?? null,
    };

    const deleted = await mcp(
      "tools/call",
      { name: "automation_delete", arguments: { automationId: probeId, confirmed: true } },
      56,
    );
    evidence.tests.automation_delete = {
      http: deleted.http,
      ok: deleted.http === 200 && !hasRpcError(deleted) && !toolText(deleted.json).error,
      status: toolText(deleted.json).status ?? "archived",
    };
  }

  const portalNoAuth = await fetch(`${API}/api/companies/caddington-holdings/automations`, {
    headers: { Accept: "application/json" },
  });
  evidence.tests.portal_automations_unauthenticated = {
    http: portalNoAuth.status,
    denied: portalNoAuth.status === 401 || portalNoAuth.status === 403,
  };

  const walletNoAuth = await fetch(`${API}/api/companies/caddington-holdings/wallet`, {
    headers: { Accept: "application/json" },
  });
  evidence.tests.portal_wallet_unauthenticated = {
    http: walletNoAuth.status,
    denied: walletNoAuth.status === 401 || walletNoAuth.status === 403,
  };

  evidence.finishedAt = new Date().toISOString();
} finally {
  d1File(`UPDATE service_identities SET status = 'disabled', updated_at = datetime('now') WHERE id = '${id}';
UPDATE service_identities SET status = 'disabled', updated_at = datetime('now')
 WHERE id IN (
   'svc_probe_bdf5c09aa36f3b89',
   'svc_write_alpha_ff25a34f',
   'svc_write_alpha_9016f77e'
 ) AND status = 'active';`);
  try {
    unlinkSync(sqlFile);
  } catch {
    // ignore
  }
}

const leftover = d1Json(
  "SELECT id, name, status FROM automation_definitions WHERE company_id='co_caddington' AND name LIKE '%Phase 1 UAT%'",
);
evidence.cleanup = {
  uatIdentityDisabled: true,
  leftoverProbeAutomations: leftover,
};

writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
process.stdout.write(`${evidencePath}\n`);
for (const [name, result] of Object.entries(evidence.tests)) {
  const flag = result.ok === true || result.denied === true ? "OK" : "CHECK";
  process.stdout.write(`${flag}\t${name}\n`);
}
