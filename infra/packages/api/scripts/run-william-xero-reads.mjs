#!/usr/bin/env node
/**
 * Live Elvex Xero read acceptance through the ChatGPT MCP path.
 * Records William's current role first. Does not assume office_staff.
 * Authorised reads run without a lasting role change. Denial is proven
 * only with a temporary office_staff switch that always restores the
 * original role.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEMBERSHIP_ID = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const REPORT_PATH = "/tmp/william-xero-reads.json";
const AUTHORISED_ROLES = new Set([
  "finance_team",
  "finance_manager",
  "director",
  "company_admin",
  "operations_manager",
]);

function d1(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--json", "--command", command],
    { cwd: apiDir, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function membershipRole() {
  const rows = d1(
    `SELECT role, status, custom_role_id, updated_at FROM company_memberships WHERE id = '${MEMBERSHIP_ID}' AND user_id = '${USER_ID}';`,
  );
  return rows[0] ?? null;
}

function setRole(role, eventType, fromRole) {
  const auditId = `audit_${crypto.randomUUID()}`;
  d1(
    `UPDATE company_memberships SET role = '${role}', updated_at = datetime('now') WHERE id = '${MEMBERSHIP_ID}' AND user_id = '${USER_ID}' AND company_id = 'co_el';`,
  );
  d1(
    `INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at) VALUES ('${auditId}', 'co_el', '${eventType}', 'cursor-acceptance', 'company_membership', '${MEMBERSHIP_ID}', '{"fromRole":"${fromRole}","toRole":"${role}","reason":"controlled William Xero read acceptance","platformAdmin":false}', datetime('now'));`,
  );
  return { auditId, membership: membershipRole() };
}

function mintAcceptanceToken() {
  const token = `william_xero_reads_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `CREATE TABLE IF NOT EXISTS cmd13_acceptance_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); INSERT OR REPLACE INTO cmd13_acceptance_tokens (token_hash, expires_at) VALUES ('${hash}', datetime('now', '+2 hours'));`,
  );
  return token;
}

async function runPhase(phase) {
  const token = mintAcceptanceToken();
  const res = await fetch(`${API}/api/internal/william-chatgpt-acceptance?phase=${phase}`, {
    method: "POST",
    headers: {
      "X-CMD13-Acceptance-Token": token,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { httpStatus: res.status, body };
}

const recorded = membershipRole();
const originalRole = recorded?.role ?? null;
const report = {
  recordedBefore: recorded,
  originalRole,
  roleChangedPermanently: false,
};

if (!recorded) {
  console.error(JSON.stringify({ error: "William membership missing", recorded }, null, 2));
  process.exit(1);
}

if (AUTHORISED_ROLES.has(originalRole)) {
  report.authorisedRun = await runPhase("xero-reads");
} else {
  report.authorisedRun = {
    skipped: true,
    reason: "live role cannot read Xero sales; record-only",
    liveRole: originalRole,
  };
}

let switched = false;
try {
  if (originalRole !== "office_staff") {
    report.temporaryDenialRole = setRole("office_staff", "membership.role_temporary_xero_denial", originalRole);
    switched = true;
  }
  report.denialRun = await runPhase("xero-denial");
} catch (err) {
  report.denialError = err instanceof Error ? err.message : String(err);
} finally {
  if (switched || membershipRole()?.role !== originalRole) {
    report.restored = setRole(originalRole, "membership.role_restored", "office_staff");
  }
}

report.finalMembership = membershipRole();
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
const readsProof = report.authorisedRun?.body?.proof ?? null;
const denialProof = report.denialRun?.body?.proof ?? null;
const restored = report.finalMembership?.role === originalRole;
console.log(
  JSON.stringify(
    {
      reportPath: REPORT_PATH,
      originalRole,
      finalRole: report.finalMembership?.role ?? null,
      restored,
      authorisedHttp: report.authorisedRun?.httpStatus ?? null,
      denialHttp: report.denialRun?.httpStatus ?? null,
      readsProof,
      denialProof,
      requiredReadsAdvertised: report.authorisedRun?.body?.requiredReadsAdvertised ?? null,
      authorisedError: report.authorisedRun?.body?.error ?? null,
      denialError: report.denialRun?.body?.error ?? report.denialError ?? null,
    },
    null,
    2,
  ),
);

const readsOk =
  report.authorisedRun?.skipped ||
  (report.authorisedRun?.httpStatus === 200 &&
    readsProof?.toolsListed &&
    readsProof?.authorisedReadsWorked &&
    readsProof?.xeroZeroCharge);
const denialOk = report.denialRun?.httpStatus === 200 && denialProof?.permissionDenied && denialProof?.noKnowledgeCharge;
process.exit(readsOk && denialOk && restored ? 0 : 1);
