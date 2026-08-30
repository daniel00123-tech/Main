/**
 * Operator-facing infrastructure usage snapshot.
 * Sourced from existing D1 operational tables — no new warehouse.
 * Xero write validation and permission checks are never served from this view.
 */

export type TenantInfrastructureUsage = {
  companyId: string;
  requests24h: number;
  requestFailures24h: number;
  avgDurationMs: number | null;
  connectorCalls24h: number;
  automationRuns24h: number;
  automationFailures24h: number;
  microsoftJobs24h: number;
  microsoftPending: number;
  ocrPages24h: number;
  estimatedCustomerChargeCents24h: number;
};

export type PlatformInfrastructureUsage = {
  checkedAt: string;
  cacheHit: boolean;
  requests24h: number;
  requestSuccessRate: number | null;
  avgDurationMs: number | null;
  automationRuns24h: number;
  automationFailures24h: number;
  microsoftJobs24h: number;
  microsoftPending: number;
  microsoftDeadLetter24h: number;
  ocrCompleted24h: number;
  ocrFailed24h: number;
  estimatedCustomerChargeCents24h: number;
  tenants: TenantInfrastructureUsage[];
  notes: string[];
};

function rate(success: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((success / total) * 1000) / 10;
}

export async function getPlatformInfrastructureUsage(db: D1Database): Promise<PlatformInfrastructureUsage> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const usage = await db
    .prepare(
      `SELECT company_id,
              COUNT(*) AS requests,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
              AVG(duration_ms) AS avg_ms,
              SUM(CASE WHEN connector_instance_id IS NOT NULL THEN 1 ELSE 0 END) AS connector_calls,
              COALESCE(SUM(customer_charge_cents), 0) AS charge_cents
       FROM usage_records
       WHERE recorded_at >= ?
       GROUP BY company_id`,
    )
    .bind(since)
    .all<{
      company_id: string;
      requests: number;
      failures: number;
      avg_ms: number | null;
      connector_calls: number;
      charge_cents: number;
    }>();

  const automations = await db
    .prepare(
      `SELECT company_id,
              COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM automation_runs
       WHERE created_at >= ?
       GROUP BY company_id`,
    )
    .bind(since)
    .all<{ company_id: string; runs: number; failures: number }>();

  const msJobs = await db
    .prepare(
      `SELECT company_id,
              COUNT(*) AS jobs,
              SUM(CASE WHEN status IN ('queued', 'processing', 'retrying') THEN 1 ELSE 0 END) AS pending
       FROM microsoft_file_jobs
       WHERE created_at >= ?
       GROUP BY company_id`,
    )
    .bind(since)
    .all<{ company_id: string; jobs: number; pending: number }>();

  const ocr = await db
    .prepare(
      `SELECT company_id,
              SUM(CASE WHEN success = 1 THEN quantity ELSE 0 END) AS pages
       FROM usage_records
       WHERE recorded_at >= ? AND resource_type = 'knowledge_ocr'
       GROUP BY company_id`,
    )
    .bind(since)
    .all<{ company_id: string; pages: number }>();

  const ocrStatus = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN ocr_status = 'ocr_completed' AND updated_at >= ? THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN ocr_status = 'ocr_failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS failed
       FROM knowledge_ocr_jobs`,
    )
    .bind(since, since)
    .first<{ completed: number; failed: number }>();

  const deadLetters = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM microsoft_file_jobs
       WHERE status = 'dead_letter' AND updated_at >= ?`,
    )
    .bind(since)
    .first<{ count: number }>();

  const byCompany = new Map<string, TenantInfrastructureUsage>();
  const ensure = (companyId: string) => {
    let row = byCompany.get(companyId);
    if (!row) {
      row = {
        companyId,
        requests24h: 0,
        requestFailures24h: 0,
        avgDurationMs: null,
        connectorCalls24h: 0,
        automationRuns24h: 0,
        automationFailures24h: 0,
        microsoftJobs24h: 0,
        microsoftPending: 0,
        ocrPages24h: 0,
        estimatedCustomerChargeCents24h: 0,
      };
      byCompany.set(companyId, row);
    }
    return row;
  };

  for (const row of usage.results ?? []) {
    const tenant = ensure(row.company_id);
    tenant.requests24h = Number(row.requests ?? 0);
    tenant.requestFailures24h = Number(row.failures ?? 0);
    tenant.avgDurationMs = row.avg_ms == null ? null : Math.round(Number(row.avg_ms));
    tenant.connectorCalls24h = Number(row.connector_calls ?? 0);
    tenant.estimatedCustomerChargeCents24h = Number(row.charge_cents ?? 0);
  }
  for (const row of automations.results ?? []) {
    const tenant = ensure(row.company_id);
    tenant.automationRuns24h = Number(row.runs ?? 0);
    tenant.automationFailures24h = Number(row.failures ?? 0);
  }
  for (const row of msJobs.results ?? []) {
    const tenant = ensure(row.company_id);
    tenant.microsoftJobs24h = Number(row.jobs ?? 0);
    tenant.microsoftPending = Number(row.pending ?? 0);
  }
  for (const row of ocr.results ?? []) {
    ensure(row.company_id).ocrPages24h = Number(row.pages ?? 0);
  }

  const tenants = [...byCompany.values()].sort((a, b) => b.requests24h - a.requests24h);
  const requests24h = tenants.reduce((sum, row) => sum + row.requests24h, 0);
  const failures24h = tenants.reduce((sum, row) => sum + row.requestFailures24h, 0);
  const durationSamples = tenants.filter((row) => row.avgDurationMs != null);
  const avgDurationMs =
    durationSamples.length === 0
      ? null
      : Math.round(
          durationSamples.reduce((sum, row) => sum + (row.avgDurationMs ?? 0), 0) /
            durationSamples.length,
        );

  return {
    checkedAt: new Date().toISOString(),
    cacheHit: false,
    requests24h,
    requestSuccessRate: rate(requests24h - failures24h, requests24h),
    avgDurationMs,
    automationRuns24h: tenants.reduce((sum, row) => sum + row.automationRuns24h, 0),
    automationFailures24h: tenants.reduce((sum, row) => sum + row.automationFailures24h, 0),
    microsoftJobs24h: tenants.reduce((sum, row) => sum + row.microsoftJobs24h, 0),
    microsoftPending: tenants.reduce((sum, row) => sum + row.microsoftPending, 0),
    microsoftDeadLetter24h: Number(deadLetters?.count ?? 0),
    ocrCompleted24h: Number(ocrStatus?.completed ?? 0),
    ocrFailed24h: Number(ocrStatus?.failed ?? 0),
    estimatedCustomerChargeCents24h: tenants.reduce(
      (sum, row) => sum + row.estimatedCustomerChargeCents24h,
      0,
    ),
    tenants,
    notes: [
      "Worker CPU-ms and Cloudflare queue depth are not stored in D1; pending Microsoft jobs approximate ingest queue depth.",
      "This snapshot is company-scoped and excludes tokens, document bodies, and financial write validations.",
    ],
  };
}
