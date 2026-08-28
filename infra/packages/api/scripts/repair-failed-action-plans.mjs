#!/usr/bin/env node
/**
 * Safe data repair for execution_plans stuck in actionable states after planning failure.
 * Does not delete audit history or execute actions.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const companyId = process.env.COMPANY_ID?.trim() || "co_caddington";
const dryRun = process.argv.includes("--dry-run");

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql, "--json"],
    { cwd: apiDir, encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function d1Exec(sql) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "infra-control-plane", "--remote", "--command", sql],
    { cwd: apiDir, encoding: "utf8", stdio: "pipe" },
  );
}

function bucketFor(status) {
  if (status === "awaiting_approval") return "needs_approval";
  if (["awaiting_confirmation", "validated", "approved", "executing", "draft"].includes(status)) {
    return "in_progress";
  }
  if (status === "completed") return "completed";
  return "failed";
}

function targetsReady(plan) {
  let payload = {};
  try {
    payload = JSON.parse(plan.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  return targets.length > 0 && targets.every((target) => target.validation === "valid");
}

function failureReason(plan) {
  let payload = {};
  try {
    payload = JSON.parse(plan.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const invalid = targets.find((target) => target.validation !== "valid");
  if (invalid?.validationDetail) return invalid.validationDetail;
  if (plan.summary?.includes("plan failed")) {
    return plan.summary.replace(/^.*plan failed —\s*/i, "").replace(/\.$/, "") || plan.summary;
  }
  return invalid?.validation ?? "Planning failed";
}

const actionable = new Set([
  "awaiting_confirmation",
  "awaiting_approval",
  "validated",
  "approved",
  "executing",
  "draft",
]);

const rows = d1Query(
  `SELECT id, company_id, status, summary, payload_json, confirmation_status, approval_status
   FROM execution_plans
   WHERE company_id = '${companyId.replace(/'/g, "''")}'
   ORDER BY created_at DESC`,
);

const before = { needs_approval: 0, in_progress: 0, completed: 0, failed: 0 };
for (const row of rows) {
  before[bucketFor(String(row.status))] += 1;
}

const toRepair = rows.filter((row) => {
  if (!actionable.has(String(row.status))) return false;
  if (targetsReady(row)) return false;
  return Boolean(failureReason(row));
});

if (!dryRun) {
  for (const row of toRepair) {
    const reason = failureReason(row).replace(/'/g, "''");
    d1Exec(
      `UPDATE execution_plans
       SET status = 'failed',
           confirmation_status = 'not_required',
           approval_status = 'not_required',
           confirmation_token_hash = NULL,
           updated_at = datetime('now')
       WHERE id = '${String(row.id).replace(/'/g, "''")}'
         AND company_id = '${companyId.replace(/'/g, "''")}'`,
    );
    d1Exec(
      `INSERT INTO audit_events (
         id, company_id, event_type, actor, resource_type, resource_id, detail_json, created_at
       ) VALUES (
         'audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}',
         '${companyId.replace(/'/g, "''")}',
         'action_plan.repaired_to_failed',
         'data-repair',
         'action_plan',
         '${String(row.id).replace(/'/g, "''")}',
         '{"previousStatus":"${String(row.status).replace(/'/g, "''")}","failureReason":"${reason}"}',
         datetime('now')
       )`,
    );
  }
}

const afterRows = dryRun
  ? rows.map((row) =>
      toRepair.some((candidate) => candidate.id === row.id)
        ? { ...row, status: "failed" }
        : row,
    )
  : d1Query(
      `SELECT status FROM execution_plans WHERE company_id = '${companyId.replace(/'/g, "''")}'`,
    );

const after = { needs_approval: 0, in_progress: 0, completed: 0, failed: 0 };
for (const row of afterRows) {
  after[bucketFor(String(row.status))] += 1;
}

console.log(
  JSON.stringify(
    {
      companyId,
      dryRun,
      scanned: rows.length,
      repaired: toRepair.length,
      repairedIds: toRepair.map((row) => row.id),
      before,
      after,
    },
    null,
    2,
  ),
);

process.exit(0);
