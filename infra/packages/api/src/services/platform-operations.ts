/**
 * Platform operations aggregator — reuses persisted health, audit, and metering data.
 */

import type {
  CompanyOperationalSummary,
  OperationalHealthState,
  OperationalIncident,
  OperationalSeverity,
  OperationalSubsystemHealth,
  OperationalSubsystemId,
  PlatformOperationalHealth,
} from "@infra/shared";
import {
  deduplicateOperationalIncidents,
  mapConnectorFailureToCategory,
  operationalStateFromBoolean,
  worstOperationalSeverity,
  worstOperationalState,
} from "@infra/shared";
import type { Env } from "../env";
import { nowIso } from "../db/mappers";
import { listConnectorInstances, listMcpEnvironments } from "./control-plane";
import { listFinancialExceptions } from "./reconciliation";
import { deriveAuthStatus } from "./connector-lifecycle";
import { hasAutomationRunQueue } from "./automation-engine/queue";
import { listPlatformHeartbeats } from "./platform-ops-heartbeats";
import { getCompanyEmailConfig } from "./email/company-config";

const STUCK_RUN_MINUTES = 45;
const STALE_SYNC_HOURS: Record<string, number> = {
  google_drive: 48,
  microsoft_365: 24,
  xero: 72,
  default: 48,
};

function minutesAgo(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((nowMs - parsed) / 60_000);
}

function hoursAgo(iso: string | null | undefined, nowMs: number): number | null {
  const minutes = minutesAgo(iso, nowMs);
  return minutes == null ? null : Math.floor(minutes / 60);
}

function heartbeatState(input: {
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  maxStaleMinutes: number;
  nowMs: number;
}): OperationalHealthState {
  if (!input.lastRunAt && !input.lastSuccessAt) return "UNKNOWN";
  const staleMinutes = minutesAgo(input.lastSuccessAt ?? input.lastRunAt, input.nowMs);
  if (staleMinutes == null) return "UNKNOWN";
  if (staleMinutes > input.maxStaleMinutes * 3) return "ATTENTION_REQUIRED";
  if (staleMinutes > input.maxStaleMinutes) return "DEGRADED";
  return "HEALTHY";
}

export async function detectStuckAutomationRuns(db: D1Database): Promise<
  Array<{
    runId: string;
    companyId: string;
    automationId: string;
    status: string;
    startedAt: string | null;
    minutesRunning: number;
  }>
> {
  const threshold = new Date(Date.now() - STUCK_RUN_MINUTES * 60_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT id, company_id, automation_id, status, started_at, created_at
       FROM automation_runs
       WHERE status IN ('running', 'queued')
         AND COALESCE(started_at, created_at) < ?
       ORDER BY COALESCE(started_at, created_at) ASC
       LIMIT 50`,
    )
    .bind(threshold)
    .all<{
      id: string;
      company_id: string;
      automation_id: string;
      status: string;
      started_at: string | null;
      created_at: string;
    }>();

  const nowMs = Date.now();
  return (rows.results ?? []).map((row) => ({
    runId: row.id,
    companyId: row.company_id,
    automationId: row.automation_id,
    status: row.status,
    startedAt: row.started_at,
    minutesRunning: minutesAgo(row.started_at ?? row.created_at, nowMs) ?? STUCK_RUN_MINUTES,
  }));
}

export async function detectStaleMicrosoftJobs(db: D1Database): Promise<
  Array<{ jobId: string; companyId: string; sourceId: string; status: string; minutesStale: number }>
> {
  const threshold = new Date(Date.now() - STUCK_RUN_MINUTES * 60_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT id, company_id, source_id, status, updated_at
       FROM microsoft_file_jobs
       WHERE status IN ('processing', 'retrying')
         AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 50`,
    )
    .bind(threshold)
    .all<{
      id: string;
      company_id: string;
      source_id: string;
      status: string;
      updated_at: string;
    }>();

  const nowMs = Date.now();
  return (rows.results ?? []).map((row) => ({
    jobId: row.id,
    companyId: row.company_id,
    sourceId: row.source_id,
    status: row.status,
    minutesStale: minutesAgo(row.updated_at, nowMs) ?? STUCK_RUN_MINUTES,
  }));
}

export async function detectExpiringGraphSubscriptions(db: D1Database): Promise<
  Array<{ id: string; companyId: string; sourceId: string; expiresAt: string; hoursUntilExpiry: number }>
> {
  const rows = await db
    .prepare(
      `SELECT id, company_id, source_id, expires_at, status
       FROM microsoft_graph_subscriptions
       WHERE status = 'active'
         AND datetime(expires_at) <= datetime('now', '+24 hours')
       ORDER BY expires_at ASC
       LIMIT 50`,
    )
    .all<{
      id: string;
      company_id: string;
      source_id: string;
      expires_at: string;
      status: string;
    }>();

  const nowMs = Date.now();
  return (rows.results ?? []).map((row) => {
    const hours = Math.max(0, Math.floor((Date.parse(row.expires_at) - nowMs) / 3_600_000));
    return {
      id: row.id,
      companyId: row.company_id,
      sourceId: row.source_id,
      expiresAt: row.expires_at,
      hoursUntilExpiry: hours,
    };
  });
}

export async function detectStaleConnectors(
  db: D1Database,
  nowMs = Date.now(),
): Promise<
  Array<{
    connectorId: string;
    companyId: string;
    connectorDefinitionId: string;
    name: string;
    lastSyncAt: string | null;
    hoursSinceSync: number;
    expectedHours: number;
  }>
> {
  const connectors = await listConnectorInstances(db);
  const stale: Array<{
    connectorId: string;
    companyId: string;
    connectorDefinitionId: string;
    name: string;
    lastSyncAt: string | null;
    hoursSinceSync: number;
    expectedHours: number;
  }> = [];

  for (const connector of connectors) {
    if (!connector.syncSettings?.enabled) continue;
    if (!["connected", "configured", "degraded"].includes(connector.status)) continue;
    const expected =
      STALE_SYNC_HOURS[connector.connectorDefinitionId] ?? STALE_SYNC_HOURS.default;
    const hours = hoursAgo(connector.lastSyncAt, nowMs);
    if (hours == null || hours <= expected) continue;
    stale.push({
      connectorId: connector.id,
      companyId: connector.companyId,
      connectorDefinitionId: connector.connectorDefinitionId,
      name: connector.name,
      lastSyncAt: connector.lastSyncAt,
      hoursSinceSync: hours,
      expectedHours: expected,
    });
  }

  return stale;
}

export async function collectSecuritySignals(db: D1Database): Promise<{
  permissionDenialsLast24h: number;
  crossTenantDenialsLast24h: number;
  failedAdminLoginsLast24h: number;
  financialWriteDenialsLast24h: number;
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const permissionRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE event_type = 'permission.denied' AND created_at >= ?`,
    )
    .bind(since)
    .first<{ count: number }>();

  const crossTenantRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE event_type = 'permission.denied'
         AND created_at >= ?
         AND detail_json LIKE '%cross_tenant%'`,
    )
    .bind(since)
    .first<{ count: number }>();

  const adminLoginRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE event_type = 'auth.login_failed'
         AND created_at >= ?
         AND actor LIKE '%admin%'`,
    )
    .bind(since)
    .first<{ count: number }>();

  const financialDenialRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE event_type = 'permission.denied'
         AND created_at >= ?
         AND (detail_json LIKE '%write%' OR detail_json LIKE '%governance%' OR resource_type = 'action')`,
    )
    .bind(since)
    .first<{ count: number }>();

  return {
    permissionDenialsLast24h: Number(permissionRow?.count ?? 0),
    crossTenantDenialsLast24h: Number(crossTenantRow?.count ?? 0),
    failedAdminLoginsLast24h: Number(adminLoginRow?.count ?? 0),
    financialWriteDenialsLast24h: Number(financialDenialRow?.count ?? 0),
  };
}

export async function collectUsageAnomalies(db: D1Database): Promise<string[]> {
  const flags: string[] = [];
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const recent = await db
    .prepare(`SELECT COUNT(*) AS count FROM usage_records WHERE recorded_at >= ?`)
    .bind(dayAgo)
    .first<{ count: number }>();
  const baseline = await db
    .prepare(`SELECT COUNT(*) AS count FROM usage_records WHERE recorded_at >= ? AND recorded_at < ?`)
    .bind(weekAgo, dayAgo)
    .first<{ count: number }>();

  const recentCount = Number(recent?.count ?? 0);
  const baselineCount = Number(baseline?.count ?? 0);
  const dailyBaseline = baselineCount / 6;
  if (dailyBaseline >= 20 && recentCount > dailyBaseline * 3) {
    flags.push(
      `Platform requests in the last 24h (${recentCount}) are materially above the recent daily average (~${Math.round(dailyBaseline)}).`,
    );
  }

  const automationRuns = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM automation_runs WHERE created_at >= ?`,
    )
    .bind(dayAgo)
    .first<{ count: number }>();
  const automationCount = Number(automationRuns?.count ?? 0);
  if (automationCount >= 50) {
    flags.push(`Automation runs in the last 24h (${automationCount}) are elevated — review for loops.`);
  }

  const msJobs = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM microsoft_file_jobs WHERE created_at >= ?`,
    )
    .bind(dayAgo)
    .first<{ count: number }>();
  const msJobCount = Number(msJobs?.count ?? 0);
  if (msJobCount >= 500) {
    flags.push(
      `Microsoft knowledge jobs in the last 24h (${msJobCount}) are elevated — check continuation and queue depth.`,
    );
  }

  return flags;
}

async function buildSubsystemHealth(
  env: Env,
  db: D1Database,
  checkedAt: string,
  nowMs: number,
): Promise<OperationalSubsystemHealth[]> {
  const heartbeats = await listPlatformHeartbeats(db);
  const heartbeatByKey = new Map(heartbeats.map((h) => [h.key, h]));
  const mcps = await listMcpEnvironments(db);
  const connectors = await listConnectorInstances(db);
  const openExceptions = (await listFinancialExceptions(db, "open")).length;

  const msHeartbeat = heartbeatByKey.get("microsoft_scheduler");
  const autoHeartbeat = heartbeatByKey.get("automation_scheduler");

  const microsoftConnectors = connectors.filter((c) => c.connectorDefinitionId === "conn_microsoft_365");
  const googleConnectors = connectors.filter((c) => c.connectorDefinitionId === "conn_google_drive");
  const xeroConnectors = connectors.filter((c) => c.connectorDefinitionId === "conn_xero");

  const microsoftIssues = microsoftConnectors.filter(
    (c) => c.status === "error" || c.healthStatus === "degraded" || deriveAuthStatus(c) === "auth_expired",
  ).length;
  const googleIssues = googleConnectors.filter(
    (c) => c.status === "error" || c.healthStatus === "degraded",
  ).length;
  const xeroIssues = xeroConnectors.filter(
    (c) => c.status === "error" || deriveAuthStatus(c) === "auth_expired",
  ).length;

  const stuckRuns = (await detectStuckAutomationRuns(db)).length;
  const staleMsJobs = (await detectStaleMicrosoftJobs(db)).length;
  const expiringSubs = (await detectExpiringGraphSubscriptions(db)).length;

  const deadLetterRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM microsoft_file_jobs WHERE status = 'dead_letter' AND updated_at >= datetime('now', '-24 hours')`,
    )
    .first<{ count: number }>();
  const deadLetters = Number(deadLetterRow?.count ?? 0);

  const failedWebhooksRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM stripe_webhook_events
       WHERE error_message IS NOT NULL AND received_at >= datetime('now', '-24 hours')`,
    )
    .first<{ count: number }>();
  const failedWebhooks = Number(failedWebhooksRow?.count ?? 0);

  let outboundEmailState: OperationalHealthState = "UNKNOWN";
  try {
    const emailConfig = await getCompanyEmailConfig(db, "co_caddington");
    if (!emailConfig) outboundEmailState = "UNKNOWN";
    else if (emailConfig.healthStatus === "healthy") outboundEmailState = "HEALTHY";
    else if (emailConfig.healthStatus === "permission_required") outboundEmailState = "ATTENTION_REQUIRED";
    else outboundEmailState = "DEGRADED";
  } catch {
    outboundEmailState = "UNKNOWN";
  }

  const subsystems: OperationalSubsystemHealth[] = [
    {
      id: "api",
      label: "API",
      state: "HEALTHY",
      severity: "INFO",
      summary: "Control plane responding",
      lastCheckedAt: checkedAt,
    },
    {
      id: "database",
      label: "Database (D1)",
      state: "HEALTHY",
      severity: "INFO",
      summary: "Operational queries succeeding",
      lastCheckedAt: checkedAt,
    },
    {
      id: "portal",
      label: "Company portal connectivity",
      state: "HEALTHY",
      severity: "INFO",
      summary: "Portal routes available via shared API",
      lastCheckedAt: checkedAt,
    },
    {
      id: "mcp",
      label: "Business MCP environments",
      state: operationalStateFromBoolean({
        outage: mcps.some((m) => m.status === "unreachable"),
        degraded: mcps.some((m) => m.status === "degraded"),
        healthy: mcps.length > 0 && mcps.every((m) => m.status === "healthy"),
        unknown: mcps.length === 0,
      }),
      severity: mcps.some((m) => m.status === "unreachable") ? "CRITICAL" : "WARNING",
      summary: `${mcps.filter((m) => m.status === "healthy").length}/${mcps.length} MCP environments healthy`,
      lastCheckedAt: checkedAt,
      metrics: {
        unreachable: mcps.filter((m) => m.status === "unreachable").length,
        degraded: mcps.filter((m) => m.status === "degraded").length,
      },
    },
    {
      id: "microsoft",
      label: "Microsoft integration",
      state: worstOperationalState([
        heartbeatState({
          lastSuccessAt: msHeartbeat?.lastSuccessAt ?? null,
          lastRunAt: msHeartbeat?.lastRunAt ?? null,
          maxStaleMinutes: 960,
          nowMs,
        }),
        microsoftIssues > 0 ? "ATTENTION_REQUIRED" : "HEALTHY",
        staleMsJobs > 0 ? "DEGRADED" : "HEALTHY",
        expiringSubs > 0 ? "ATTENTION_REQUIRED" : "HEALTHY",
        deadLetters > 0 ? "DEGRADED" : "HEALTHY",
      ]),
      severity: expiringSubs > 0 || microsoftIssues > 0 ? "WARNING" : "INFO",
      summary: `Scheduler ${msHeartbeat?.lastSuccessAt ? "active" : "unknown"}; ${microsoftIssues} connector issue(s); ${staleMsJobs} stale job(s); ${expiringSubs} subscription(s) expiring`,
      detail: msHeartbeat?.lastError,
      lastCheckedAt: checkedAt,
      metrics: { staleJobs: staleMsJobs, expiringSubscriptions: expiringSubs, deadLetters },
    },
    {
      id: "google_drive",
      label: "Google Drive ingestion",
      state: googleIssues > 0 ? "ATTENTION_REQUIRED" : googleConnectors.length === 0 ? "UNKNOWN" : "HEALTHY",
      severity: googleIssues > 0 ? "WARNING" : "INFO",
      summary:
        googleConnectors.length === 0
          ? "No Google Drive connectors configured"
          : `${googleConnectors.length - googleIssues}/${googleConnectors.length} connectors healthy (MCP-managed sync)`,
      lastCheckedAt: checkedAt,
    },
    {
      id: "xero",
      label: "Xero",
      state: xeroIssues > 0 ? "ATTENTION_REQUIRED" : xeroConnectors.length === 0 ? "UNKNOWN" : "HEALTHY",
      severity: xeroIssues > 0 ? "WARNING" : "INFO",
      summary:
        xeroConnectors.length === 0
          ? "No Xero connectors configured"
          : `${xeroConnectors.length - xeroIssues}/${xeroConnectors.length} connectors healthy`,
      lastCheckedAt: checkedAt,
    },
    {
      id: "automation",
      label: "Automation Engine",
      state: worstOperationalState([
        heartbeatState({
          lastSuccessAt: autoHeartbeat?.lastSuccessAt ?? null,
          lastRunAt: autoHeartbeat?.lastRunAt ?? null,
          maxStaleMinutes: 960,
          nowMs,
        }),
        stuckRuns > 0 ? "DEGRADED" : "HEALTHY",
      ]),
      severity: stuckRuns > 0 ? "WARNING" : "INFO",
      summary: `${hasAutomationRunQueue(env) ? "Queue-backed" : "HTTP fallback"} processing; ${stuckRuns} stuck run(s)`,
      lastCheckedAt: checkedAt,
      metrics: { stuckRuns },
    },
    {
      id: "stripe",
      label: "Stripe / billing",
      state: worstOperationalState([
        openExceptions > 0 ? "ATTENTION_REQUIRED" : "HEALTHY",
        failedWebhooks > 0 ? "DEGRADED" : "HEALTHY",
        env.STRIPE_SECRET_KEY ? "HEALTHY" : "UNKNOWN",
      ]),
      severity: openExceptions > 0 ? "WARNING" : failedWebhooks > 0 ? "WARNING" : "INFO",
      summary: `${openExceptions} open financial exception(s); ${failedWebhooks} failed webhook(s) in 24h`,
      lastCheckedAt: checkedAt,
      metrics: { openExceptions, failedWebhooks24h: failedWebhooks },
    },
    {
      id: "knowledge",
      label: "Knowledge search / indexing",
      state: deadLetters > 0 || staleMsJobs > 0 ? "DEGRADED" : "HEALTHY",
      severity: deadLetters > 0 ? "WARNING" : "INFO",
      summary: `Microsoft queue: ${staleMsJobs} stale, ${deadLetters} dead-letter (24h)`,
      lastCheckedAt: checkedAt,
    },
    {
      id: "outbound_email",
      label: "Outbound transactional email",
      state: outboundEmailState,
      severity: outboundEmailState === "HEALTHY" ? "INFO" : "WARNING",
      summary:
        outboundEmailState === "UNKNOWN"
          ? "Not configured for this tenant"
          : `Caddington sender health: ${outboundEmailState.replace(/_/g, " ").toLowerCase()}`,
      lastCheckedAt: checkedAt,
    },
  ];

  return subsystems;
}

async function buildOperationalIncidents(
  db: D1Database,
  companies: Map<string, { name: string; slug: string }>,
): Promise<OperationalIncident[]> {
  const now = nowIso();
  const raw: Array<Omit<OperationalIncident, "occurrenceCount" | "firstObservedAt" | "lastObservedAt" | "resolved"> & { observedAt?: string }> = [];

  for (const stuck of await detectStuckAutomationRuns(db)) {
    const co = companies.get(stuck.companyId);
    raw.push({
      id: `ops-auto-stuck-${stuck.runId}`,
      severity: "WARNING",
      companyId: stuck.companyId,
      companyName: co?.name ?? null,
      subsystem: "automation",
      category: "TIMEOUT",
      title: "Automation run appears stuck",
      summary: `Run ${stuck.runId} in ${stuck.status} for ${stuck.minutesRunning} minutes`,
      recommendedAction: "Inspect automation run details; cancel or fail the run if processing has stalled.",
      href: co ? `/portal/${co.slug}/automations` : null,
      observedAt: now,
    });
  }

  for (const stale of await detectStaleMicrosoftJobs(db)) {
    const co = companies.get(stale.companyId);
    raw.push({
      id: `ops-ms-job-${stale.jobId}`,
      severity: "WARNING",
      companyId: stale.companyId,
      companyName: co?.name ?? null,
      subsystem: "microsoft",
      category: "TIMEOUT",
      title: "Microsoft knowledge job stale",
      summary: `Job ${stale.jobId} in ${stale.status} for ${stale.minutesStale} minutes`,
      recommendedAction: "Review Microsoft queue processing and source sync run state.",
      href: co ? `/portal/${co.slug}/microsoft-365` : null,
      observedAt: now,
    });
  }

  for (const sub of await detectExpiringGraphSubscriptions(db)) {
    const co = companies.get(sub.companyId);
    raw.push({
      id: `ops-graph-sub-${sub.id}`,
      severity: sub.hoursUntilExpiry <= 6 ? "CRITICAL" : "WARNING",
      companyId: sub.companyId,
      companyName: co?.name ?? null,
      subsystem: "microsoft",
      category: "CONFIGURATION",
      title: "Graph subscription expiring",
      summary: `Subscription expires in ~${sub.hoursUntilExpiry}h`,
      recommendedAction: "Verify Microsoft scheduler renewal and reconciliation fallback.",
      href: co ? `/portal/${co.slug}/microsoft-365` : null,
      observedAt: now,
    });
  }

  for (const stale of await detectStaleConnectors(db)) {
    const co = companies.get(stale.companyId);
    raw.push({
      id: `ops-stale-conn-${stale.connectorId}`,
      severity: "WARNING",
      companyId: stale.companyId,
      companyName: co?.name ?? null,
      subsystem: stale.connectorDefinitionId.includes("google")
        ? "google_drive"
        : stale.connectorDefinitionId.includes("microsoft")
          ? "microsoft"
          : stale.connectorDefinitionId.includes("xero")
            ? "xero"
            : "knowledge",
      category: mapConnectorFailureToCategory({}),
      title: `${stale.name} sync appears stale`,
      summary: `Last successful sync ${stale.hoursSinceSync}h ago (expected ≤${stale.expectedHours}h)`,
      recommendedAction: "Review connector sync schedule, credentials, and recent job history.",
      href: co ? `/portal/${co.slug}/connectors` : null,
      observedAt: now,
    });
  }

  for (const ex of await listFinancialExceptions(db, "open")) {
    const co = ex.companyId ? companies.get(ex.companyId) : undefined;
    raw.push({
      id: `ops-fie-${ex.id}`,
      severity: ex.severity === "critical" ? "CRITICAL" : "WARNING",
      companyId: ex.companyId,
      companyName: co?.name ?? null,
      subsystem: "stripe",
      category: "DATA",
      title: "Financial integrity exception",
      summary: `${ex.exceptionType} requires review`,
      recommendedAction: "Run billing reconciliation review — do not auto-adjust ledger entries.",
      href: "/commercial/pricing-rules",
      observedAt: ex.detectedAt,
    });
  }

  const security = await collectSecuritySignals(db);
  if (security.crossTenantDenialsLast24h >= 3) {
    raw.push({
      id: "ops-security-cross-tenant",
      severity: "CRITICAL",
      companyId: null,
      companyName: null,
      subsystem: "platform",
      category: "SECURITY_POLICY",
      title: "Repeated cross-tenant access denials",
      summary: `${security.crossTenantDenialsLast24h} denials in 24h`,
      recommendedAction: "Review audit events for permission.denied with cross-tenant detail.",
      href: "/audit-log",
      observedAt: now,
    });
  }

  return deduplicateOperationalIncidents(raw);
}

export async function buildCompanyOperationalSummaries(
  db: D1Database,
  incidents: OperationalIncident[],
): Promise<CompanyOperationalSummary[]> {
  const companies = await db
    .prepare(`SELECT id, name, slug, status FROM companies ORDER BY name ASC`)
    .all<{ id: string; name: string; slug: string; status: string }>();

  const summaries: CompanyOperationalSummary[] = [];
  for (const co of companies.results ?? []) {
    const companyIncidents = incidents.filter((i) => i.companyId === co.id);
    const connectorIssues = companyIncidents.filter((i) =>
      ["microsoft", "google_drive", "xero", "knowledge", "mcp"].includes(i.subsystem),
    ).length;
    const billingIssues = companyIncidents.filter((i) => i.subsystem === "stripe").length;
    const automationFailures = companyIncidents.filter((i) => i.subsystem === "automation").length;
    const knowledgeSyncIssues = companyIncidents.filter(
      (i) => i.subsystem === "microsoft" || i.subsystem === "knowledge",
    ).length;
    const authSecuritySignals = companyIncidents.filter(
      (i) => i.category === "AUTHENTICATION" || i.category === "SECURITY_POLICY",
    ).length;

    const lastActivity = await db
      .prepare(
        `SELECT MAX(recorded_at) AS last_at FROM usage_records WHERE company_id = ?`,
      )
      .bind(co.id)
      .first<{ last_at: string | null }>();

    const states: OperationalHealthState[] = [];
    if (co.status === "suspended") states.push("OUTAGE");
    if (companyIncidents.some((i) => i.severity === "CRITICAL")) states.push("ATTENTION_REQUIRED");
    else if (companyIncidents.length > 0) states.push("DEGRADED");
    else states.push("HEALTHY");

    summaries.push({
      companyId: co.id,
      companyName: co.name,
      companySlug: co.slug,
      overallState: worstOperationalState(states),
      connectorIssues,
      billingIssues,
      automationFailures,
      knowledgeSyncIssues,
      authSecuritySignals,
      lastSuccessfulActivityAt: lastActivity?.last_at ?? null,
      attentionCount: companyIncidents.length,
    });
  }

  return summaries;
}

export async function getPlatformOperationalHealth(env: Env): Promise<PlatformOperationalHealth> {
  const db = env.DB;
  const checkedAt = nowIso();
  const nowMs = Date.now();

  const companyRows = await db.prepare(`SELECT id, name, slug FROM companies`).all<{
    id: string;
    name: string;
    slug: string;
  }>();
  const companyMap = new Map(
    (companyRows.results ?? []).map((c) => [c.id, { name: c.name, slug: c.slug }]),
  );

  const [subsystems, incidents, heartbeats, security, usageAnomalies] = await Promise.all([
    buildSubsystemHealth(env, db, checkedAt, nowMs),
    buildOperationalIncidents(db, companyMap),
    listPlatformHeartbeats(db),
    collectSecuritySignals(db),
    collectUsageAnomalies(db),
  ]);

  const companySummaries = await buildCompanyOperationalSummaries(db, incidents);
  const openFinancialExceptions = (await listFinancialExceptions(db, "open")).length;

  const overallState = worstOperationalState([
    ...subsystems.map((s) => s.state),
    incidents.some((i) => i.severity === "CRITICAL") ? "ATTENTION_REQUIRED" : "HEALTHY",
  ]);
  const overallSeverity = worstOperationalSeverity([
    ...subsystems.map((s) => s.severity),
    ...incidents.map((i) => i.severity),
  ]);

  return {
    checkedAt,
    overallState,
    overallSeverity,
    subsystems,
    incidents,
    companySummaries,
    schedulerHeartbeats: heartbeats.map((hb) => ({
      key: hb.key,
      label: hb.label,
      lastRunAt: hb.lastRunAt,
      lastSuccessAt: hb.lastSuccessAt,
      lastError: hb.lastError,
      state: heartbeatState({
        lastSuccessAt: hb.lastSuccessAt,
        lastRunAt: hb.lastRunAt,
        maxStaleMinutes: hb.key.includes("scheduler") ? 960 : 1440,
        nowMs,
      }),
    })),
    automationProcessingMode: hasAutomationRunQueue(env) ? "queue" : "http_fallback",
    openFinancialExceptions,
    permissionDenialsLast24h: security.permissionDenialsLast24h,
    usageAnomalyFlags: usageAnomalies,
  };
}

export async function runBillingReconciliationDiagnostic(db: D1Database): Promise<{
  checkedAt: string;
  openExceptions: number;
  healedLinks: number;
  createdExceptions: number;
  anomalies: string[];
}> {
  const { runFinancialReconciliation, listFinancialExceptions } = await import("./reconciliation");
  const before = (await listFinancialExceptions(db, "open")).length;
  const result = await runFinancialReconciliation(db);
  const after = (await listFinancialExceptions(db, "open")).length;

  const anomalies: string[] = [];
  const dupCredits = await db
    .prepare(
      `SELECT stripe_payment_intent_id, COUNT(*) AS count
       FROM stripe_checkout_sessions
       WHERE stripe_payment_intent_id IS NOT NULL AND status = 'completed'
       GROUP BY stripe_payment_intent_id
       HAVING count > 1
       LIMIT 20`,
    )
    .all<{ stripe_payment_intent_id: string; count: number }>();
  for (const row of dupCredits.results ?? []) {
    anomalies.push(
      `Duplicate completed checkout for payment intent ${row.stripe_payment_intent_id} (${row.count} rows)`,
    );
  }

  const dupLedgerCredits = await db
    .prepare(
      `SELECT reference_id, COUNT(*) AS count
       FROM ledger_entries
       WHERE entry_type = 'credit' AND reference_type = 'stripe_checkout'
       GROUP BY reference_id
       HAVING count > 1
       LIMIT 20`,
    )
    .all<{ reference_id: string; count: number }>();
  for (const row of dupLedgerCredits.results ?? []) {
    anomalies.push(`Duplicate wallet credit for checkout ${row.reference_id} (${row.count} rows)`);
  }

  const missingCredits = await db
    .prepare(
      `SELECT stripe_event_id FROM stripe_webhook_events
       WHERE processed = 1 AND event_type = 'checkout.session.completed'
         AND received_at >= datetime('now', '-30 days')
       LIMIT 10`,
    )
    .all<{ stripe_event_id: string }>();
  if ((missingCredits.results ?? []).length > 0) {
    anomalies.push(
      `${missingCredits.results?.length ?? 0} recent processed checkout webhook(s) flagged for manual wallet cross-check`,
    );
  }

  return {
    checkedAt: nowIso(),
    openExceptions: after,
    healedLinks: result.healedLinks,
    createdExceptions: result.exceptionsCreated,
    anomalies,
  };
}
