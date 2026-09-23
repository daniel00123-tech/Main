/**
 * William is intended Director. Acceptance probes may switch role temporarily
 * but must restore operator_intended_role — never leave office_staff.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const WILLIAM_USER = "user_b0db1fc5-692c-436d-99e6-392966b20df8";
export const WILLIAM_MEM = "membership_78495c59-cff6-4db5-9986-a351ebe154f1";
export const WILLIAM_INTENDED_ROLE = "director";

export function d1(apiDir, sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

export function d1File(apiDir, sql) {
  const sqlFile = join(apiDir, ".tmp-william-intended-role.sql");
  writeFileSync(sqlFile, sql);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--file", sqlFile],
    { cwd: apiDir, stdio: "pipe" },
  );
  unlinkSync(sqlFile);
}

export function ensureIntendedTable(apiDir) {
  d1File(
    apiDir,
    `CREATE TABLE IF NOT EXISTS membership_operator_roles (
       membership_id TEXT PRIMARY KEY,
       company_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       intended_role TEXT NOT NULL,
       set_by TEXT NOT NULL,
       set_at TEXT NOT NULL
     );`,
  );
}

export function membership(apiDir) {
  return (
    d1(
      apiDir,
      `SELECT id, user_id, company_id, role, status, updated_at
       FROM company_memberships
       WHERE id='${WILLIAM_MEM}' AND user_id='${WILLIAM_USER}' AND company_id='co_el';`,
    )[0] ?? null
  );
}

export function lastOperatorRole(apiDir) {
  const row = d1(
    apiDir,
    `SELECT actor, detail_json, created_at
     FROM audit_events
     WHERE company_id='co_el'
       AND event_type IN ('user.role_changed','membership.operator_intended_role')
       AND resource_id IN ('${WILLIAM_USER}','${WILLIAM_MEM}')
       AND actor NOT LIKE 'cursor-acceptance%'
     ORDER BY created_at DESC LIMIT 1;`,
  )[0];
  if (!row?.detail_json) return null;
  try {
    const detail = JSON.parse(row.detail_json);
    return detail.role ?? detail.intendedRole ?? detail.toRole ?? null;
  } catch {
    return null;
  }
}

export function readIntendedRole(apiDir) {
  ensureIntendedTable(apiDir);
  const stored = d1(
    apiDir,
    `SELECT intended_role FROM membership_operator_roles WHERE membership_id='${WILLIAM_MEM}';`,
  )[0]?.intended_role;
  return stored || lastOperatorRole(apiDir) || WILLIAM_INTENDED_ROLE;
}

export function persistIntendedRole(apiDir, role, setBy) {
  ensureIntendedTable(apiDir);
  d1File(
    apiDir,
    `INSERT OR REPLACE INTO membership_operator_roles
       (membership_id, company_id, user_id, intended_role, set_by, set_at)
     VALUES ('${WILLIAM_MEM}', 'co_el', '${WILLIAM_USER}', '${role}', '${setBy}', datetime('now'));`,
  );
  return role;
}

export function setLiveRole(apiDir, role, eventType, fromRole, reason) {
  const auditId = `audit_${crypto.randomUUID?.() ?? Date.now().toString(16)}`;
  d1File(
    apiDir,
    `UPDATE company_memberships
     SET role='${role}', updated_at=datetime('now')
     WHERE id='${WILLIAM_MEM}' AND user_id='${WILLIAM_USER}' AND company_id='co_el';
     INSERT INTO audit_events (id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at)
     VALUES (
       '${auditId}', 'co_el', '${eventType}', 'cursor-acceptance',
       'company_membership', '${WILLIAM_MEM}',
       '{"fromRole":"${fromRole}","toRole":"${role}","reason":"${reason}","platformAdmin":false}',
       datetime('now')
     );`,
  );
  return membership(apiDir);
}

export function restoreIntendedRole(apiDir, fromRole, reason) {
  const intended = readIntendedRole(apiDir);
  persistIntendedRole(apiDir, intended, "cursor-acceptance-restore");
  return {
    intended,
    membership: setLiveRole(
      apiDir,
      intended,
      "membership.role_restored",
      fromRole ?? membership(apiDir)?.role ?? "unknown",
      reason ?? "restore operator-intended Director; do not leave office_staff",
    ),
  };
}
