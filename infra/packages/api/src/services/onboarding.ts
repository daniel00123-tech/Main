import type {
  Company,
  CompanyOnboarding,
  ConnectorInstance,
  McpEnvironment,
  OnboardingItem,
} from "@infra/shared";
import type { LedgerEntry } from "./ledger";
import { classifyLedgerCredit } from "./wallet-credits";
import { deriveMcpOnboardingStatus } from "./mcp-capabilities";

export function deriveConnectorLifecycle(instance: ConnectorInstance): string {
  if (instance.status === "disabled") return "disconnected";
  if (instance.status === "draft") return "not_configured";
  if (instance.status === "error") return "error";
  if (instance.status === "degraded") return "degraded";
  if (instance.status === "healthy") return "connected";
  if (instance.status === "syncing" || instance.status === "configured") {
    return "configuring";
  }
  if (instance.healthStatus === "unhealthy") return "error";
  if (instance.healthStatus === "degraded") return "degraded";
  return "not_configured";
}

export function buildCompanyOnboarding(input: {
  company: Company;
  mcp: McpEnvironment | null;
  connectors: ConnectorInstance[];
  wallet: { balanceCents: number; lowBalance: boolean };
  ledger: LedgerEntry[];
  adminCount: number;
  activeTokenCount: number;
  usageCount: number;
}): CompanyOnboarding {
  const { company, mcp, connectors, wallet, ledger } = input;
  const credits = classifyLedgerCredit(ledger);
  const knowledgeConfigured =
    (mcp?.knowledgeDocumentCount ?? 0) > 0 ||
    (mcp?.capabilities ?? []).includes("search_company_knowledge");
  const warehouseConfigured = (mcp?.capabilities ?? []).some((name) =>
    /warehouse|database_summary|query_business|entity/i.test(name),
  );
  const businessSystemsConfigured = connectors.some(
    (item) =>
      item.status !== "draft" &&
      item.status !== "disabled" &&
      deriveConnectorLifecycle(item) !== "not_configured",
  );

  const items: OnboardingItem[] = [
    {
      id: "company_created",
      title: "Company created",
      status: "complete",
      detail: `${company.name} · ${company.slug}`,
    },
    {
      id: "company_admin",
      title: "Company administrator",
      status: input.adminCount > 0 ? "complete" : "pending",
      detail:
        input.adminCount > 0
          ? `${input.adminCount} company admin${input.adminCount === 1 ? "" : "s"} assigned`
          : "Invite a company administrator to manage this tenant",
      href: `/portal/${company.slug}/team`,
    },
    {
      id: "business_mcp",
      title: "Business MCP",
      status: mcp ? "complete" : "not_provisioned",
      detail: mcp
        ? `${mcp.name} is registered. Creating a company does not provision a Worker.`
        : "Not provisioned. Register an existing company MCP when it exists.",
      href: `/companies/${company.slug}`,
    },
    {
      id: "mcp_auth",
      title: "MCP authentication",
      status: !mcp || !mcp.authSecretRef ? "not_configured" : "complete",
      detail: mcp?.authSecretRef
        ? `Secret reference ${mcp.authSecretRef} (value never stored in D1)`
        : "No downstream secret reference registered",
    },
    {
      id: "knowledge",
      title: "Knowledge source",
      status: knowledgeConfigured ? "complete" : "not_configured",
      detail: knowledgeConfigured
        ? `${mcp?.knowledgeDocumentCount ?? 0} documents reported by the company MCP`
        : "Knowledge is owned by the company MCP and is not configured yet",
    },
    {
      id: "business_systems",
      title: "Business systems",
      status: businessSystemsConfigured ? "complete" : "not_configured",
      detail: businessSystemsConfigured
        ? `${connectors.filter((c) => c.status !== "draft" && c.status !== "disabled").length} system(s) registered`
        : warehouseConfigured
          ? "Structured data capability reported; no live connector configured"
          : "No business-system connector configured",
      href: `/portal/${company.slug}/connectors`,
    },
    {
      id: "ai_connection",
      title: "AI connection",
      status: input.activeTokenCount > 0 ? "complete" : "not_configured",
      detail:
        input.activeTokenCount > 0
          ? `${input.activeTokenCount} active service identity token(s)`
          : "No AI client token has been issued",
      href: `/portal/${company.slug}/ai-connections`,
    },
    {
      id: "billing",
      title: "Billing",
      status: "test_mode",
      detail:
        credits.testCents > 0
          ? `TEST credit ${credits.testCents}p · paid credit ${credits.paidCents}p`
          : `Wallet ${wallet.balanceCents}p · TEST mode`,
      href: `/portal/${company.slug}/billing`,
    },
    {
      id: "ready",
      title: "Ready for use",
      status:
        Boolean(mcp) &&
        knowledgeConfigured &&
        input.activeTokenCount > 0 &&
        company.status === "active"
          ? "complete"
          : "no",
      detail:
        mcp && input.activeTokenCount > 0
          ? input.usageCount > 0
            ? "Company MCP registered and an AI connection exists"
            : "Foundation is in place; no billed usage yet"
          : "Not ready — Business MCP and an AI connection are still required",
    },
  ];

  const problems: CompanyOnboarding["problems"] = [];
  if (company.status === "suspended") {
    problems.push({
      id: "suspended",
      title: "Company is suspended",
      detail: "Paid AI operations are blocked until the company is reactivated.",
    });
  }
  if (mcp && ["degraded", "offline", "unreachable"].includes(mcp.status)) {
    problems.push({
      id: "mcp_unhealthy",
      title: "Business MCP needs attention",
      detail: mcp.healthMessage ?? mcp.lastError ?? mcp.status,
    });
  }
  if (wallet.lowBalance) {
    problems.push({
      id: "low_balance",
      title: "Wallet balance is low",
      detail: "Add TEST or paid credit before chargeable operations continue.",
      href: `/portal/${company.slug}/billing`,
    });
  }

  return {
    companyId: company.id,
    readyForUse: items.find((item) => item.id === "ready")?.status === "complete",
    items,
    problems,
  };
}

export function summariseMcpForDisplay(mcp: McpEnvironment | null): {
  status: string;
  label: string;
  detail: string;
} {
  if (!mcp) {
    return {
      status: "not_provisioned",
      label: "Not provisioned",
      detail: "No Business MCP is registered for this company.",
    };
  }
  return {
    status: deriveMcpOnboardingStatus(mcp),
    label: mcp.name,
    detail: mcp.healthMessage ?? mcp.status,
  };
}
