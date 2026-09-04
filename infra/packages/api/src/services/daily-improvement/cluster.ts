import { newId } from "../../db/mappers";
import { SEEDED_CLUSTERS, type DailyImprovementSeverity, type FailureCategory } from "./constants";
import type { DailyImprovementCluster, DailyImprovementEvaluation, DailyImprovementIssue } from "./types";

export function clusterEvaluations(
  evaluations: DailyImprovementEvaluation[],
  runId: string,
): DailyImprovementCluster[] {
  const buckets = new Map<string, DailyImprovementEvaluation[]>();
  for (const evaluation of evaluations) {
    for (const category of evaluation.failureCategories) {
      const key = category;
      const list = buckets.get(key) ?? [];
      list.push(evaluation);
      buckets.set(key, list);
    }
  }
  const clusters: DailyImprovementCluster[] = [];
  for (const [category, items] of buckets) {
    const companyIds = [...new Set(items.map((item) => item.companyId))];
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
      currentBehaviour: `Observed ${items.length} scored turns with abstracted category ${category}.`,
      expectedBehaviour: expectedFor(category),
      rootCause: `Shared platform behaviour, not a single conversation. Tenants affected: ${companyIds.length}.`,
      proposedFix: proposedFor(category),
      risk: riskFor(worst),
      testsRequired: "Failing reproduction, permanent regression, tenant isolation, billing class, deploy guard.",
      expectedBenefit: "Remove the repeating defect for every current and future tenant.",
      status: "OPEN",
    });
  }
  return clusters.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.interactionCount - a.interactionCount);
}

export function seedKnownClusters(runId: string, existing: DailyImprovementCluster[]): DailyImprovementCluster[] {
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
      return "Xero asks map to the exact INFRA accounting family.";
    case "EMAIL_TO_XERO":
      return "Mailbox asks stay on Outlook.";
    case "LIST_VS_SEARCH":
      return "Search language uses search; list language uses list.";
    default:
      return "Correct capability, grounded answer, no tenant leak, no user repeat.";
  }
}

function proposedFor(category: string): string {
  if (category === "MANUAL_INFRASTRUCTURE_ACTION") return "Do not auto-fix. Create a manual infrastructure ticket.";
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
