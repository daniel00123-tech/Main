#!/usr/bin/env node
/**
 * Controlled William ChatGPT acceptance runner.
 * Records the live role. William is intended Director — this runner must not
 * leave him as office_staff. Never prints tokens or secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { persistIntendedRole, readIntendedRole, restoreIntendedRole } from "./lib/william-intended-role.mjs";

const API = "https://api.infrastack.app";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEMBERSHIP_ID = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
const USER_ID = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
const ORIGINAL_ROLE = "office_staff";
const TEMP_ROLE = "finance_team";
const REPORT_PATH = "/tmp/william-acceptance-report.json";

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

function setRole(role, eventType) {
  const auditId = `audit_${crypto.randomUUID()}`;
  d1(
    `UPDATE company_memberships SET role = '${role}', updated_at = datetime('now') WHERE id = '${MEMBERSHIP_ID}' AND user_id = '${USER_ID}' AND company_id = 'co_el';`,
  );
  const fromRole = role === TEMP_ROLE ? ORIGINAL_ROLE : TEMP_ROLE;
  d1(
    `INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at) VALUES ('${auditId}', 'co_el', '${eventType}', 'cursor-acceptance', 'company_membership', '${MEMBERSHIP_ID}', '{"fromRole":"${fromRole}","toRole":"${role}","reason":"controlled William ChatGPT integration acceptance","platformAdmin":false}', datetime('now'));`,
  );
  return { auditId, membership: membershipRole() };
}

function mintAcceptanceToken() {
  const token = `william_${randomBytes(24).toString("hex")}`;
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
const intended = readIntendedRole(apiDir);
persistIntendedRole(apiDir, intended, "run-william-chatgpt-acceptance");
if (intended === "director" || recorded?.role === "director") {
  const restored = restoreIntendedRole(apiDir, recorded?.role, "william is intended Director");
  const report = {
    skipped: true,
    reason: "William is intended Director; office_staff elevate/restore loop is retired",
    recordedBefore: recorded,
    intendedRole: intended,
    finalMembership: restored.membership,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath: REPORT_PATH, ...report }, null, 2));
  process.exit(0);
}
if (!recorded || recorded.role !== ORIGINAL_ROLE) {
  console.error(JSON.stringify({ error: "Refusing to elevate: live role is not office_staff", recorded, intended }, null, 2));
  process.exit(1);
}

const report = {
  recordedBeforeElevate: recorded,
  originalRole: ORIGINAL_ROLE,
  temporaryRole: TEMP_ROLE,
  platformAdmin: false,
};
let elevated = false;

try {
  report.elevated = setRole(TEMP_ROLE, "membership.role_temporary_elevate");
  elevated = true;
  if (report.elevated.membership?.role !== TEMP_ROLE) {
    throw new Error("Elevation did not persist");
  }
  report.elevatedRun = await runPhase("elevated");
} catch (err) {
  report.elevateError = err instanceof Error ? err.message : String(err);
} finally {
  if (elevated || membershipRole()?.role === TEMP_ROLE) {
    report.restored = restoreIntendedRole(apiDir, TEMP_ROLE, "william chatgpt acceptance");
  }
}

try {
  if (report.restored?.membership?.role === ORIGINAL_ROLE) {
    report.restoredRun = await runPhase("restored");
  }
} catch (err) {
  report.restoreProbeError = err instanceof Error ? err.message : String(err);
}

report.finalMembership = restoreIntendedRole(apiDir, membershipRole()?.role, "william chatgpt acceptance").membership;
report.chatgptConnection = d1(
  `SELECT id, status, last_used_at, oauth_client_id FROM ai_user_connections WHERE id = 'aiu_275e6019-4ae9-4f8a-a655-0be747bd8418';`,
);

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      reportPath: REPORT_PATH,
      recordedBeforeElevate: report.recordedBeforeElevate,
      elevatedRole: report.elevated?.membership?.role ?? null,
      restoredRole: report.finalMembership?.role ?? null,
      intendedRole: intended,
      elevateError: report.elevateError ?? null,
      elevatedHttpStatus: report.elevatedRun?.httpStatus ?? null,
      restoredHttpStatus: report.restoredRun?.httpStatus ?? null,
    },
    null,
    2,
  ),
);

process.exit(report.finalMembership?.role === intended && !report.elevateError ? 0 : 1);
