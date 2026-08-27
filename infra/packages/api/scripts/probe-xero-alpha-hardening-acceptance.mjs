#!/usr/bin/env node
/**
 * Read-only Xero alpha hardening acceptance — verifies repaired READ capabilities.
 * Creates temporary service identity, runs probes, deletes identity.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://infra-api.daniel-dwyer123.workers.dev";
const COMPANY_ID = "co_caddington";
const MCP_ID = "mcp_caddington_primary";
const EFFECTIVE = "2026-08-27";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function hashServiceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const token = `infra_${Buffer.from(randomBytes(24)).toString("base64url")}`;
const prefix = token.slice(0, 12);
const id = `svc_probe_${randomBytes(8).toString("hex")}`;
const now = new Date().toISOString();
const scopes = JSON.stringify([
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
]);

const sqlFile = join(apiDir, ".tmp-xero-alpha-acceptance.sql");
writeFileSync(
  sqlFile,
  `INSERT INTO service_identities (id, company_id, name, description, status, secret_ref, identity_type, token_hash, token_prefix, last_used_at, request_count, scopes_json, mcp_environment_id, created_at, updated_at) VALUES ('${id}', '${COMPANY_ID}', 'TEMP alpha hardening probe', 'auto cleanup', 'active', NULL, 'chatgpt', '${hashServiceToken(token)}', '${prefix}', NULL, 0, '${scopes.replace(/'/g, "''")}', '${MCP_ID}', '${now}', '${now}');`,
);
execFileSync("npx", ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile], {
  cwd: apiDir,
  stdio: "inherit",
});
unlinkSync(sqlFile);

async function execute(toolName, arguments_ = {}) {
  const res = await fetch(`${API}/api/gateway/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      companyId: COMPANY_ID,
      toolName,
      arguments: arguments_,
      sourceClient: "xero-alpha-hardening-probe",
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function jsonHasRawDotNetDate(value) {
  if (value == null) return false;
  if (typeof value === "string") return /^\/Date\(\d+/.test(value);
  if (Array.isArray(value)) return value.some(jsonHasRawDotNetDate);
  if (typeof value === "object") return Object.values(value).some(jsonHasRawDotNetDate);
  return false;
}

const results = {};

results.julySales = await execute("xero_sales_summary", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
});
results.febJulSales = await execute("xero_sales_summary", {
  fromDate: "2026-02-01",
  toDate: "2026-07-31",
});
results.topCustomers = await execute("xero_top_customers", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
  limit: 5,
});
results.overdue = await execute("xero_list_overdue_invoices", {
  effectiveDate: EFFECTIVE,
  limit: 50,
});
results.julyPayments = await execute("xero_list_payments", {
  since: "2026-07-01",
  toDate: "2026-07-31",
  direction: "customer_receipt",
  limit: 100,
});
results.outstandingSales = await execute("xero_search_invoices", {
  unpaidOnly: true,
  invoiceType: "ACCREC",
  limit: 50,
});
results.outstandingBills = await execute("xero_search_invoices", {
  unpaidOnly: true,
  invoiceType: "ACCPAY",
  limit: 50,
});
results.topSuppliers = await execute("xero_top_suppliers", {
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
  limit: 5,
});
results.agedReceivables = await execute("xero_aged_receivables", {
  reportType: "receivables",
  date: EFFECTIVE,
});
results.agedPayables = await execute("xero_aged_receivables", {
  reportType: "payables",
  date: EFFECTIVE,
});
results.vatCapability = await execute("xero_vat_capability");

writeFileSync(
  join(apiDir, ".tmp-xero-alpha-acceptance-cleanup.sql"),
  `DELETE FROM service_identities WHERE id = '${id}';`,
);
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", join(apiDir, ".tmp-xero-alpha-acceptance-cleanup.sql")],
  { cwd: apiDir, stdio: "inherit" },
);
unlinkSync(join(apiDir, ".tmp-xero-alpha-acceptance-cleanup.sql"));

function salesSummary(r) {
  const s = r.body?.result?.summary ?? r.body?.result ?? {};
  return {
    ok: r.status === 200,
    count: s.transactionCount ?? s.summary?.transactionCount,
    total: s.totalSales ?? s.summary?.totalSales,
  };
}

const overdueInvoices = results.overdue.body?.result?.invoices ?? [];
const julyPayments = results.julyPayments.body?.result?.payments ?? [];
const outstandingSales = results.outstandingSales.body?.result?.invoices ?? [];
const outstandingBills = results.outstandingBills.body?.result?.invoices ?? [];

const report = {
  julySales: salesSummary(results.julySales),
  febJulSales: salesSummary(results.febJulSales),
  topCustomers: {
    ok: results.topCustomers.status === 200,
    customers: results.topCustomers.body?.result?.customers ?? [],
  },
  overdue: {
    ok: results.overdue.status === 200,
    count: overdueInvoices.length,
    hasAccpay: overdueInvoices.some((i) => i.documentType === "supplier_bill" || i.invoiceType === "ACCPAY"),
    hasFutureDue: overdueInvoices.some((i) => i.dueDate && i.dueDate >= EFFECTIVE),
    semantics: results.overdue.body?.result?.meta?.semantics,
  },
  julyPayments: {
    ok: results.julyPayments.status === 200,
    count: julyPayments.length,
    totalAmount: results.julyPayments.body?.result?.totalAmount,
    augustLeak: julyPayments.some((p) => p.paymentDate && p.paymentDate.startsWith("2026-08")),
    juneLeak: julyPayments.some((p) => p.paymentDate && p.paymentDate < "2026-07-01"),
  },
  outstandingSales: {
    ok: results.outstandingSales.status === 200,
    accpayLeak: outstandingSales.some((i) => i.documentType === "supplier_bill"),
  },
  outstandingBills: {
    ok: results.outstandingBills.status === 200,
    accrecLeak: outstandingBills.some((i) => i.documentType === "sales_invoice"),
  },
  topSuppliers: {
    ok: results.topSuppliers.status === 200,
    suppliers: results.topSuppliers.body?.result?.suppliers ?? [],
  },
  agedReceivables: {
    ok: results.agedReceivables.status === 200,
    implementation: results.agedReceivables.body?.result?.meta?.implementation,
    totalOutstanding: results.agedReceivables.body?.result?.report?.totalOutstanding,
  },
  agedPayables: {
    ok: results.agedPayables.status === 200,
    totalOutstanding: results.agedPayables.body?.result?.report?.totalOutstanding,
  },
  vatCapability: {
    ok: results.vatCapability.status === 200,
    officialVatReturnAccessible:
      results.vatCapability.body?.result?.officialVatReturnAccessible,
    message: results.vatCapability.body?.result?.message,
  },
  rawDateLeak: Object.entries(results)
    .filter(([_, r]) => r.status === 200)
    .some(([_, r]) => jsonHasRawDotNetDate(r.body?.result)),
};

console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!report.julySales.ok || report.julySales.count !== 3 || report.julySales.total !== 8100) {
  failures.push("July sales regression");
}
if (!report.febJulSales.ok || report.febJulSales.total !== 8100) {
  failures.push("Feb-Jul sales regression");
}
if (report.overdue.hasAccpay || report.overdue.hasFutureDue) {
  failures.push("Overdue still includes bills or future-due invoices");
}
if (report.julyPayments.augustLeak || report.julyPayments.juneLeak) {
  failures.push("July payments date filter leak");
}
if (report.outstandingSales.accpayLeak || report.outstandingBills.accrecLeak) {
  failures.push("ACCREC/ACCPAY type filter leak");
}
if (!report.outstandingSales.ok || !report.outstandingBills.ok) {
  failures.push("Outstanding invoice probes failed");
}
if (!report.topSuppliers.ok) {
  failures.push("Supplier ranking failed");
}
if (!report.vatCapability.ok) {
  failures.push("VAT capability probe failed");
}
if (report.rawDateLeak) {
  failures.push("Raw /Date(...)/ leak in responses");
}

if (failures.length) {
  console.error("FAILURES:", failures.join("; "));
  process.exit(1);
}

console.log("ALPHA HARDENING ACCEPTANCE: PASS");
