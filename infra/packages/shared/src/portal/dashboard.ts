import type { CompanyOverview } from "../types";
import { deriveConnectorCustomerHealth } from "../connectors/customer-health";

export type DashboardAttentionItem = {
  id: string;
  title: string;
  description?: string;
  to?: string;
  priority: number;
};

const OPERATOR_ONLY_PROBLEM_IDS = new Set(["mcp_unhealthy", "mcp_missing"]);

/** Customer-actionable attention items for the portal dashboard. */
export function buildCustomerAttention(input: {
  companyStatus: string;
  basePath: string;
  pendingActions: number;
  walletHealth: "healthy" | "low" | "critical" | "empty";
  lowBalance: boolean;
  onboardingProblems?: Array<{ id: string; title: string; detail: string; href?: string | null }>;
}): DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = [];

  if (input.companyStatus === "suspended") {
    items.push({
      id: "suspended",
      title: "Company is suspended",
      description: "Paid AI operations and connector writes are blocked.",
      to: `${input.basePath}/settings`,
      priority: 100,
    });
  }

  if (input.pendingActions > 0) {
    items.push({
      id: "pending-actions",
      title: `${input.pendingActions} action${input.pendingActions === 1 ? "" : "s"} need attention`,
      to: `${input.basePath}/actions`,
      priority: 90,
    });
  }

  if (input.lowBalance || input.walletHealth === "critical" || input.walletHealth === "empty") {
    items.push({
      id: "low-balance",
      title:
        input.walletHealth === "empty"
          ? "No credit remaining"
          : input.walletHealth === "critical"
            ? "Very low credit"
            : "Low credit",
      description: "Add credit to avoid interrupted AI usage.",
      to: `${input.basePath}/billing`,
      priority: 80,
    });
  }

  for (const problem of input.onboardingProblems ?? []) {
    if (OPERATOR_ONLY_PROBLEM_IDS.has(problem.id)) continue;
    items.push({
      id: problem.id,
      title: problem.title,
      description: problem.detail,
      to: problem.href ?? undefined,
      priority: 70,
    });
  }

  return items.sort((a, b) => b.priority - a.priority);
}

export function primaryAttentionSummary(
  items: DashboardAttentionItem[],
): { message: string; to?: string; actionLabel?: string } | null {
  if (items.length === 0) return null;
  const top = items[0]!;
  return {
    message: top.title,
    to: top.to,
    actionLabel: top.id === "pending-actions" ? "Review actions" : top.to ? "View" : undefined,
  };
}

export type GettingStartedItem = {
  key: string;
  label: string;
  path: string;
  complete: boolean;
};

export function deriveGettingStartedItems(input: {
  overview: CompanyOverview;
}): GettingStartedItem[] {
  const { overview } = input;
  const company = overview.company;
  const connectors = overview.connectorInstances.filter((c) => c.status !== "draft");
  const hasConnectedSystem = connectors.some(
    (c) => deriveConnectorCustomerHealth(c).label !== "Disconnected",
  );
  const hasUsage = (overview.usageSummary?.requestsThisMonth ?? 0) > 0;
  const hasAi = (overview.activeAiIdentityCount ?? 0) > 0;
  const hasTeam = (overview.teamCount ?? 0) > 1;
  const hasPaidOrSavedBilling =
    (overview.walletCredits?.paidCents ?? 0) > 0 || Boolean(overview.wallet?.stripeCustomerId);
  const profileComplete = Boolean(company.name?.trim() && company.slug?.trim());

  const items: GettingStartedItem[] = [
    {
      key: "profile",
      label: "Complete company profile",
      path: "settings",
      complete: profileComplete,
    },
    {
      key: "payment",
      label: "Add payment method",
      path: "billing?tab=payment",
      complete: hasPaidOrSavedBilling,
    },
    {
      key: "connector",
      label: "Connect first system",
      path: "connectors",
      complete: hasConnectedSystem,
    },
    {
      key: "ai",
      label: "Connect ChatGPT or Claude",
      path: "ai-connections",
      complete: hasAi,
    },
    {
      key: "team",
      label: "Invite team members",
      path: "users",
      complete: hasTeam,
    },
    {
      key: "usage",
      label: "Run first successful request",
      path: "usage",
      complete: hasUsage,
    },
  ];

  return items.filter((item) => !item.complete);
}

export function customerOverallHealthy(input: {
  companyStatus: string;
  attentionItems: DashboardAttentionItem[];
  mcpOnboardingStatus?: string | null;
}): boolean {
  return (
    input.companyStatus === "active" &&
    input.attentionItems.length === 0 &&
    (input.mcpOnboardingStatus === "healthy" || input.mcpOnboardingStatus === "registered")
  );
}
