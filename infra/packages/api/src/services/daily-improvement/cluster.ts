import { newId } from "../../db/mappers";
import { NON_DEFECT_CATEGORIES, SEEDED_CLUSTERS, type DailyImprovementSeverity, type FailureCategory } from "./constants";
import { clusterStubFromBreach, metricBreaches, type MetricSnapshot } from "./thresholds";
import type { DailyImprovementCluster, DailyImprovementEvaluation, DailyImprovementIssue, IssueLifecycle } from "./types";

export function clusterEvaluations(
  evaluations: DailyImprovementEvaluation[],
  runId: string,
): DailyImprovementCluster[] {
  const buckets = new Map<string, DailyImprovementEvaluation[]>();
  for (const evaluation of evaluations) {
    const categories = evaluation.failureCategories.filter((category) => !NON_DEFECT_CATEGORIES.has(category));
    const findingCategories = (evaluation.findings ?? [])
      .map((finding) => String(finding.category))
      .filter((category) => !NON_DEFECT_CATEGORIES.has(category));
    for (const category of unique([...categories, ...findingCategories])) {
      const list = buckets.get(category) ?? [];
      list.push(evaluation);
      buckets.set(category, list);
    }
  }
  const clusters: DailyImprovementCluster[] = [];
  for (const [category, items] of buckets) {
    const companyIds = [...new Set(items.map((item) => item.companyId))];
    const channels = [...new Set(items.map((item) => item.channel).filter((item): item is string => Boolean(item)))];
    const worst = worstSeverity(items.map((item) => item.severity));
    clusters.push({
      id: newId("dic"),
      runId,
      clusterKey: category,
      category,
      title: titleFor(category),
      severity: worst,
      interactionCount: new Set(items.map((item) => item.interactionId)).size,
      tenantCount: companyIds.length,
      companyIds,
      channels,
      exampleIds: items
        .map((item) => item.interactionId)
        .filter(Boolean)
        .slice(0, 5),
      currentBehaviour: `Observed ${items.length} scored turns with abstracted category ${category}.`,
      expectedBehaviour: expectedFor(category),
      rootCause: `Shared platform behaviour, not a single conversation. Tenants affected: ${companyIds.length}.`,
      proposedFix: proposedFor(category),
      risk: riskFor(worst),
      testsRequired: "Failing reproduction, permanent regression, tenant isolation, billing class, deploy guard.",
      expectedBenefit: "Remove the repeating defect for every current and future tenant.",
      status: "OPEN",
      lifecycle: "NEW",
    });
  }
  return clusters.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.interactionCount - a.interactionCount);
}

export function clustersFromMetrics(runId: string, metrics: MetricSnapshot): DailyImprovementCluster[] {
  return metricBreaches(metrics).map((breach) => ({
    id: newId("dic"),
    ...clusterStubFromBreach(runId, breach, {
      interactionCount: Math.max(metrics.customerFailures, metrics.hallucinations, metrics.evaluatedTurns ? 1 : 0),
      tenantCount: 1,
      companyIds: [],
      lifecycle: "NEW",
    }),
  }));
}

export function mergeClusters(runId: string, groups: DailyImprovementCluster[][]): DailyImprovementCluster[] {
  const byKey = new Map<string, DailyImprovementCluster>();
  for (const group of groups) {
    for (const cluster of group) {
      const existing = byKey.get(cluster.clusterKey);
      if (!existing) {
        byKey.set(cluster.clusterKey, { ...cluster, runId });
        continue;
      }
      existing.interactionCount = Math.max(existing.interactionCount, cluster.interactionCount);
      existing.tenantCount = Math.max(existing.tenantCount, cluster.tenantCount);
      existing.companyIds = unique([...existing.companyIds, ...cluster.companyIds]);
      existing.channels = unique([...(existing.channels ?? []), ...(cluster.channels ?? [])]);
      existing.exampleIds = unique([...(existing.exampleIds ?? []), ...(cluster.exampleIds ?? [])]).slice(0, 8);
      existing.severity = worstSeverity([existing.severity, cluster.severity]);
      existing.tenantCount = existing.companyIds.length || existing.tenantCount;
      if ((cluster.currentBehaviour?.length ?? 0) > (existing.currentBehaviour?.length ?? 0)) {
        existing.currentBehaviour = cluster.currentBehaviour;
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.interactionCount - a.interactionCount,
  );
}

export function applyLifecycle(
  clusters: DailyImprovementCluster[],
  input: { openKeys: Set<string>; deployedTodayKeys: Set<string>; previousKeys: Set<string> },
): DailyImprovementCluster[] {
  return clusters.map((cluster) => {
    let lifecycle: IssueLifecycle = "NEW";
    if (input.deployedTodayKeys.has(cluster.clusterKey)) lifecycle = "FIXED";
    else if (input.openKeys.has(cluster.clusterKey) || input.previousKeys.has(cluster.clusterKey)) lifecycle = "STILL_OPEN";
    return { ...cluster, lifecycle };
  });
}

export function seedKnownClusters(
  runId: string,
  existing: DailyImprovementCluster[],
  options?: { onlyIfPresent?: boolean },
): DailyImprovementCluster[] {
  if (options?.onlyIfPresent !== false) {
    return existing;
  }
  const keys = new Set(existing.map((item) => item.clusterKey));
  const extra: DailyImprovementCluster[] = [];
  for (const seed of SEEDED_CLUSTERS) {
    if (keys.has(seed.clusterKey)) continue;
    extra.push({
      id: newId("dic"),
      runId,
      clusterKey: seed.clusterKey,
      category: seed.category,
      title: seed.title,
      severity: seed.severity,
      interactionCount: 0,
      tenantCount: 1,
      companyIds: ["co_el"],
      currentBehaviour: seed.currentBehaviour,
      expectedBehaviour: seed.expectedBehaviour,
      rootCause: seed.rootCause,
      proposedFix: seed.proposedFix,
      risk: seed.risk,
      testsRequired: seed.testsRequired,
      expectedBenefit: seed.expectedBenefit,
      status: "OPEN",
      lifecycle: "STILL_OPEN",
    });
  }
  return [...existing, ...extra];
}

export function issuesFromClusters(clusters: DailyImprovementCluster[], runId: string): DailyImprovementIssue[] {
  return clusters.map((cluster) => ({
    id: newId("diiu"),
    clusterId: cluster.id,
    runId,
    title: cluster.title,
    category: String(cluster.category),
    severity: cluster.severity,
    status: "QUEUED FOR AUTOMATIC ENGINEERING",
    priorityScore: priorityScore(cluster),
    affectedInteractions: cluster.interactionCount,
    affectedTenants: cluster.tenantCount,
  }));
}

export function priorityScore(cluster: DailyImprovementCluster): number {
  return (
    (4 - severityRank(cluster.severity)) * 100 +
    cluster.interactionCount * 4 +
    cluster.tenantCount * 10 +
    (cluster.companyIds.includes("co_el") ? 5 : 0)
  );
}

function titleFor(category: string): string {
  return category.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function expectedFor(category: string): string {
  switch (category) {
    case "MIXED_MULTI_TOOL":
      return "All requested live capability families execute on the first plan.";
    case "XERO_EXACT_TOOL_SELECTION":
    case "EXACT_TOOL_DEGRADATION":
      return "Xero asks map to the exact INFRA accounting family.";
    case "EMAIL_TO_XERO":
      return "Mailbox asks stay on Outlook.";
    case "LIST_VS_SEARCH":
      return "Search language uses search; list language uses list.";
    case "HALLUCINATION":
      return "Business figures, documents, and emails are grounded in retrieved evidence only.";
    case "FIRST_ANSWER_INCOMPLETE":
      return "The first authorised answer covers the whole ask.";
    default:
      return "Correct capability, grounded answer, no tenant leak, no user repeat.";
  }
}

function proposedFor(category: string): string {
  if (category === "MANUAL_INFRASTRUCTURE_ACTION") return "Do not auto-fix. Create a manual infrastructure ticket.";
  if (category === "HALLUCINATION") {
    return "Investigate each customer hallucination. Add a grounding guard. No invented figures.";
  }
  return "Generic platform routing or guard fix with a permanent regression test. No phrase patches.";
}

function riskFor(severity: DailyImprovementSeverity): string {
  if (severity === "CRITICAL") return "HIGH — contain first if security-related.";
  if (severity === "HIGH") return "MEDIUM — full regression required before deploy.";
  return "LOW — still requires reproduction and a regression test.";
}

function worstSeverity(values: Array<DailyImprovementSeverity | null>): DailyImprovementSeverity {
  if (values.includes("CRITICAL")) return "CRITICAL";
  if (values.includes("HIGH")) return "HIGH";
  if (values.includes("MEDIUM")) return "MEDIUM";
  return "LOW";
}

function severityRank(severity: DailyImprovementSeverity): number {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[severity];
}

export function countBySeverity(clusters: DailyImprovementCluster[]): Record<DailyImprovementSeverity, number> {
  return {
    CRITICAL: clusters.filter((item) => item.severity === "CRITICAL").length,
    HIGH: clusters.filter((item) => item.severity === "HIGH").length,
    MEDIUM: clusters.filter((item) => item.severity === "MEDIUM").length,
    LOW: clusters.filter((item) => item.severity === "LOW").length,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
