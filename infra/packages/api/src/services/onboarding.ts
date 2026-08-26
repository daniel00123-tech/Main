import type {
  Company,
  CompanyOnboarding,
  CompanyReadiness,
  ConnectorInstance,
  McpEnvironment,
  OnboardingItem,
} from "@infra/shared";
import { mcpHasKnowledgeTools } from "@infra/shared";
import type { LedgerEntry } from "./ledger";
import { classifyLedgerCredit } from "./wallet-credits";
import { deriveMcpOnboardingStatus } from "./mcp-capabilities";
import { deriveConnectorPresentation, deriveAuthStatus } from "./connector-lifecycle";

export function deriveConnectorLifecycle(instance: ConnectorInstance): string {
  return deriveConnectorPresentation(instance).label === "Not configured"
    ? "not_configured"
    : deriveConnectorPresentation(instance).authStatus === "connected"
      ? "connected"
      : instance.status === "disabled"
        ? "disconnected"
        : instance.status === "error"
          ? "error"
          : instance.status === "degraded"
            ? "degraded"
            : instance.status === "syncing" || instance.status === "configured"
              ? "configuring"
              : instance.healthStatus === "unhealthy"
                ? "error"
                : instance.healthStatus === "degraded"
                  ? "degraded"
                  : "not_configured";
}

function readinessConfig(company: Company): {
  requiresKnowledge: boolean;
  requiresStructuredData: boolean;
  requiresAiConnection: boolean;
  requiredConnectors: string[];
} {
  const config = company.config ?? {};
  const readiness =
    config.readiness && typeof config.readiness === "object"
      ? (config.readiness as Record<string, unknown>)
      : {};
  const required = Array.isArray(readiness.required)
    ? readiness.required.map(String)
    : Array.isArray(config.requiredCapabilities)
      ? (config.requiredCapabilities as unknown[]).map(String)
      : [];
  return {
    requiresKnowledge:
      readiness.requiresKnowledge === true ||
      config.requiresKnowledge === true ||
      required.includes("knowledge"),
    requiresStructuredData:
      readiness.requiresStructuredData === true ||
      config.requiresStructuredData === true ||
      required.includes("structured_data"),
    requiresAiConnection:
      readiness.requiresAiConnection === true ||
      config.requiresAiConnection === true ||
      required.includes("ai_connection"),
    requiredConnectors: Array.isArray(readiness.requiredConnectors)
      ? readiness.requiredConnectors.map(String)
      : Array.isArray(config.requiredConnectors)
        ? (config.requiredConnectors as unknown[]).map(String)
        : [],
  };
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
  return buildCompanyReadiness(input);
}

export function buildCompanyReadiness(input: {
  company: Company;
  mcp: McpEnvironment | null;
  connectors: ConnectorInstance[];
  wallet: { balanceCents: number; lowBalance: boolean };
  ledger: LedgerEntry[];
  adminCount: number;
  activeTokenCount: number;
  usageCount: number;
}): CompanyReadiness {
  const { company, mcp, connectors, wallet, ledger } = input;
  const credits = classifyLedgerCredit(ledger);
  const policy = readinessConfig(company);
  const tools = mcp?.capabilities ?? [];
  const knowledgeReported =
    (mcp?.knowledgeDocumentCount ?? 0) > 0 || mcpHasKnowledgeTools(tools);
  const warehouseConfigured = tools.some((name) =>
    /warehouse|database_summary|query_business|entity/i.test(name),
  );
  const businessSystemsConfigured = connectors.some(
    (item) =>
      item.status !== "draft" &&
      item.status !== "disabled" &&
      deriveConnectorLifecycle(item) !== "not_configured",
  );

  const knowledgeApplicable = policy.requiresKnowledge || mcpHasKnowledgeTools(tools);
  const structuredApplicable = policy.requiresStructuredData || warehouseConfigured;
  const knowledgeRequired = policy.requiresKnowledge;
  const structuredRequired = policy.requiresStructuredData;
  const aiRequired = policy.requiresAiConnection;

  const items: OnboardingItem[] = [
    {
      id: "company_created",
      title: "Company created",
      status: "complete",
      required: true,
      applicability: "required",
      detail: `${company.name} · ${company.slug}`,
    },
    {
      id: "company_admin",
      title: "Company administrator",
      status: input.adminCount > 0 ? "complete" : "pending",
      required: true,
      applicability: "required",
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
      required: true,
      applicability: "required",
      detail: mcp
        ? `${mcp.name} is registered. Creating a company does not provision a Worker.`
        : "Not provisioned. Register an existing company MCP when it exists.",
      href: `/companies/${company.slug}`,
    },
    {
      id: "credential_storage",
      title: "Credential storage",
      status: mcp?.authSecretRef ? "complete" : "not_configured",
      required: true,
      applicability: "required",
      detail: mcp?.authSecretRef
        ? "Downstream MCP auth uses Worker secret references — values never stored in D1"
        : "Register auth secret reference before production use",
    },
    {
      id: "permissions",
      title: "Permissions & team",
      status: input.adminCount > 0 ? "complete" : "pending",
      required: true,
      applicability: "required",
      detail:
        input.adminCount > 0
          ? `${input.adminCount} administrator(s); role presets govern future capability permissions`
          : "Assign at least one company administrator",
      href: `/portal/${company.slug}/team`,
    },
    {
      id: "knowledge",
      title: "Knowledge source",
      status: knowledgeReported ? "complete" : "not_configured",
      required: knowledgeRequired,
      applicability: knowledgeRequired
        ? "required"
        : knowledgeApplicable
          ? "optional"
          : "not_applicable",
      detail: knowledgeReported
        ? `${mcp?.knowledgeDocumentCount ?? 0} documents reported by the company MCP`
        : knowledgeApplicable
          ? "Knowledge tools exist; no corpus has been reported yet"
          : "Not required — this company MCP does not advertise knowledge tools",
    },
    {
      id: "structured_data",
      title: "Structured data",
      status: warehouseConfigured ? "complete" : "not_configured",
      required: structuredRequired,
      applicability: structuredRequired
        ? "required"
        : structuredApplicable
          ? "optional"
          : "not_applicable",
      detail: warehouseConfigured
        ? "Company MCP reports structured-data tools"
        : "Not required unless this company uses a business-data warehouse",
    },
    {
      id: "business_systems",
      title: "Business systems",
      status: businessSystemsConfigured ? "complete" : "not_configured",
      required: policy.requiredConnectors.length > 0,
      applicability:
        policy.requiredConnectors.length > 0 ? "required" : "optional",
      detail: businessSystemsConfigured
        ? `${connectors.filter((c) => c.status !== "draft" && c.status !== "disabled").length} system(s) registered`
        : warehouseConfigured
          ? "Structured data capability reported; no live connector configured"
          : "Optional — specific systems are not required unless configured",
      href: `/portal/${company.slug}/connectors`,
    },
    {
      id: "ai_connection",
      title: "AI connection",
      status: input.activeTokenCount > 0 ? "complete" : "not_configured",
      required: aiRequired,
      applicability: aiRequired ? "required" : "optional",
      detail:
        input.activeTokenCount > 0
          ? `${input.activeTokenCount} active service identity token(s)`
          : "Optional unless this company is configured to require an AI client",
      href: `/portal/${company.slug}/ai-connections`,
    },
    {
      id: "acceptance_test",
      title: "Acceptance test",
      status: input.usageCount > 0 ? "complete" : "not_configured",
      required: false,
      applicability: "optional",
      detail:
        input.usageCount > 0
          ? `${input.usageCount} usage record(s) — gateway path verified`
          : "Run a non-destructive health or knowledge query via AI connection when ready",
      href: `/portal/${company.slug}/usage`,
    },
    {
      id: "billing",
      title: "Billing",
      status: "test_mode",
      required: true,
      applicability: "required",
      detail:
        credits.testCents > 0
          ? `TEST credit ${credits.testCents}p · paid credit ${credits.paidCents}p`
          : `Wallet ${wallet.balanceCents}p · TEST mode`,
      href: `/portal/${company.slug}/billing`,
    },
  ];

  const blockedLifecycle = ["suspended", "archived", "closed"].includes(company.status);
  const requiredComplete = items
    .filter((item) => item.required && item.id !== "billing")
    .every((item) => item.status === "complete" || item.status === "test_mode");
  const readyForUse = requiredComplete && !blockedLifecycle && Boolean(mcp);

  items.push({
    id: "ready",
    title: "Ready for use",
    status: readyForUse ? "complete" : "no",
    required: true,
    applicability: "required",
    detail: readyForUse
      ? input.usageCount > 0
        ? "Required foundation is in place"
        : "Required foundation is in place; no billed usage yet"
      : blockedLifecycle
        ? `Company is ${company.status}`
        : "Required foundation is incomplete",
  });

  const problems: CompanyOnboarding["problems"] = [];
  if (company.status === "suspended") {
    problems.push({
      id: "suspended",
      title: "Company is suspended",
      detail: "Paid AI operations and connector writes are blocked until reactivation.",
    });
  }
  if (mcp && ["degraded", "unreachable"].includes(mcp.status)) {
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
  for (const connector of connectors) {
    if (deriveAuthStatus(connector) === "auth_expired") {
      problems.push({
        id: `oauth_expired_${connector.id}`,
        title: `${connector.name}: OAuth expired`,
        detail: "Re-authenticate in Connectors before business-system tools can run.",
        href: `/portal/${company.slug}/connectors`,
      });
    }
  }
  if (!mcp && company.status === "onboarding") {
    problems.push({
      id: "mcp_missing",
      title: "Business MCP not registered",
      detail: "This company cannot serve AI requests until a company MCP is attached.",
      href: `/companies/${company.slug}`,
    });
  }

  return {
    companyId: company.id,
    readyForUse,
    requiredComplete,
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
