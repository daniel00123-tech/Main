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

const PROFILE_INCOMPLETE_STATUSES = new Set(["draft", "provisioning"]);
const CONNECTED_CUSTOMER_HEALTH = new Set(["Healthy", "Attention needed"]);

function readDismissedAt(overview: CompanyOverview): string | null {
  if (typeof overview.gettingStartedDismissedAt === "string" && overview.gettingStartedDismissedAt) {
    return overview.gettingStartedDismissedAt;
  }
  const fromConfig = overview.company?.config?.gettingStartedDismissedAt;
  return typeof fromConfig === "string" && fromConfig ? fromConfig : null;
}

/** Name present and the company is past draft/provisioning. Emails are not required. */
export function isCompanyProfileComplete(company: CompanyOverview["company"]): boolean {
  if (!company?.name?.trim()) return false;
  return !PROFILE_INCOMPLETE_STATUSES.has(company.status);
}

/** A connector the customer should treat as connected (not a draft placeholder). */
export function isCustomerConnectedConnector(
  connector: CompanyOverview["connectorInstances"][number],
): boolean {
  if (connector.status === "draft") return false;
  return CONNECTED_CUSTOMER_HEALTH.has(deriveConnectorCustomerHealth(connector).label);
}

/** At least one non-draft customer connector is Healthy or Attention needed (connected). */
export function hasConnectedCustomerSystem(
  connectors: CompanyOverview["connectorInstances"],
): boolean {
  return connectors.some(isCustomerConnectedConnector);
}

export function deriveGettingStartedItems(input: {
  overview: CompanyOverview;
}): GettingStartedItem[] {
  const { overview } = input;
  const company = overview.company;
  const profileComplete = isCompanyProfileComplete(company);
  const paymentComplete = overview.paymentMethodReady === true;
  const walletComplete = overview.walletSettingsConfigured === true;
  const hasConnectedSystem = hasConnectedCustomerSystem(overview.connectorInstances);
  const hasAi = overview.aiClientConfigured === true;
  const hasTeam =
    (overview.teamCount ?? 0) > 1 || (overview.pendingInvitationCount ?? 0) > 0;
  const hasUsage = (overview.successfulRequestCount ?? 0) > 0;

  return [
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
      complete: paymentComplete,
    },
    {
      key: "wallet",
      label: "Configure wallet settings",
      path: "billing?tab=auto-topup",
      complete: walletComplete,
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
}

export function gettingStartedProgress(items: GettingStartedItem[]): {
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
} {
  const completedCount = items.filter((item) => item.complete).length;
  return {
    completedCount,
    totalCount: items.length,
    allComplete: items.length > 0 && completedCount === items.length,
  };
}

/**
 * Company-scoped: a company_admin or director dismissal hides Getting Started
 * for every user of that company. It does not affect other companies.
 * Once set, the card stays dismissed (mandatory work uses Attention, not this list).
 */
export function isGettingStartedDismissed(overview: CompanyOverview): boolean {
  return readDismissedAt(overview) != null;
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
