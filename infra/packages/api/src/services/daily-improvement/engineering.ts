import type { Env } from "../../env";
import { DAILY_IMPROVEMENT_CONTRACT, MAX_DEPLOYS_PER_CYCLE, MAX_ENGINEERING_JOBS_PER_CYCLE } from "./constants";
import {
  claimNextEngineeringJob,
  completeEngineeringJob,
  enqueueEngineeringJobs,
  insertHistory,
  listEngineeringJobs,
} from "./store";
import type { DailyImprovementCluster, DailyImprovementIssue, EngineeringJobSpec } from "./types";

export const CURSOR_RUNNER_BLOCKER = {
  canWorkerSpawnCursorCloudAgent: false,
  reason:
    "The production Worker has no supported API to launch a Cursor Cloud Agent. cursor-cloud MCP can list agents and fetch transcripts; it cannot create an engineering run from infra-api.",
  integration:
    "Pull-based: INFRA writes a job spec; an external Cursor/dev supervisor or CLI claims /api/internal/cursor-engineering/claim and reports /complete. Completion is never faked.",
} as const;

export function buildJobSpec(cluster: DailyImprovementCluster): EngineeringJobSpec {
  return {
    clusterKey: cluster.clusterKey,
    title: cluster.title,
    severity: cluster.severity,
    category: String(cluster.category),
    companyIds: cluster.companyIds,
    reproduceFirst: true,
    genericFixOnly: true,
    forbidden: {
      phrasePatches: true,
      rbacWeakening: true,
      secretRotation: true,
      destructiveMigrations: true,
      writePermissionExpansion: true,
      inferredPricingChange: true,
      providerPromotion: true,
      cursorInCustomerPath: true,
    },
    requiredGates: [
      "failing_test_or_reproducible_trace",
      "generic_root_cause_fix",
      "permanent_regression_test",
      "full_acceptance",
      "tenant_isolation",
      "billing_safety",
      "deploy_guard",
    ],
    testsRequired: cluster.testsRequired ?? "Reproduction + regression + isolation + billing + deploy guard.",
    currentBehaviour: cluster.currentBehaviour ?? "",
    expectedBehaviour: cluster.expectedBehaviour ?? "",
  };
}

export function selectJobsForCycle(
  issues: DailyImprovementIssue[],
  clusters: DailyImprovementCluster[],
  limit = MAX_ENGINEERING_JOBS_PER_CYCLE,
): Array<{ issue: DailyImprovementIssue; cluster: DailyImprovementCluster; spec: EngineeringJobSpec }> {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  return [...issues]
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, limit)
    .map((issue) => {
      const cluster = (issue.clusterId ? byId.get(issue.clusterId) : null) ?? clusters.find((item) => item.clusterKey === issue.category);
      if (!cluster) return null;
      return { issue, cluster, spec: buildJobSpec(cluster) };
    })
    .filter((item): item is { issue: DailyImprovementIssue; cluster: DailyImprovementCluster; spec: EngineeringJobSpec } => Boolean(item));
}

export async function startEngineeringCycle(
  env: Env,
  input: { runId: string; issues: DailyImprovementIssue[]; clusters: DailyImprovementCluster[] },
): Promise<{ queued: number; blocker: typeof CURSOR_RUNNER_BLOCKER; maxDeploys: number }> {
  const selected = selectJobsForCycle(input.issues, input.clusters);
  const queued = await enqueueEngineeringJobs(env.DB, input.runId, selected);
  await insertHistory(env.DB, {
    eventType: "engineering.cycle_started",
    detail: {
      runId: input.runId,
      queued,
      selected: selected.map((item) => item.cluster.clusterKey),
      cursorInCustomerPath: DAILY_IMPROVEMENT_CONTRACT.cursorInCustomerPath,
      requiresHumanApproval: DAILY_IMPROVEMENT_CONTRACT.requiresHumanApproval,
      runner: CURSOR_RUNNER_BLOCKER,
    },
  });
  return { queued, blocker: CURSOR_RUNNER_BLOCKER, maxDeploys: MAX_DEPLOYS_PER_CYCLE };
}

export async function claimEngineeringJob(env: Env, claimedBy: string) {
  const job = await claimNextEngineeringJob(env.DB, claimedBy);
  if (!job) return { claimed: false as const, job: null, contract: DAILY_IMPROVEMENT_CONTRACT, runner: CURSOR_RUNNER_BLOCKER };
  await insertHistory(env.DB, {
    eventType: "engineering.job_claimed",
    jobId: String(job.id),
    detail: { claimedBy, clusterKey: job.cluster_key },
  });
  return { claimed: true as const, job, contract: DAILY_IMPROVEMENT_CONTRACT, runner: CURSOR_RUNNER_BLOCKER };
}

export async function completeClaimedJob(
  env: Env,
  input: { jobId: string; status: string; result: Record<string, unknown> },
) {
  const allowed = new Set([
    "NOT_REPRODUCED",
    "REJECTED",
    "READY_TO_DEPLOY",
    "DEPLOYED",
    "ROLLED_BACK",
    "CARRIED",
    "TESTING",
  ]);
  if (!allowed.has(input.status)) {
    throw new Error("Invalid engineering completion status");
  }
  await completeEngineeringJob(env.DB, input.jobId, { status: input.status, result: input.result });
  await insertHistory(env.DB, {
    eventType: "engineering.job_completed",
    jobId: input.jobId,
    detail: { status: input.status, reproduced: input.result.reproduced ?? null },
  });
  return { ok: true, status: input.status };
}

export async function engineeringQueueSnapshot(env: Env) {
  return {
    contract: DAILY_IMPROVEMENT_CONTRACT,
    runner: CURSOR_RUNNER_BLOCKER,
    jobs: await listEngineeringJobs(env.DB, 50),
  };
}

export function cursorJobPrompt(spec: EngineeringJobSpec): string {
  return [
    "INFRA daily improvement job. Cursor stays off the customer path.",
    `Cluster: ${spec.clusterKey}`,
    `Severity: ${spec.severity}`,
    `Current: ${spec.currentBehaviour}`,
    `Expected: ${spec.expectedBehaviour}`,
    "Reproduce first with a failing test or a reproducible trace. If not reproduced, mark NOT_REPRODUCED and do not deploy.",
    "Generic architecture/root-cause fix only. No phrase patches. No RBAC weakening. No secret rotation. No destructive migrations.",
    "Do not expand write permissions. Do not change tenant pricing. Do not promote OpenAI shadow→canary→primary.",
    "Add a permanent regression test. Run tenant isolation and billing safety. Deploy only if the canonical deploy guard passes.",
    "If post-deploy verification fails, roll back automatically.",
  ].join("\n");
}
